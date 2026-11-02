export class EdgeGuard {
  // Top 20px on Tesla browser is sensitive to browser minimize / dismiss gestures
  private static readonly TOP_GUARD_HEIGHT = 20;

  public static isTopEdgeGesture(clientY: number): boolean {
    return clientY <= EdgeGuard.TOP_GUARD_HEIGHT;
  }
}
