import { describe, it, expect, vi, beforeEach } from 'vitest';
import { X11InputManager } from '../src/input/xdotool.js';

describe('X11InputManager', () => {
  let inputManager: X11InputManager;
  let sentCommands: string[];

  beforeEach(() => {
    sentCommands = [];
    inputManager = new X11InputManager(':99', 1280, 720);

    // Mock sendCommand by spying on private method
    (inputManager as any).sendCommand = vi.fn((cmd: string) => {
      sentCommands.push(cmd);
    });
  });

  it('should scale touch coordinates correctly to display dimensions', () => {
    // Touch in center of 1920x1080 client screen -> maps to center of 1280x720 X11 display
    inputManager.handleTouchEvent({
      action: 0, // DOWN
      pointerId: 1,
      x: 960,
      y: 540,
      screenWidth: 1920,
      screenHeight: 1080,
    });

    expect(sentCommands).toContain('mousemove 640 360');
    expect(sentCommands).toContain('mousedown 1');
  });

  it('should handle tap cleanly with mouseup 1 without redundant duplicate click', () => {
    // DOWN
    inputManager.handleTouchEvent({
      action: 0,
      pointerId: 1,
      x: 100,
      y: 200,
      screenWidth: 1280,
      screenHeight: 720,
    });

    sentCommands = [];

    // UP after short time and minimal movement (< 15px)
    inputManager.handleTouchEvent({
      action: 1, // UP
      pointerId: 1,
      x: 102,
      y: 201,
      screenWidth: 1280,
      screenHeight: 720,
    });

    // Should only send mousemove and mouseup 1, NOT duplicate click 1
    expect(sentCommands).toEqual([
      'mousemove 102 201',
      'mouseup 1',
    ]);
  });

  it('should release mouse button when entering vertical scroll mode', () => {
    // DOWN
    inputManager.handleTouchEvent({
      action: 0,
      pointerId: 1,
      x: 500,
      y: 300,
      screenWidth: 1280,
      screenHeight: 720,
    });

    sentCommands = [];

    // MOVE with vertical displacement > 8px (e.g. drag up by 25px -> scroll down)
    inputManager.handleTouchEvent({
      action: 2, // MOVE
      pointerId: 1,
      x: 500,
      y: 275, // deltaY = -25
      screenWidth: 1280,
      screenHeight: 720,
    });

    // Must release mousedown 1 BEFORE sending scroll wheel clicks
    expect(sentCommands[0]).toBe('mouseup 1');
    expect(sentCommands.some((cmd) => cmd.startsWith('click 5'))).toBe(true);

    sentCommands = [];

    // UP after scrolling -> should NOT send any clicks
    inputManager.handleTouchEvent({
      action: 1, // UP
      pointerId: 1,
      x: 500,
      y: 275,
      screenWidth: 1280,
      screenHeight: 720,
    });

    expect(sentCommands).toEqual([]);
  });

  it('should safely ignore multi-touch actions (e.g. POINTER_DOWN=5, POINTER_UP=6)', () => {
    inputManager.handleTouchEvent({
      action: 5, // POINTER_DOWN
      pointerId: 2,
      x: 600,
      y: 400,
      screenWidth: 1280,
      screenHeight: 720,
    });

    expect(sentCommands).toEqual([]);
  });

  it('should debounce rapid chatter DOWN in CdpTouchBridge', () => {
    const cdpBridge = (inputManager as any).cdpBridge;
    cdpBridge.isConnected = () => true;
    const sentCdp: any[] = [];
    cdpBridge.send = vi.fn((method: string, params: any) => {
      sentCdp.push({ method, params });
    });

    // 1. Initial DOWN and UP (Tap)
    cdpBridge.handleTouch(0, 1, 100, 100); // DOWN
    cdpBridge.handleTouch(1, 1, 100, 100); // UP

    expect(sentCdp.length).toBe(2);
    expect(sentCdp[0].params.type).toBe('touchStart');
    expect(sentCdp[1].params.type).toBe('touchEnd');
    // Ensure NO duplicate mousePressed / mouseReleased was sent!
    expect(sentCdp.some(m => m.method === 'Input.dispatchMouseEvent')).toBe(false);

    // 2. Rapid chatter DOWN within 80ms at same location (< 15px)
    sentCdp.length = 0;
    const suppressed = cdpBridge.handleTouch(0, 1, 102, 101); // Chatter DOWN
    expect(suppressed).toBe(true);
    // Should NOT send a new touchStart
    expect(sentCdp.length).toBe(0);
  });

  it('should ignore unpaired MOVE events without poisoning activeTouches', () => {
    const cdpBridge = (inputManager as any).cdpBridge;
    cdpBridge.isConnected = () => true;
    const sentCdp: any[] = [];
    cdpBridge.send = vi.fn((method: string, params: any) => {
      sentCdp.push({ method, params });
    });

    // 1. Stray hover MOVE (pointerId=1) with no prior DOWN
    cdpBridge.handleTouch(2, 1, 300, 300);
    expect(sentCdp.length).toBe(0);

    // 2. Subsequent tap with pointerId=2 must still cleanly send touchStart and touchEnd
    cdpBridge.handleTouch(0, 2, 500, 500); // DOWN
    cdpBridge.handleTouch(1, 2, 500, 500); // UP

    expect(sentCdp.length).toBe(2);
    expect(sentCdp[0].params.type).toBe('touchStart');
    expect(sentCdp[0].params.touchPoints).toEqual([{ x: 500, y: 500, id: 2 }]);
    expect(sentCdp[1].params.type).toBe('touchEnd');
    expect(sentCdp[1].params.touchPoints).toEqual([]);
  });

  it('should auto-recover with touchCancel if a previous touch was left unclosed when a new primary DOWN arrives', () => {
    const cdpBridge = (inputManager as any).cdpBridge;
    cdpBridge.isConnected = () => true;
    const sentCdp: any[] = [];
    cdpBridge.send = vi.fn((method: string, params: any) => {
      sentCdp.push({ method, params });
    });

    // 1. Touch 1 starts (DOWN) but UP is lost
    cdpBridge.handleTouch(0, 10, 200, 200);
    expect(sentCdp.length).toBe(1);
    expect(sentCdp[0].params.type).toBe('touchStart');

    sentCdp.length = 0;

    // 2. New primary single-finger touch (action=0, pointerId=11) arrives
    cdpBridge.handleTouch(0, 11, 400, 400);
    cdpBridge.handleTouch(1, 11, 400, 400);

    expect(sentCdp.map((c) => c.params.type)).toEqual([
      'touchCancel',
      'touchStart',
      'touchEnd',
    ]);
    expect(sentCdp[1].params.touchPoints).toEqual([{ x: 400, y: 400, id: 11 }]);
  });
});
