import type { DynamicLatencyController } from '../core/latency.js';
import { AMOTION_EVENT_ACTION, ClientProtocol } from '../transport/protocol.js';
import type { WsClient } from '../transport/ws-client.js';
import { EdgeGuard } from './edge-guard.js';

export class TouchMapper {
  private canvas: HTMLCanvasElement;
  private wsClient: WsClient;
  private latencyController: DynamicLatencyController;
  private activePointers: Set<number> = new Set();

  private startPositions: Map<number, { x: number; y: number; moved: boolean }> = new Map();
  private static readonly CLIENT_SLOP_PX = 6;
  private static readonly DEBOUNCE_MS = 60;
  private static readonly DEBOUNCE_DIST = 20;
  private lastPointerUpTime = 0;
  private lastPointerUpPos = { x: 0, y: 0 };

  private onPointerDown = (e: PointerEvent) => this.handlePointer(e, AMOTION_EVENT_ACTION.DOWN);
  private onPointerMove = (e: PointerEvent) => this.handlePointer(e, AMOTION_EVENT_ACTION.MOVE);
  private onPointerUp = (e: PointerEvent) => this.handlePointer(e, AMOTION_EVENT_ACTION.UP);
  private onPointerCancel = (e: PointerEvent) => this.handlePointer(e, AMOTION_EVENT_ACTION.CANCEL);
  private onWindowBlur = () => this.cancelAllActivePointers();

  constructor(
    canvas: HTMLCanvasElement,
    wsClient: WsClient,
    latencyController: DynamicLatencyController,
  ) {
    this.canvas = canvas;
    this.wsClient = wsClient;
    this.latencyController = latencyController;
    this.bindEvents();
  }

  private bindEvents(): void {
    const el = this.canvas;
    el.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    el.addEventListener('pointermove', this.onPointerMove, { passive: false });
    el.addEventListener('pointerup', this.onPointerUp, { passive: false });
    el.addEventListener('pointercancel', this.onPointerCancel, { passive: false });
    el.addEventListener('lostpointercapture', this.onPointerCancel, { passive: false });
    window.addEventListener('blur', this.onWindowBlur);
  }

