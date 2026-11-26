export interface ParsedOpusPacket {
  readonly kind: "CONFIG" | "AUDIO_PACKET";
  readonly data: Uint8Array;
}

export class OggOpusParser {
  // Spec: docs/specs/05-encoder-gpu.md#2.1
  push(chunk: Uint8Array): readonly ParsedOpusPacket[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  reset(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
