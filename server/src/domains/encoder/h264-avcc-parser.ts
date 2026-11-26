export interface ParsedH264Unit {
  readonly kind: "CONFIG" | "ACCESS_UNIT";
  readonly isKeyframe: boolean;
  readonly data: Uint8Array;
}

export class H264AvccParser {
  // Spec: docs/specs/05-encoder-gpu.md#2.1
  push(chunk: Uint8Array): readonly ParsedH264Unit[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#4
  flush(): readonly ParsedH264Unit[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  // Spec: docs/specs/05-encoder-gpu.md#2.1
  reset(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
