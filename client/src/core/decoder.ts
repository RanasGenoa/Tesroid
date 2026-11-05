import { H264Parser } from './h264-parser.js';
import { VIDEO_FLAGS } from '../transport/protocol.js';
import type { TelemetryCollector } from './telemetry.js';

export type FrameOutputTarget =
  | { queueFrame: (frame: VideoFrame) => void; getQueueLength?: () => number }
  | { render: (frame: VideoFrame) => void }
  | ((frame: VideoFrame) => void);

export interface PendingVideoPacket {
  flags: number;
  pts: bigint;
  data: Uint8Array;
}

export class VideoStreamDecoder {
  private decoder: VideoDecoder | null = null;
  private onFrameOutput: (frame: VideoFrame) => void;
  private getDownstreamQueueLength?: () => number;
  private isConfigured = false;
  private configPromise: Promise<void> | null = null;
  private waitingForKeyframe = true;
  private pendingSps: Uint8Array | null = null;
  private pendingPps: Uint8Array | null = null;
  private activeSps: Uint8Array | null = null;
  private activePps: Uint8Array | null = null;

  // Pre-decode compressed packet buffer to prevent hardware VideoFrame pool exhaustion during burst arrivals
  private pendingPackets: PendingVideoPacket[] = [];
  private pendingBytes = 0;
  private isPumping = false;
  private maxActiveFrames = 14;
  private targetPendingDurationMs = 10000; // Target prefetch buffer depth
  private maxPendingPackets = 780; // Hard fallback limit (+35% + margin)
  private maxPendingDurationMs = 16000; // Hard trimming limit with safety margin (10s * 1.35 + 2.5s)
  private maxPendingBytes = 16 * 1024 * 1024; // Memory guard (16MB allows 10s of high-bitrate video)

  private onFrameDecoded?: (pts: number) => void;
  public onDecoderError?: () => void;
  private telemetry?: TelemetryCollector;

  public setTelemetryCollector(telemetry?: TelemetryCollector): void {
    this.telemetry = telemetry;
  }

  public getDecodeQueueSize(): number {
    return (this.decoder ? this.decoder.decodeQueueSize : 0) + this.pendingPackets.length;
  }

  public getPendingPacketsCount(): number {
    return this.pendingPackets.length;
  }

  public getPendingBytes(): number {
    return this.pendingBytes;
  }

  public getTargetPendingDurationMs(): number {
    return this.targetPendingDurationMs;
  }

  public getMaxPendingDurationMs(): number {
    return this.maxPendingDurationMs;
  }

  public getMaxPendingBytes(): number {
    return this.maxPendingBytes;
  }

  /**
   * Configure prefetch buffer depth (e.g. 2000ms for Intel MCU2, 10000ms for Ryzen MCU3)
   */
  public setBufferDepth(options: { targetDurationMs?: number; maxBytes?: number }): void {
    if (options.targetDurationMs !== undefined && options.targetDurationMs > 0) {
      this.targetPendingDurationMs = options.targetDurationMs;
      // Hard limit for trimming is target + 35% margin (at least +2.5s for GOP alignment)
      this.maxPendingDurationMs = Math.max(1500, Math.round(options.targetDurationMs * 1.35) + 2500);
      // Packet count limit based on max 45fps + margin
      this.maxPendingPackets = Math.max(90, Math.ceil((this.maxPendingDurationMs / 1000) * 45) + 60);
      // Dynamic memory guard: ~1.5MB per second of buffer depth (min 4MB, max 24MB)
      const dynamicBytes = Math.round((this.maxPendingDurationMs / 1000) * 1.5 * 1024 * 1024);
      this.maxPendingBytes = Math.max(4 * 1024 * 1024, Math.min(24 * 1024 * 1024, dynamicBytes));
    }
    if (options.maxBytes !== undefined && options.maxBytes > 0) {
      this.maxPendingBytes = options.maxBytes;
    }
    this.trimPendingPackets();
  }

  public getPendingBufferedMs(): number {
    if (this.pendingPackets.length <= 1) return 0;
    const first = this.pendingPackets[0].pts;
    const last = this.pendingPackets[this.pendingPackets.length - 1].pts;
    if (last <= first) return this.pendingPackets.length * 33;
    return Math.max(0, Math.round(Number(last - first) / 1000));
  }

  public clearPendingPackets(): void {
    this.pendingPackets = [];
    this.pendingBytes = 0;
    this.waitingForKeyframe = true;
  }

  public setDownstreamQueueLengthProvider(provider: () => number): void {
    this.getDownstreamQueueLength = provider;
  }

