// Spec: docs/specs/04-client-playback-avsync.md#2.2

export interface PointerSourceLike {
  addEventListener(
    type: "pointerdown",
    listener: () => void,
    options?: { capture?: boolean },
  ): void;
}

// 自動再生ポリシーでは AudioContext の解禁が信頼できるポインタ操作でのみ可能なため、
// canvas 等の特定コンポーネントに限定せず UI 全域の単一経路で解禁を保証する。
export function attachGlobalAudioUnlock(source: PointerSourceLike, onUnlock: () => void): void {
  source.addEventListener("pointerdown", onUnlock, { capture: true });
}
