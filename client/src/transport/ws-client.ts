import { WSS_CHANNEL } from './protocol.js';

export interface VideoMessage {
  flags: number;
  pts: bigint;
  data: Uint8Array;
}

export interface AudioMessage {
  flags: number;
  pts: bigint;
  data: Uint8Array;
}

export interface ControlMessage {
  type: string;
  [key: string]: any;
}

export type WsEventMap = {
  open: () => void;
  close: (ev: CloseEvent) => void;
  error: (ev: Event) => void;
  video: (msg: VideoMessage) => void;
  audio: (msg: AudioMessage) => void;
  control: (msg: ControlMessage) => void;
};

const sharedTextDecoder = new TextDecoder();

function readBigInt64BE(bytes: Uint8Array, offset: number): bigint {
  const u64 =
    (BigInt(bytes[offset]) << 56n) |
    (BigInt(bytes[offset + 1]) << 48n) |
    (BigInt(bytes[offset + 2]) << 40n) |
    (BigInt(bytes[offset + 3]) << 32n) |
    (BigInt(bytes[offset + 4]) << 24n) |
    (BigInt(bytes[offset + 5]) << 16n) |
    (BigInt(bytes[offset + 6]) << 8n) |
    BigInt(bytes[offset + 7]);
  return u64 >= 0x8000000000000000n ? u64 - 0x10000000000000000n : u64;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners: { [K in keyof WsEventMap]?: Function[] } = {};
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private isExplicitlyClosed = false;

  constructor(customUrl?: string) {
    if (customUrl) {
      this.url = customUrl;
    } else {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.url = `${proto}//${window.location.host}/ws`;
    }
  }

  public connect(): void {
    this.isExplicitlyClosed = false;
    try {
      console.log(`[WsClient] Connecting to ${this.url}...`);
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        console.log('[WsClient] Connected.');
        this.reconnectAttempts = 0;
        this.emit('open');
      };

      this.ws.onclose = (ev) => {
        console.log(`[WsClient] Disconnected (code: ${ev.code}, reason: ${ev.reason})`);
        this.emit('close', ev);
        if (!this.isExplicitlyClosed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (ev) => {
        console.warn('[WsClient] WebSocket error:', ev);
        this.emit('error', ev);
      };

      this.ws.onmessage = (ev) => {
        this.handleMessage(ev.data as ArrayBuffer);
      };
    } catch (err) {
      console.error('[WsClient] Connection exception:', err);
      this.scheduleReconnect();
    }
  }

  public send(data: Uint8Array | ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public close(): void {
    this.isExplicitlyClosed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public on<K extends keyof WsEventMap>(event: K, handler: WsEventMap[K]): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(handler);
  }

  public off<K extends keyof WsEventMap>(event: K, handler: WsEventMap[K]): void {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event]!.filter((h) => h !== handler);
  }

  private emit<K extends keyof WsEventMap>(event: K, ...args: any[]): void {
    const handlers = this.listeners[event] || [];
    for (const h of handlers) {
      h(...args);
    }
  }

  private handleMessage(buffer: ArrayBuffer): void {
    const bytes = new Uint8Array(buffer);
    if (bytes.length === 0) return;

    const channel = bytes[0];

    switch (channel) {
      case WSS_CHANNEL.VIDEO: {
        if (bytes.length < 10) return;
        const flags = bytes[1];
        const pts = readBigInt64BE(bytes, 2);
        const data = bytes.subarray(10);
        this.emit('video', { flags, pts, data });
        break;
      }

      case WSS_CHANNEL.AUDIO: {
        if (bytes.length < 10) return;
        const flags = bytes[1];
        const pts = readBigInt64BE(bytes, 2);
        const data = bytes.subarray(10);
        this.emit('audio', { flags, pts, data });
        break;
      }

      case WSS_CHANNEL.CONTROL_RESPONSE: {
        const jsonStr = sharedTextDecoder.decode(bytes.subarray(1));
        try {
          const parsed = JSON.parse(jsonStr);
          this.emit('control', parsed);
        } catch (e) {
          console.warn('[WsClient] Failed to parse control JSON:', e);
        }
        break;
      }
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, this.maxReconnectDelay);
    this.reconnectAttempts++;
    console.log(
      `[WsClient] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})...`,
    );
    setTimeout(() => {
      if (!this.isExplicitlyClosed) {
        this.connect();
      }
    }, delay);
  }
}
