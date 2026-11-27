import { STREAM_BOUNDS } from "../settings/constants.js";
import { SharedValidationError } from "../types/errors.js";

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

// Spec: docs/specs/03-streaming-transport.md#2.1
export function alignLayoutDimensions(input: ViewportInput): AlignedDimensions {
  if (!isPositiveFinite(input.width) || !isPositiveFinite(input.height)) {
    throw new SharedValidationError(
      "INVALID_DIMENSIONS",
      "Viewport width and height must be positive",
    );
  }

  let effectiveMaxSize: number = STREAM_BOUNDS.maxSize.default;
  if (input.maxSize !== undefined) {
    if (!Number.isFinite(input.maxSize)) {
      throw new SharedValidationError("INVALID_DIMENSIONS", "maxSize must be a finite number");
    }
    effectiveMaxSize = clamp(
      Math.round(input.maxSize),
      STREAM_BOUNDS.maxSize.min,
      STREAM_BOUNDS.maxSize.max,
    );
  }

  let width = input.width;
  let height = input.height;

  if (width < LAYOUT_ALIGNMENT.smallWidthThreshold) {
    const rawDpr =
      input.dpr !== undefined && Number.isFinite(input.dpr) && input.dpr > 1
        ? input.dpr
        : LAYOUT_ALIGNMENT.fallbackDpr;
    const scale = clamp(rawDpr, LAYOUT_ALIGNMENT.minDprClamp, LAYOUT_ALIGNMENT.maxDprClamp);
    width *= scale;
    height *= scale;
  }

  const longest = Math.max(width, height);
  if (longest > effectiveMaxSize) {
    const ratio = effectiveMaxSize / longest;
    width *= ratio;
    height *= ratio;
  }

  const maxHeight = Math.min(LAYOUT_ALIGNMENT.maxHeightCap, effectiveMaxSize);
  const alignedWidth =
    clamp(Math.round(width), LAYOUT_ALIGNMENT.minWidth, effectiveMaxSize) &
    ~(LAYOUT_ALIGNMENT.widthMultiple - 1);
  const alignedHeight =
    clamp(Math.round(height), LAYOUT_ALIGNMENT.minHeight, maxHeight) &
    ~(LAYOUT_ALIGNMENT.heightMultiple - 1);

  return {
    width: alignedWidth,
    height: alignedHeight,
  };
}

// Spec: docs/specs/05-encoder-gpu.md#2.3
export function clampAlignedDimensions(
  layout: AlignedDimensions,
  maxSize: number,
): AlignedDimensions {
  const effectiveMaxSize = clamp(
    Math.round(maxSize),
    STREAM_BOUNDS.maxSize.min,
    STREAM_BOUNDS.maxSize.max,
  );
  const maxHeight = Math.min(LAYOUT_ALIGNMENT.maxHeightCap, effectiveMaxSize);
  if (layout.width <= effectiveMaxSize && layout.height <= maxHeight) {
    return { width: layout.width, height: layout.height };
  }

  const ratio = Math.min(effectiveMaxSize / layout.width, maxHeight / layout.height);
  const width =
    Math.max(LAYOUT_ALIGNMENT.minWidth, Math.round(layout.width * ratio)) &
    ~(LAYOUT_ALIGNMENT.widthMultiple - 1);
  const height =
    Math.max(LAYOUT_ALIGNMENT.minHeight, Math.round(layout.height * ratio)) &
    ~(LAYOUT_ALIGNMENT.heightMultiple - 1);
  return { width, height };
}

// Spec: docs/specs/05-encoder-gpu.md#2.4
export function alignEncodeDimensions(layout: AlignedDimensions, scale: number): AlignedDimensions {
  if (!isPositiveFinite(layout.width) || !isPositiveFinite(layout.height)) {
    throw new SharedValidationError("INVALID_DIMENSIONS", "Layout dimensions must be positive");
  }

  if (!Number.isFinite(scale) || scale >= ENCODE_ALIGNMENT.maxScale) {
    return {
      width: layout.width,
      height: layout.height,
    };
  }

  const clampedScale = Math.max(ENCODE_ALIGNMENT.minScale, scale);
  const width =
    Math.max(ENCODE_ALIGNMENT.minWidth, Math.round(layout.width * clampedScale)) &
    ~(ENCODE_ALIGNMENT.widthMultiple - 1);
  const height =
    Math.max(ENCODE_ALIGNMENT.minHeight, Math.round(layout.height * clampedScale)) &
    ~(ENCODE_ALIGNMENT.heightMultiple - 1);

  return { width, height };
}

// Spec: docs/specs/06-browser-input-cdp.md#2.2
export function computeContainRect(
  viewportWidth: number,
  viewportHeight: number,
  streamWidth: number,
  streamHeight: number,
): ContainRect {
  if (
    !isPositiveFinite(viewportWidth) ||
    !isPositiveFinite(viewportHeight) ||
    !isPositiveFinite(streamWidth) ||
    !isPositiveFinite(streamHeight)
  ) {
    return { offsetX: 0, offsetY: 0, drawWidth: 0, drawHeight: 0 };
  }

  const streamAspect = streamWidth / streamHeight;
  const viewportAspect = viewportWidth / viewportHeight;

  if (streamAspect > viewportAspect) {
    const drawWidth = viewportWidth;
    const drawHeight = viewportWidth / streamAspect;
    return {
      offsetX: 0,
      offsetY: (viewportHeight - drawHeight) / 2,
      drawWidth,
      drawHeight,
    };
  }

  const drawHeight = viewportHeight;
  const drawWidth = viewportHeight * streamAspect;
  return {
    offsetX: (viewportWidth - drawWidth) / 2,
    offsetY: 0,
    drawWidth,
    drawHeight,
  };
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
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !isPositiveFinite(viewportWidth) ||
    !isPositiveFinite(viewportHeight) ||
    !isPositiveFinite(streamWidth) ||
    !isPositiveFinite(streamHeight)
  ) {
    return null;
  }

  if (clientY <= TOUCH_GUARD.topEdgeGuardPx) {
    return null;
  }

  const rect = computeContainRect(viewportWidth, viewportHeight, streamWidth, streamHeight);
  if (rect.drawWidth <= 0 || rect.drawHeight <= 0) {
    return null;
  }

  const inside =
    clientX >= rect.offsetX &&
    clientX <= rect.offsetX + rect.drawWidth &&
    clientY >= rect.offsetY &&
    clientY <= rect.offsetY + rect.drawHeight;

  const x = clamp(((clientX - rect.offsetX) / rect.drawWidth) * streamWidth, 0, streamWidth);
  const y = clamp(((clientY - rect.offsetY) / rect.drawHeight) * streamHeight, 0, streamHeight);

  return { x, y, inside };
}
