import { AUDIO_FLAGS, VIDEO_FLAGS } from '../ws/protocol.js';

export interface BufferedFrame {
  type: 'video' | 'audio';
  flags: number;
  pts: bigint; // microseconds
  data: Buffer;
}

export interface PlaybackBufferOptions {
  bufferSeconds?: number;
  maxBytes?: number;
}

/**
 * プレイバックリングバッファ (PlaybackBuffer)
 *
 * 【メモリガード計算 (500kbps〜1000kbps 映像 + 128kbps 音声)】:
 * - 映像 1000kbps: 1,000,000 bits/s * 60s / 8 = 7,500,000 bytes (約7.15 MB)
 * - 映像 500kbps: 500,000 bits/s * 60s / 8 = 3,750,000 bytes (約3.58 MB)
 * - 音声 128kbps: 128,000 bits/s * 60s / 8 = 960,000 bytes (約0.92 MB)
 * -> 60秒間で合計約 4.5MB 〜 8.5MB。
 * -> メモリ上限ガード (maxBytes) は安全係数を含め 12MB (12 * 1024 * 1024 bytes) を既定値とする。
 * 保持時間上限 (bufferSeconds, 既定60秒) または maxBytes を超過した場合は、
 * GOP(2秒)境界を維持しながら最古のGOP単位でフレームを破棄する。
 */
export class PlaybackBuffer {
  private bufferSeconds: number;
  private maxBytes: number;

  private videoFrames: BufferedFrame[] = [];
  private audioFrames: BufferedFrame[] = [];
  private currentBytes = 0;

  private cachedSpsPps: Buffer | null = null;
  private cachedOpusHead: Buffer | null = null;

  constructor(options: PlaybackBufferOptions = {}) {
    const envSec = Number(process.env.PLAYBACK_BUFFER_SECONDS);
    this.bufferSeconds = options.bufferSeconds || (envSec > 0 ? envSec : 60);

    const envBytes = Number(process.env.PLAYBACK_BUFFER_MAX_BYTES);
    // 既定 12MB (12 * 1024 * 1024)
    this.maxBytes = options.maxBytes || (envBytes > 0 ? envBytes : 12 * 1024 * 1024);
  }

  public getBufferSeconds(): number {
    return this.bufferSeconds;
  }

  public getMaxBytes(): number {
    return this.maxBytes;
  }

  public getCurrentBytes(): number {
    return this.currentBytes;
  }

  public getVideoCount(): number {
    return this.videoFrames.length;
  }

  public getAudioCount(): number {
    return this.audioFrames.length;
  }

  public getCachedSpsPps(): Buffer | null {
    return this.cachedSpsPps;
  }

  public getCachedOpusHead(): Buffer | null {
    return this.cachedOpusHead;
  }

  public getBufferedDurationMs(): number {
    if (this.videoFrames.length <= 1) return 0;
    const first = this.videoFrames[0].pts;
    const last = this.videoFrames[this.videoFrames.length - 1].pts;
    if (last <= first) return 0;
    return Math.round(Number(last - first) / 1000);
  }

  /**
   * 映像 Access Unit (AU) をバッファへ追加
   */
  public addVideo(flags: number, pts: bigint, data: Buffer): void {
    if ((flags & VIDEO_FLAGS.CONFIG) !== 0) {
      this.cachedSpsPps = data;
    }

    const frame: BufferedFrame = {
      type: 'video',
      flags,
      pts,
      data,
    };

    this.videoFrames.push(frame);
    this.currentBytes += data.length;

    this.prune();
  }

  /**
   * 音声 Opus パケットをバッファへ追加
   */
  public addAudio(flags: number, pts: bigint, data: Buffer): void {
    if ((flags & AUDIO_FLAGS.CONFIG) !== 0) {
      this.cachedOpusHead = data;
    }

    const frame: BufferedFrame = {
      type: 'audio',
      flags,
      pts,
      data,
    };

    this.audioFrames.push(frame);
    this.currentBytes += data.length;

    this.prune();
  }

  /**
   * バッファを全消去 (ナビゲーション時、解像度変更時、リスタート時)
   */
  public clear(): void {
    this.videoFrames = [];
    this.audioFrames = [];
    this.currentBytes = 0;
    this.cachedSpsPps = null;
    this.cachedOpusHead = null;
  }