  constructor(
    target: FrameOutputTarget,
    onFrameDecoded?: (pts: number) => void
  ) {
    if (typeof target === 'function') {
      this.onFrameOutput = target;
    } else if ('queueFrame' in target) {
      this.onFrameOutput = (f: VideoFrame) => target.queueFrame(f);
      if (typeof target.getQueueLength === 'function') {
        this.getDownstreamQueueLength = () => target.getQueueLength!();
      }
    } else {
      this.onFrameOutput = (f: VideoFrame) => target.render(f);
    }
    this.onFrameDecoded = onFrameDecoded;
    this.initDecoder();
  }

  private areBuffersEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private hasCapacityForDecode(): boolean {
    const hwQueue = this.decoder ? this.decoder.decodeQueueSize : 0;
    const downstreamQueue = this.getDownstreamQueueLength ? this.getDownstreamQueueLength() : 0;
    return hwQueue + downstreamQueue < this.maxActiveFrames;
  }

  public async handlePacket(flags: number, pts: bigint, data: Uint8Array): Promise<void> {
    // If there are already packets waiting in the pre-decode queue, or downstream is full,
    // enqueue to preserve strict packet ordering without dropping P-frames!
    if (this.pendingPackets.length > 0 || !this.hasCapacityForDecode()) {
      this.enqueuePendingPacket({ flags, pts, data: new Uint8Array(data) });
      await this.pumpPendingPackets();
      return;
    }

    await this.processSinglePacket(flags, pts, data);
  }

  private enqueuePendingPacket(pkt: PendingVideoPacket): void {
    this.pendingPackets.push(pkt);
    this.pendingBytes += pkt.data.length;
    this.trimPendingPackets();
  }

  /**
   * Trim oldest frames up to the next available KEYFRAME if buffer exceeds duration or byte limits
   */
  private trimPendingPackets(): void {
    while (this.pendingPackets.length > 1) {
      const first = this.pendingPackets[0];
      const last = this.pendingPackets[this.pendingPackets.length - 1];
      const durationMs = last.pts > first.pts ? Number(last.pts - first.pts) / 1000 : 0;
      const countExceeded = this.pendingPackets.length > this.maxPendingPackets;
      const durationExceeded = durationMs > this.maxPendingDurationMs;
      const bytesExceeded = this.pendingBytes > this.maxPendingBytes;

      if (!countExceeded && !durationExceeded && !bytesExceeded) {
        break;
      }

      // Find the next KEYFRAME after head to preserve GOP decoding integrity
      let nextKf = -1;
      for (let i = 1; i < this.pendingPackets.length; i++) {
        if ((this.pendingPackets[i].flags & VIDEO_FLAGS.KEYFRAME) !== 0) {
          nextKf = i;
          break;
        }
      }

      if (nextKf > 0) {
        if (this.telemetry?.isEnabled()) {
          this.telemetry.recordDecoder('trim_gop', {
            droppedCount: nextKf,
            remainingCount: this.pendingPackets.length - nextKf,
            durationMs: Math.round(durationMs),
            pendingBytes: this.pendingBytes,
          });
        }
        // Drop frames from 0 to nextKf - 1
        for (let i = 0; i < nextKf; i++) {
          this.pendingBytes = Math.max(0, this.pendingBytes - this.pendingPackets[i].data.length);
        }
        this.pendingPackets.splice(0, nextKf);
      } else {
        // No keyframe found ahead, but limit is exceeded: drop head and await next keyframe
        const removed = this.pendingPackets.shift()!;
        this.pendingBytes = Math.max(0, this.pendingBytes - removed.data.length);
        if (this.telemetry?.isEnabled()) {
          this.telemetry.recordDecoder('trim_head_await_keyframe', {
            remainingCount: this.pendingPackets.length,
            pendingBytes: this.pendingBytes,
          });
        }
        this.waitingForKeyframe = true;
        break;
      }
    }
  }

  public async pumpPendingPackets(): Promise<void> {
    if (this.isPumping || this.pendingPackets.length === 0) return;
    this.isPumping = true;
    try {
      while (this.pendingPackets.length > 0 && this.hasCapacityForDecode()) {
        const next = this.pendingPackets.shift()!;
        this.pendingBytes = Math.max(0, this.pendingBytes - next.data.length);
        await this.processSinglePacket(next.flags, next.pts, next.data);
      }
    } finally {
      this.isPumping = false;
    }
  }

