export const LAYOUT_ALIGNMENT = {
  widthMultiple: 8,
  heightMultiple: 2,
  minWidth: 640,
  minHeight: 360,
  maxHeightCap: 1_080,
  smallWidthThreshold: 1_000,
  fallbackDpr: 1.35,
  minDprClamp: 1.25,
  maxDprClamp: 1.5,
} as const;

export const ENCODE_ALIGNMENT = {
  widthMultiple: 8,
  heightMultiple: 2,
  minWidth: 320,
  minHeight: 240,
  minScale: 0.4,
  maxScale: 1.0,
} as const;

export const TOUCH_GUARD = {
  topEdgeGuardPx: 20,
  clientSlopPx: 6,
  clientDebounceMs: 60,
  clientDebounceRadiusPx: 20,
  serverSlopPx: 8,
  serverDebounceMs: 80,
  serverDebounceRadiusPx: 15,
  stuckTouchTimeoutMs: 2_500,
} as const;

export interface ViewportInput {
  readonly width: number;
  readonly height: number;
  readonly dpr?: number;
  readonly maxSize?: number;
}

export interface AlignedDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ContainRect {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly drawWidth: number;
  readonly drawHeight: number;
}

export interface MappedTouchPoint {
  readonly x: number;
  readonly y: number;
  readonly inside: boolean;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function alignLayoutDimensions(input: ViewportInput): AlignedDimensions {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/05-encoder-gpu.md#2.4
export function alignEncodeDimensions(layout: AlignedDimensions, scale: number): AlignedDimensions {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.2
export function computeContainRect(
  viewportWidth: number,
  viewportHeight: number,
  streamWidth: number,
  streamHeight: number,
): ContainRect {
  throw new Error("NOT_IMPLEMENTED");
}

// Spec: docs/specs/06-browser-input-cdp.md#2.2
export function mapTouchToStreamCoordinates(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  streamWidth: number,
  streamHeight: number,
): MappedTouchPoint | null {
  throw new Error("NOT_IMPLEMENTED");
}