  public destroy(): void {
    const el = this.canvas;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerCancel);
    el.removeEventListener('lostpointercapture', this.onPointerCancel);
    window.removeEventListener('blur', this.onWindowBlur);
  }

  private cancelAllActivePointers(): void {
    if (this.activePointers.size === 0) return;
    const canvasW = this.canvas.width || 1280;
    const canvasH = this.canvas.height || 720;
    for (const pointerId of Array.from(this.activePointers)) {
      this.activePointers.delete(pointerId);
      this.startPositions.delete(pointerId);
      const cancelPacket = ClientProtocol.packTouch({
        action: AMOTION_EVENT_ACTION.CANCEL,
        pointerId,
        x: 0,
        y: 0,
        screenWidth: canvasW,
        screenHeight: canvasH,
        pressure: 0,
      });
      this.wsClient.send(cancelPacket);
    }
  }

  private handlePointer(e: PointerEvent, actionType: number): void {
    // Ignore non-primary mouse buttons
    if (e.pointerType === 'mouse' && actionType === AMOTION_EVENT_ACTION.DOWN && e.button !== 0) {
      return;
    }

    // CRITICAL: Never forward hover/unpaired MOVE, UP, or CANCEL events for pointers that did not start on canvas
    if (actionType !== AMOTION_EVENT_ACTION.DOWN && !this.activePointers.has(e.pointerId)) {
      return;
    }

    // If a mouse pointer moves with buttons=0 while marked active, immediately release it
    if (actionType === AMOTION_EVENT_ACTION.MOVE && e.pointerType === 'mouse' && e.buttons === 0) {
      this.handlePointer(e, AMOTION_EVENT_ACTION.UP);
      return;
    }

    e.preventDefault();

    // Notify latency controller of active interaction
    this.latencyController.notifyInteraction();

    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.clientX;
    const clientY = e.clientY;

    // Edge guard: allow Tesla OS swipe down at very top edge if pointerdown occurs there
    if (actionType === AMOTION_EVENT_ACTION.DOWN && EdgeGuard.isTopEdgeGesture(clientY)) {
      return;
    }

    // Debounce rapid hardware contact bounce / chatter on touch panels
    if (actionType === AMOTION_EVENT_ACTION.DOWN) {
      const now = performance.now();
      if (
        now - this.lastPointerUpTime < TouchMapper.DEBOUNCE_MS &&
        Math.hypot(clientX - this.lastPointerUpPos.x, clientY - this.lastPointerUpPos.y) <
          TouchMapper.DEBOUNCE_DIST
      ) {
        return; // Suppress chatter pointerdown (activePointers is not added, so subsequent MOVE/UP are also ignored)
      }
    }

    const canvasW = this.canvas.width || rect.width || 1280;
    const canvasH = this.canvas.height || rect.height || 720;

    // Determine actual rendered content rect inside canvas element
    const canvasAspect = canvasW / canvasH;
    const elemAspect = rect.width / (rect.height || 1);

    let renderedW = rect.width;
    let renderedH = rect.height;
    let renderedX = rect.left;
    let renderedY = rect.top;

    // Check if canvas is in contain mode
    const isContain = window.getComputedStyle(this.canvas).objectFit === 'contain';
    if (isContain && canvasAspect > 0 && elemAspect > 0) {
      if (elemAspect > canvasAspect) {
        // Pillarboxed (black bars on left/right)
        renderedW = rect.height * canvasAspect;
        renderedX = rect.left + (rect.width - renderedW) / 2;
      } else {
        // Letterboxed (black bars on top/bottom)
        renderedH = rect.width / canvasAspect;
        renderedY = rect.top + (rect.height - renderedH) / 2;
      }
    }

    const scaleX = canvasW / (renderedW || 1);
    const scaleY = canvasH / (renderedH || 1);

    const normX = Math.max(0, Math.min(canvasW, (clientX - renderedX) * scaleX));
    const normY = Math.max(0, Math.min(canvasH, (clientY - renderedY) * scaleY));

    // Client-side Touch Slop: suppress micro-jitter on MOVE
    if (actionType === AMOTION_EVENT_ACTION.DOWN) {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {}
      this.startPositions.set(e.pointerId, { x: clientX, y: clientY, moved: false });
    } else if (actionType === AMOTION_EVENT_ACTION.MOVE) {
      const start = this.startPositions.get(e.pointerId);
      if (start && !start.moved) {
        const dist = Math.hypot(clientX - start.x, clientY - start.y);
        if (dist < TouchMapper.CLIENT_SLOP_PX) {
          return; // Suppress micro-movement jitter
        }
        start.moved = true;
      }
    } else if (
      actionType === AMOTION_EVENT_ACTION.UP ||
      actionType === AMOTION_EVENT_ACTION.CANCEL
    ) {
      try {
        if (this.canvas.hasPointerCapture(e.pointerId)) {
          this.canvas.releasePointerCapture(e.pointerId);
        }
      } catch {}
      this.lastPointerUpTime = performance.now();
      this.lastPointerUpPos = { x: clientX, y: clientY };
      this.startPositions.delete(e.pointerId);
    }

    // Determine correct AMotionEvent action for multi-touch
    let finalAction = actionType;
    if (actionType === AMOTION_EVENT_ACTION.DOWN) {
      if (this.activePointers.size > 0) {
        finalAction = AMOTION_EVENT_ACTION.POINTER_DOWN;
      }
      this.activePointers.add(e.pointerId);
    } else if (
      actionType === AMOTION_EVENT_ACTION.UP ||
      actionType === AMOTION_EVENT_ACTION.CANCEL
    ) {
      if (this.activePointers.size > 1 && actionType === AMOTION_EVENT_ACTION.UP) {
        finalAction = AMOTION_EVENT_ACTION.POINTER_UP;
      }
      this.activePointers.delete(e.pointerId);
    }

    const touchPacket = ClientProtocol.packTouch({
      action: finalAction,
      pointerId: e.pointerId,
      x: normX,
      y: normY,
      screenWidth: canvasW,
      screenHeight: canvasH,
      pressure: 0xffff,
    });

    this.wsClient.send(touchPacket);
  }
}