  private async processSinglePacket(flags: number, pts: bigint, data: Uint8Array): Promise<void> {
    const isConfig = (flags & VIDEO_FLAGS.CONFIG) !== 0;
    const isKeyframe = (flags & VIDEO_FLAGS.KEYFRAME) !== 0;

    // 1. If config packet or not yet configured, extract SPS/PPS
    if (isConfig || !this.isConfigured) {
      const nalUnits = H264Parser.extractNalUnits(data);
      for (const n of nalUnits) {
        if (n.type === 7) this.pendingSps = n.data;
        if (n.type === 8) this.pendingPps = n.data;
      }

      if (this.pendingSps && this.pendingPps) {
        const needsConfig =
          !this.isConfigured ||
          !this.areBuffersEqual(this.activeSps, this.pendingSps) ||
          !this.areBuffersEqual(this.activePps, this.pendingPps);

        if (needsConfig) {
          this.configPromise = this.configureDecoder(this.pendingSps, this.pendingPps);
        }
      }

      // If this packet contains ONLY parameter sets (no slices), DO NOT feed to decoder
      const hasSlices = nalUnits.some((n) => n.type === 1 || n.type === 5);
      if (!hasSlices) {
        return;
      }
    }

    if (this.configPromise) {
      await this.configPromise;
      this.configPromise = null;
    }

    if (!this.isConfigured || !this.decoder) {
      // Waiting for initial SPS/PPS
      return;
    }

    // Drop delta frames until a valid KEYFRAME packet arrives (after init, reset, or reconnect)
    if (this.waitingForKeyframe) {
      if (!isKeyframe) {
        return;
      }
      this.waitingForKeyframe = false;
    }

    // Convert Annex-B chunk to AVCC format required by WebCodecs with description
    const avccData = H264Parser.annexBToAvcc(data);
    if (avccData.length === 0) {
      return;
    }

    try {
      const chunk = new EncodedVideoChunk({
        type: isKeyframe ? 'key' : 'delta',
        timestamp: Number(pts), // microseconds
        data: avccData,
      });

      this.decoder.decode(chunk);
    } catch (err) {
      console.warn('[VideoStreamDecoder] Error decoding chunk:', err);
    }
  }

  /**
   * Discard older buffered packets when jumping to LIVE.
   * If a recent KEYFRAME exists in pendingPackets, skip directly to it; otherwise clear pending and wait for next KEYFRAME.
   */
  public flushPendingForLiveJump(): void {
    if (this.pendingPackets.length === 0) return;

    let latestKeyframeIdx = -1;
    for (let i = this.pendingPackets.length - 1; i >= 0; i--) {
      if ((this.pendingPackets[i].flags & VIDEO_FLAGS.KEYFRAME) !== 0) {
        latestKeyframeIdx = i;
        break;
      }
    }

    if (latestKeyframeIdx >= 0) {
      this.pendingPackets = this.pendingPackets.slice(latestKeyframeIdx);
      this.pendingBytes = this.pendingPackets.reduce((acc, p) => acc + p.data.length, 0);
    } else {
      this.pendingPackets = [];
      this.pendingBytes = 0;
      this.waitingForKeyframe = true;
    }
  }

  public reset(): void {
    this.isConfigured = false;
    this.configPromise = null;
    this.waitingForKeyframe = true;
    this.pendingSps = null;
    this.pendingPps = null;
    this.activeSps = null;
    this.activePps = null;
    this.pendingPackets = [];
    this.pendingBytes = 0;
    this.isPumping = false;
    if (this.decoder) {
      try {
        if (this.decoder.state !== 'closed') {
          this.decoder.reset();
        }
      } catch (e) {
        console.warn('[VideoStreamDecoder] Reset error:', e);
      }
    }
  }

