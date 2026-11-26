export interface ParsedH264Unit {
  readonly kind: "CONFIG" | "ACCESS_UNIT";
  readonly isKeyframe: boolean;
  readonly data: Uint8Array;
}

interface StartCodeSpan {
  readonly start: number;
  readonly end: number;
}

const START_CODE_4B = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
const MAX_PENDING_TAIL_BYTES = 3;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) {
    return b;
  }
  if (b.byteLength === 0) {
    return a;
  }
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function findStartCodes(buf: Uint8Array): StartCodeSpan[] {
  const spans: StartCodeSpan[] = [];
  let i = 0;
  while (i + 2 < buf.byteLength) {
    if (
      i + 3 < buf.byteLength &&
      buf[i] === 0 &&
      buf[i + 1] === 0 &&
      buf[i + 2] === 0 &&
      buf[i + 3] === 1
    ) {
      spans.push({ start: i, end: i + 4 });
      i += 4;
      continue;
    }
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      spans.push({ start: i, end: i + 3 });
      i += 3;
      continue;
    }
    i += 1;
  }
  return spans;
}

function matchLeadingStartCodeLength(buf: Uint8Array): number {
  if (buf.byteLength >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1) {
    return 4;
  }
  if (buf.byteLength >= 3 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1) {
    return 3;
  }
  return 0;
}

export class H264AvccParser {
  private pending: Uint8Array = new Uint8Array(0);
  private lastSps: Uint8Array | null = null;
  private lastPps: Uint8Array | null = null;
  private configPending = false;
  private currentSlices: Uint8Array[] = [];
  private currentAuIsKeyframe = false;

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  push(chunk: Uint8Array): readonly ParsedH264Unit[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    const buf = concatBytes(this.pending, chunk);
    const spans = findStartCodes(buf);
    const units: ParsedH264Unit[] = [];

    if (spans.length === 0) {
      this.pending =
        buf.byteLength > MAX_PENDING_TAIL_BYTES
          ? buf.slice(buf.byteLength - MAX_PENDING_TAIL_BYTES)
          : new Uint8Array(buf);
      return units;
    }

    const firstSpan = spans[0];
    if (firstSpan !== undefined && spans.length === 1) {
      this.pending = buf.slice(firstSpan.start);
      return units;
    }

    for (let i = 0; i < spans.length - 1; i += 1) {
      const current = spans[i];
      const next = spans[i + 1];
      if (current === undefined || next === undefined) {
        continue;
      }
      this.processNal(buf.subarray(current.end, next.start), units);
    }

    const lastSpan = spans[spans.length - 1];
    this.pending = lastSpan !== undefined ? buf.slice(lastSpan.start) : new Uint8Array(0);
    return units;
  }

  // Spec: docs/specs/05-encoder-gpu.md#4
  flush(): readonly ParsedH264Unit[] {
    const units: ParsedH264Unit[] = [];
    const scLen = matchLeadingStartCodeLength(this.pending);
    if (scLen > 0 && this.pending.byteLength > scLen) {
      this.processNal(this.pending.subarray(scLen), units);
    }
    this.pending = new Uint8Array(0);
    this.flushAccessUnit(units);
    return units;
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  reset(): void {
    this.pending = new Uint8Array(0);
    this.lastSps = null;
    this.lastPps = null;
    this.configPending = false;
    this.currentSlices = [];
    this.currentAuIsKeyframe = false;
  }

  private processNal(nal: Uint8Array, units: ParsedH264Unit[]): void {
    const firstByte = nal[0];
    if (firstByte === undefined) {
      return;
    }

    const nalType = firstByte & 0x1f;

    // AUD (9) and SEI (6) are discarded per Spec 05 §2.1, flushing any prior AU first.
    if (nalType === 9 || nalType === 6) {
      this.flushAccessUnit(units);
      return;
    }

    if (nalType === 7) {
      this.flushAccessUnit(units);
      this.lastSps = new Uint8Array(nal);
      this.configPending = true;
      return;
    }

    if (nalType === 8) {
      this.flushAccessUnit(units);
      this.lastPps = new Uint8Array(nal);
      this.configPending = true;
      if (this.lastSps !== null) {
        this.emitConfig(units);
      }
      return;
    }

    if (nalType >= 1 && nalType <= 5) {
      const isIdr = nalType === 5;
      // Exp-Golomb first_mb_in_slice === 0 starts with MSB 1, marking a new frame even without AUD.
      const secondByte = nal[1];
      const startsNewSliceZero = secondByte !== undefined && (secondByte & 0x80) !== 0;
      if (
        this.currentSlices.length > 0 &&
        (isIdr !== this.currentAuIsKeyframe || startsNewSliceZero)
      ) {
        this.flushAccessUnit(units);
      }

      if (this.configPending && this.lastSps !== null && this.lastPps !== null) {
        this.emitConfig(units);
      }

      this.currentSlices.push(new Uint8Array(nal));
      if (isIdr) {
        this.currentAuIsKeyframe = true;
      }
      return;
    }

    this.flushAccessUnit(units);
  }

  private emitConfig(units: ParsedH264Unit[]): void {
    if (this.lastSps === null || this.lastPps === null) {
      return;
    }
    const config = new Uint8Array(8 + this.lastSps.byteLength + this.lastPps.byteLength);
    let offset = 0;
    config.set(START_CODE_4B, offset);
    offset += 4;
    config.set(this.lastSps, offset);
    offset += this.lastSps.byteLength;
    config.set(START_CODE_4B, offset);
    offset += 4;
    config.set(this.lastPps, offset);

    units.push({
      kind: "CONFIG",
      isKeyframe: false,
      data: config,
    });
    this.configPending = false;
  }

  private flushAccessUnit(units: ParsedH264Unit[]): void {
    if (this.currentSlices.length === 0) {
      return;
    }

    let totalBytes = 0;
    for (const slice of this.currentSlices) {
      totalBytes += 4 + slice.byteLength;
    }

    const avcc = new Uint8Array(totalBytes);
    const view = new DataView(avcc.buffer, avcc.byteOffset, avcc.byteLength);
    let offset = 0;
    for (const slice of this.currentSlices) {
      view.setUint32(offset, slice.byteLength, false);
      offset += 4;
      avcc.set(slice, offset);
      offset += slice.byteLength;
    }

    units.push({
      kind: "ACCESS_UNIT",
      isKeyframe: this.currentAuIsKeyframe,
      data: avcc,
    });

    this.currentSlices = [];
    this.currentAuIsKeyframe = false;
  }
}
