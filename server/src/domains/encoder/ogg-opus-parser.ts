export interface ParsedOpusPacket {
  readonly kind: "CONFIG" | "AUDIO_PACKET";
  readonly data: Uint8Array;
}

const OGG_CAPTURE = [0x4f, 0x67, 0x67, 0x53] as const; // "OggS"
const OPUS_HEAD_PREFIX = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64] as const; // "OpusHead"
const OPUS_TAGS_PREFIX = [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73] as const; // "OpusTags"
const OGG_MIN_HEADER_BYTES = 27;
const OPUS_HEAD_MIN_BYTES = 19;

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

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const first = chunks[0];
  if (chunks.length === 1 && first !== undefined) {
    return new Uint8Array(first);
  }
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function findOggCapture(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.byteLength; i += 1) {
    if (
      buf[i] === OGG_CAPTURE[0] &&
      buf[i + 1] === OGG_CAPTURE[1] &&
      buf[i + 2] === OGG_CAPTURE[2] &&
      buf[i + 3] === OGG_CAPTURE[3]
    ) {
      return i;
    }
  }
  return -1;
}

function startsWithBytes(buf: Uint8Array, prefix: readonly number[]): boolean {
  if (buf.byteLength < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (buf[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

export class OggOpusParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private pendingPacketChunks: Uint8Array[] = [];

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  push(chunk: Uint8Array): readonly ParsedOpusPacket[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    this.buffer = concatBytes(this.buffer, chunk);
    const packets: ParsedOpusPacket[] = [];

    while (true) {
      const captureOffset = findOggCapture(this.buffer);
      if (captureOffset < 0) {
        this.buffer =
          this.buffer.byteLength > 3 ? this.buffer.slice(this.buffer.byteLength - 3) : this.buffer;
        break;
      }

      if (captureOffset > 0) {
        this.buffer = this.buffer.slice(captureOffset);
      }

      if (this.buffer.byteLength < OGG_MIN_HEADER_BYTES) {
        break;
      }

      const headerType = this.buffer[5] ?? 0;
      const pageSegments = this.buffer[26] ?? 0;
      const headerTotalBytes = OGG_MIN_HEADER_BYTES + pageSegments;
      if (this.buffer.byteLength < headerTotalBytes) {
        break;
      }

      let bodyBytes = 0;
      for (let i = 0; i < pageSegments; i += 1) {
        bodyBytes += this.buffer[OGG_MIN_HEADER_BYTES + i] ?? 0;
      }

      const pageTotalBytes = headerTotalBytes + bodyBytes;
      if (this.buffer.byteLength < pageTotalBytes) {
        break;
      }

      if ((headerType & 0x01) === 0) {
        this.pendingPacketChunks = [];
      }

      let dataOffset = headerTotalBytes;
      for (let i = 0; i < pageSegments; i += 1) {
        const segLen = this.buffer[OGG_MIN_HEADER_BYTES + i] ?? 0;
        if (segLen > 0) {
          this.pendingPacketChunks.push(this.buffer.subarray(dataOffset, dataOffset + segLen));
          dataOffset += segLen;
        }
        if (segLen < 255) {
          const packet = joinChunks(this.pendingPacketChunks);
          this.pendingPacketChunks = [];
          this.classifyPacket(packet, packets);
        }
      }

      this.buffer = this.buffer.slice(pageTotalBytes);
    }

    return packets;
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  reset(): void {
    this.buffer = new Uint8Array(0);
    this.pendingPacketChunks = [];
  }

  private classifyPacket(packet: Uint8Array, out: ParsedOpusPacket[]): void {
    if (packet.byteLength === 0) {
      return;
    }
    if (startsWithBytes(packet, OPUS_HEAD_PREFIX)) {
      if (packet.byteLength >= OPUS_HEAD_MIN_BYTES) {
        out.push({ kind: "CONFIG", data: packet });
      }
      return;
    }
    if (startsWithBytes(packet, OPUS_TAGS_PREFIX)) {
      return;
    }
    out.push({ kind: "AUDIO_PACKET", data: packet });
  }
}