  public close(): void {
    this.pendingPackets = [];
    this.pendingBytes = 0;
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {}
      this.decoder = null;
    }
  }

  private showWebCodecsError(): void {
    if (document.getElementById('webcodecs-error-overlay')) return;
    const isSecure = Boolean((window as any).isSecureContext);

    const overlay = document.createElement('div');
    overlay.id = 'webcodecs-error-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.88); z-index: 999999;
      display: flex; align-items: center; justify-content: center;
      padding: 20px; box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
    `;

    overlay.innerHTML = `
      <div style="background: #1e1e24; border: 1px solid #ff3b30; border-radius: 12px; max-width: 620px; width: 100%; padding: 24px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);">
        <h2 style="margin: 0 0 12px; font-size: 18px; color: #ff3b30; display: flex; align-items: center; gap: 8px;">
          WebCodecs (VideoDecoder) が利用できません
        </h2>

        <p style="font-size: 14px; line-height: 1.6; color: #ccc; margin: 0 0 16px;">
          ${!isSecure ? `
            <strong>【原因】非セキュア環境（非暗号化HTTP）によるChromeの制約</strong><br>
            ブラウザのセキュリティ仕様により、WebCodecs APIは <strong>セキュアコンテキスト（HTTPS または localhost）</strong> でのみ動作が許可されています。<br>
            現在 <code>${window.location.origin}</code> のLAN内IP経由でアクセスしているため、ブラウザ側で機能が無効化されています。
          ` : `
            お使いのブラウザは WebCodecs VideoDecoder API に対応していません。Chrome 94以降、またはテスラ車載ブラウザ（Chromiumベース）をご利用ください。
          `}
        </p>

        ${!isSecure ? `
          <div style="background: #121216; border-radius: 8px; padding: 14px; font-size: 13px; line-height: 1.6; margin-bottom: 16px;">
            <strong style="color: #00ff88;">PCブラウザからテスト・操作する方法:</strong>
            <ol style="margin: 8px 0 0 18px; padding: 0; color: #bbb;">
              <li style="margin-bottom: 8px;">
                <strong>ローカルプロキシ経由でアクセス（推奨）:</strong><br>
                手元のPCで <code>TARGET_HOST=&lt;サーバーIP&gt; npm run proxy</code> を実行し、<a href="http://localhost:9001" style="color: #00ff88; text-decoration: underline;">http://localhost:9001</a> で開く（<code>localhost</code> はChromeにより自動的にセキュア環境と認識されます）。
              </li>
              <li style="margin-bottom: 8px;">
                <strong>Chromeフラグで一時許可:</strong><br>
                <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code> を開き、<code>${window.location.origin}</code> を追加して「Enabled」に設定後、Chromeを再起動。
              </li>
              <li>
                <strong>本番用リバースプロキシ（テスラ車載ブラウザ接続）:</strong><br>
                独自ドメインと公的SSL証明書（HTTPS）を設定したリバースプロキシ経由でアクセス（テスラ車載時はHTTPSとなるためこのエラーは発生しません）。
              </li>
            </ol>
          </div>
        ` : ''}

        <div style="text-align: right;">
          <button id="webcodecs-close-btn" style="background: #333; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer;">閉じる</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById('webcodecs-close-btn')?.addEventListener('click', () => {
      overlay.remove();
    });
  }

  private initDecoder(): void {
    const hasVideoDecoder = typeof globalThis !== 'undefined' && typeof (globalThis as any).VideoDecoder !== 'undefined';
    if (!hasVideoDecoder) {
      console.warn('[VideoStreamDecoder] VideoDecoder not supported in current context. isSecureContext:', typeof window !== 'undefined' ? (window as any).isSecureContext : false);
      if (typeof window !== 'undefined') {
        this.showWebCodecsError();
      }
      return;
    }

    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        const pts = frame.timestamp;
        this.onFrameOutput(frame);
        if (this.onFrameDecoded) {
          this.onFrameDecoded(pts);
        }
      },
      error: (e: DOMException) => {
        console.error('[VideoStreamDecoder] WebCodecs error:', e);
        if (this.telemetry?.isEnabled()) {
          this.telemetry.recordDecoder('decoder_error', {
            name: e?.name,
            message: e?.message,
            pendingPacketsCount: this.pendingPackets.length,
            pendingBytes: this.pendingBytes,
          });
        }
        this.onDecoderError?.();
        this.isConfigured = false;
        this.waitingForKeyframe = true;
        if (this.decoder) {
          try { this.decoder.close(); } catch {}
          this.decoder = null;
        }
        // Auto-recover decoder
        setTimeout(() => {
          this.initDecoder();
          if (this.pendingSps && this.pendingPps) {
            this.configureDecoder(this.pendingSps, this.pendingPps);
          }
        }, 150);
      },
    });
  }

  private async configureDecoder(sps: Uint8Array, pps: Uint8Array): Promise<void> {
    if (!this.decoder) this.initDecoder();
    if (!this.decoder) return;

    try {
      const codec = H264Parser.getCodecString(sps);
      const description = H264Parser.buildAVCDecoderConfigurationRecord(sps, pps);

      console.log(`[VideoStreamDecoder] Configuring VideoDecoder: codec=${codec}, descriptionLen=${description.length}`);

      const candidateConfigs: VideoDecoderConfig[] = [
        { codec, description, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true },
        { codec, description, hardwareAcceleration: 'prefer-hardware' },
        { codec, description, optimizeForLatency: true },
        { codec, description },
      ];

      let chosenConfig: VideoDecoderConfig = candidateConfigs[candidateConfigs.length - 1];
      if (typeof (VideoDecoder as any).isConfigSupported === 'function') {
        for (const cfg of candidateConfigs) {
          try {
            const support = await (VideoDecoder as any).isConfigSupported(cfg);
            if (support && support.supported) {
              chosenConfig = cfg;
              break;
            }
          } catch {}
        }
      }

      this.decoder.configure(chosenConfig);
      this.activeSps = new Uint8Array(sps);
      this.activePps = new Uint8Array(pps);
      this.isConfigured = true;
      this.waitingForKeyframe = true;
      console.log('[VideoStreamDecoder] VideoDecoder configured successfully with config:', chosenConfig);
    } catch (err) {
      console.error('[VideoStreamDecoder] Failed to configure VideoDecoder:', err);
    }
  }
}
