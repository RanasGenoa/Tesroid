export const WSS_CHANNEL = {
  VIDEO: 0x01,
  AUDIO: 0x02,
  CONTROL_RESPONSE: 0x03,
  TOUCH: 0x10,
  RESIZE: 0x11,
  AUTH: 0x12,
  COMMAND: 0x13,
  METRICS: 0x14,
  TELEMETRY: 0x15,
} as const;

export interface TelemetryEvent {
  timestamp: number;
  type: 'av_sync' | 'buffering' | 'decoder' | 'pacer' | 'audio' | 'log';
  event: string;
  data?: Record<string, any>;
}

export const VIDEO_FLAGS = {
  KEYFRAME: 0x01,
  CONFIG: 0x02,
} as const;

export const AUDIO_FLAGS = {
  KEYFRAME: 0x01,
  CONFIG: 0x02,
} as const;

export const TOUCH_EVENT_ACTION = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  POINTER_DOWN: 5,
  POINTER_UP: 6,
} as const;

// Backward compatibility alias
export const AMOTION_EVENT_ACTION = TOUCH_EVENT_ACTION;

export interface ClientTouchEvent {
  action: number;
  pointerId: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  pressure?: number;
}

export class ClientProtocol {
  public static packAuth(pin: string): Uint8Array {
    const encoder = new TextEncoder();
    const pinBytes = encoder.encode(pin);
    const buf = new Uint8Array(1 + pinBytes.length);
    buf[0] = WSS_CHANNEL.AUTH;
    buf.set(pinBytes, 1);
    return buf;
  }

  public static packResize(width: number, height: number, dpr: number = 1): Uint8Array {
    const buf = new Uint8Array(7);
    const view = new DataView(buf.buffer);
    buf[0] = WSS_CHANNEL.RESIZE;
    view.setUint16(1, Math.round(width), false);
    view.setUint16(3, Math.round(height), false);
    view.setUint16(5, Math.round(dpr * 100), false);
    return buf;
  }

  public static packCommand(cmd: unknown): Uint8Array {
    const str = JSON.stringify(cmd);
    const bytes = new TextEncoder().encode(str);
    const buf = new Uint8Array(1 + bytes.length);
    buf[0] = WSS_CHANNEL.COMMAND;
    buf.set(bytes, 1);
    return buf;
  }

  public static packPing(id: number, clientTime: number = performance.now()): Uint8Array {
    return this.packCommand({ type: 'PING', id, clientTime });
  }

  public static packAck(pts: number): Uint8Array {
    return this.packCommand({ type: 'ACK', pts });
  }

  public static packBufferFeedback(feedback: {
    bufferedMs: number;
    targetBufferMs: number;
    lastRenderedPts?: bigint | number;
    isInteractive?: boolean;
    stallCount?: number;
  }): Uint8Array {
    return this.packCommand({
      type: 'BUFFER_FEEDBACK',
      bufferedMs: feedback.bufferedMs,
      targetBufferMs: feedback.targetBufferMs,
      lastRenderedPts:
        feedback.lastRenderedPts !== undefined ? String(feedback.lastRenderedPts) : undefined,
      isInteractive: feedback.isInteractive ?? false,
      stallCount: feedback.stallCount ?? 0,
    });
  }

  /**
   * Pack 32-byte binary touch event:
   * [type=2: 1B] [action: 1B] [pointerId: 8B int64] [x: 4B int32] [y: 4B int32]
   * [screenWidth: 2B] [screenHeight: 2B] [pressure: 2B] [actionButton: 4B] [buttons: 4B]
   */
  public static packTouch(e: ClientTouchEvent): Uint8Array {
    const payload = new Uint8Array(33); // 1B channel + 32B touch payload
    const view = new DataView(payload.buffer);

    payload[0] = WSS_CHANNEL.TOUCH;

    // offset into 32B touch buffer starts at byte 1
    view.setUint8(1, 2); // type = INJECT_TOUCH_EVENT
    view.setUint8(2, e.action & 0xff);
    view.setBigInt64(3, BigInt(e.pointerId), false);
    view.setInt32(11, Math.round(e.x), false);
    view.setInt32(15, Math.round(e.y), false);
    view.setUint16(19, Math.round(e.screenWidth), false);
    view.setUint16(21, Math.round(e.screenHeight), false);
    view.setUint16(23, e.pressure ?? 0xffff, false);
    view.setInt32(25, 0, false); // actionButton
    view.setInt32(29, 0, false); // buttons

    return payload;
  }

  public static packMetrics(metrics: unknown): Uint8Array {
    const jsonStr = JSON.stringify(metrics);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(jsonStr);
    const buf = new Uint8Array(1 + jsonBytes.length);
    buf[0] = WSS_CHANNEL.METRICS;
    buf.set(jsonBytes, 1);
    return buf;
  }

  public static packTelemetry(events: unknown[]): Uint8Array {
    const jsonStr = JSON.stringify(events);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(jsonStr);
    const buf = new Uint8Array(1 + jsonBytes.length);
    buf[0] = WSS_CHANNEL.TELEMETRY;
    buf.set(jsonBytes, 1);
    return buf;
  }
}
