export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private currentWidth = 0;
  private currentHeight = 0;
  private frameCount = 0;
  private lastFpsCalcTime = 0;
  private lastRenderTime = 0;
  private currentFps = 0;
  private hasRenderedFirstFrame = false;
  public onFirstFrameRendered?: () => void;
  public onFrameDrawn?: (currentFps: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true, // Hint to browser for lowest latency
    });
    if (!ctx) {
      throw new Error('Failed to obtain CanvasRenderingContext2D.');
    }
    this.ctx = ctx;
    this.lastFpsCalcTime = performance.now();
    this.lastRenderTime = performance.now();
  }

  public resize(width: number, height: number): void {
    if (this.currentWidth !== width || this.currentHeight !== height) {
      this.currentWidth = width;
      this.currentHeight = height;
      this.canvas.width = width;
      this.canvas.height = height;
      console.log(`[CanvasRenderer] Canvas resized to ${width}x${height}`);
    }
  }

  public render(frame: VideoFrame): void {
    if (this.currentWidth !== frame.displayWidth || this.currentHeight !== frame.displayHeight) {
      this.resize(frame.displayWidth, frame.displayHeight);
    }

    // Render frame
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);

    if (!this.hasRenderedFirstFrame) {
      this.hasRenderedFirstFrame = true;
      this.onFirstFrameRendered?.();
    }

    // CRITICAL: Must close VideoFrame to avoid GPU memory leaks in Tesla browser
    frame.close();

    const now = performance.now();
    this.lastRenderTime = now;
    this.frameCount++;

    if (now - this.lastFpsCalcTime >= 1000) {
      this.currentFps = Math.round((this.frameCount * 1000) / (now - this.lastFpsCalcTime));
      this.frameCount = 0;
      this.lastFpsCalcTime = now;
    }

    this.onFrameDrawn?.(this.currentFps);
  }

  public resetFirstFrame(): void {
    this.hasRenderedFirstFrame = false;
  }

  public getFps(): number {
    const now = performance.now();
    if (now - this.lastRenderTime >= 1500) {
      this.currentFps = 0;
    }
    return this.currentFps;
  }

  public getLastRenderTime(): number {
    return this.lastRenderTime;
  }

  public clear(): void {
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