  /**
   * 保持時間またはメモリ上限を超過した最古フレームをGOP単位で破棄
   */
  private prune(): void {
    const maxDurationUs = BigInt(this.bufferSeconds) * 1_000_000n;

    while (this.videoFrames.length > 1) {
      const newestPts = this.videoFrames[this.videoFrames.length - 1].pts;
      const oldestPts = this.videoFrames[0].pts;
      const durationExceeded = newestPts - oldestPts > maxDurationUs;
      const bytesExceeded = this.currentBytes > this.maxBytes;

      if (!durationExceeded && !bytesExceeded) {
        break;
      }

      // 次の KEYFRAME を探索
      let nextKeyframeIdx = -1;
      for (let i = 1; i < this.videoFrames.length; i++) {
        if ((this.videoFrames[i].flags & VIDEO_FLAGS.KEYFRAME) !== 0) {
          nextKeyframeIdx = i;
          break;
        }
      }

      if (nextKeyframeIdx === -1) {
        // 次のキーフレームがない（単一GOPしかない）場合はこれ以上破棄できない
        break;
      }

      // 最初の GOP (0 から nextKeyframeIdx - 1 まで) を破棄
      for (let i = 0; i < nextKeyframeIdx; i++) {
        this.currentBytes -= this.videoFrames[i].data.length;
      }
      this.videoFrames = this.videoFrames.slice(nextKeyframeIdx);

      // 音声も新しい最古 video PTS より古いものを破棄
      const minVideoPts = this.videoFrames[0].pts;
      let audioDropCount = 0;
      while (
        audioDropCount < this.audioFrames.length &&
        this.audioFrames[audioDropCount].pts < minVideoPts
      ) {
        this.currentBytes -= this.audioFrames[audioDropCount].data.length;
        audioDropCount++;
      }
      if (audioDropCount > 0) {
        this.audioFrames = this.audioFrames.slice(audioDropCount);
      }
    }
  }

  /**
   * lastAckPts 直前の KEYFRAME から開始する一連のフレーム（映像・音声をPTS順に統合）を取得
   */
  public getFramesToCatchup(lastAckPts: bigint): {
    frames: BufferedFrame[];
    configVideo?: Buffer;
    configAudio?: Buffer;
  } | null {
    if (this.videoFrames.length === 0) {
      return null;
    }

    // lastAckPts 直前（pts <= lastAckPts）の最新の KEYFRAME を探す
    let targetKeyframeIdx = -1;
    for (let i = this.videoFrames.length - 1; i >= 0; i--) {
      const f = this.videoFrames[i];
      if (f.pts <= lastAckPts && (f.flags & VIDEO_FLAGS.KEYFRAME) !== 0) {
        targetKeyframeIdx = i;
        break;
      }
    }

    // もし lastAckPts 以下のキーフレームが見つからない場合:
    // lastAckPts がバッファ最古よりも前なら、バッファ先頭のキーフレームが使えるか判定
    if (targetKeyframeIdx === -1) {
      const oldestKeyframe = this.videoFrames[0];
      if ((oldestKeyframe.flags & VIDEO_FLAGS.KEYFRAME) !== 0) {
        const diffUs =
          oldestKeyframe.pts > lastAckPts
            ? oldestKeyframe.pts - lastAckPts
            : lastAckPts - oldestKeyframe.pts;
        // 5秒以内の乖離ならバッファ先頭から開始可能
        if (diffUs <= 5_000_000n) {
          targetKeyframeIdx = 0;
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    const startKeyframe = this.videoFrames[targetKeyframeIdx];
    const startPts = startKeyframe.pts;

    const targetVideos = this.videoFrames.slice(targetKeyframeIdx);
    const targetAudios = this.audioFrames.filter((a) => a.pts >= startPts);

    // video と audio をマージして PTS 昇順に並べる
    const merged: BufferedFrame[] = [];
    let vIdx = 0;
    let aIdx = 0;

    while (vIdx < targetVideos.length && aIdx < targetAudios.length) {
      const v = targetVideos[vIdx];
      const a = targetAudios[aIdx];

      if (v.pts <= a.pts) {
        merged.push({ type: 'video', flags: v.flags, pts: v.pts, data: v.data });
        vIdx++;
      } else {
        merged.push({ type: 'audio', flags: a.flags, pts: a.pts, data: a.data });
        aIdx++;
      }
    }

    while (vIdx < targetVideos.length) {
      const v = targetVideos[vIdx];
      merged.push({ type: 'video', flags: v.flags, pts: v.pts, data: v.data });
      vIdx++;
    }

    while (aIdx < targetAudios.length) {
      const a = targetAudios[aIdx];
      merged.push({ type: 'audio', flags: a.flags, pts: a.pts, data: a.data });
      aIdx++;
    }

    return {
      frames: merged,
      configVideo: this.cachedSpsPps || undefined,
      configAudio: this.cachedOpusHead || undefined,
    };
  }
}
