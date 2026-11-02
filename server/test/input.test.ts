import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { X11InputManager } from '../src/input/xdotool.js';

describe('X11InputManager & CdpTouchBridge', () => {
  let inputManager: X11InputManager;
  let sentCommands: string[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Prevent CdpTouchBridge from attempting real TCP connections to 127.0.0.1:9222 during tests
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('CDP mocked offline')) as any;
    sentCommands = [];
    inputManager = new X11InputManager(':99', 1280, 720);

    (inputManager as any).sendCommand = vi.fn((cmd: string) => {
      sentCommands.push(cmd);
    });
  });

  afterEach(() => {
    inputManager.close();
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('should scale touch coordinates correctly and clamp out-of-bounds values', () => {
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

    // Out-of-bounds negative & overflow coordinates clamp to [0, width-1] / [0, height-1]
    sentCommands = [];
    inputManager.handleTouchEvent({
      action: 1,
      pointerId: 1,
      x: -50,
      y: 9999,
      screenWidth: 1280,
      screenHeight: 720,
    });
    expect(sentCommands[0]).toBe('mousemove 0 719');
  });

  it('should ignore touch events when screenWidth or screenHeight is <= 0', () => {
    inputManager.handleTouchEvent({
      action: 0,
      pointerId: 1,
      x: 100,
      y: 100,
      screenWidth: 0,
      screenHeight: 720,
    });
    expect(sentCommands).toEqual([]);
  });

  it('should handle tap cleanly with mouseup 1 without redundant duplicate click', () => {
    inputManager.handleTouchEvent({
      action: 0,
      pointerId: 1,
      x: 100,
      y: 200,
      screenWidth: 1280,
      screenHeight: 720,
    });

    sentCommands = [];

    inputManager.handleTouchEvent({
      action: 1, // UP
      pointerId: 1,
      x: 102,
      y: 201,
      screenWidth: 1280,
      screenHeight: 720,
    });

    expect(sentCommands).toEqual(['mousemove 102 201', 'mouseup 1']);
  });

  it('should release mouse button when entering vertical scroll mode', () => {
    inputManager.handleTouchEvent({
      action: 0,
      pointerId: 1,
      x: 500,
      y: 300,
      screenWidth: 1280,
      screenHeight: 720,
    });

    sentCommands = [];

    inputManager.handleTouchEvent({
      action: 2, // MOVE
      pointerId: 1,
      x: 500,
      y: 275,
      screenWidth: 1280,
      screenHeight: 720,
    });

    expect(sentCommands[0]).toBe('mouseup 1');
    expect(sentCommands.some((cmd) => cmd.startsWith('click 5'))).toBe(true);

    sentCommands = [];
    inputManager.handleTouchEvent({
      action: 1,
      pointerId: 1,
      x: 500,
      y: 275,
      screenWidth: 1280,
      screenHeight: 720,
    });
    expect(sentCommands).toEqual([]);
  });

  it('should safely ignore multi-touch actions in xdotool fallback', () => {
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

  it('should prioritize CdpTouchBridge over xdotool when CDP is connected', () => {
    const cdpBridge = (inputManager as any).cdpBridge;
    cdpBridge.isConnected = () => true;
    const sentCdp: any[] = [];
    cdpBridge.send = vi.fn((method: string, params: any) => {
      sentCdp.push({ method, params });
    });

    inputManager.handleTouchEvent({
      action: 0,
      pointerId: 1,
      x: 640,
      y: 360,
      screenWidth: 1280,
      screenHeight: 720,
    });

    expect(sentCdp).toHaveLength(1);
    expect(sentCdp[0].method).toBe('Input.dispatchTouchEvent');
    expect(sentCommands).toEqual([]);
  });

  it('should debounce rapid chatter DOWN in CdpTouchBridge and promote if dragged beyond slop', () => {
    const cdpBridge = (inputManager as any).cdpBridge;
    cdpBridge.isConnected = () => true;
    const sentCdp: any[] = [];
    cdpBridge.send = vi.fn((method: string, params: any) => {
      sentCdp.push({ method, params });
    });

    // 1. Initial Tap
    cdpBridge.handleTouch(0, 1, 100, 100);
    cdpBridge.handleTouch(1, 1, 100, 100);
    expect(sentCdp.map((m) => m.params.type)).toEqual(['touchStart', 'touchEnd']);
    expect(sentCdp.some((m) => m.method === 'Input.dispatchMouseEvent')).toBe(false);

    // 2. Rapid chatter DOWN within 80ms at <15px is suppressed
    sentCdp.length = 0;
    expect(cdpBridge.handleTouch(0, 1, 102, 101)).toBe(true);
    expect(sentCdp).toHaveLength(0);

    // 3. If user actually drags that debounced pointer >= 8px slop, promote to touchStart + touchMove!
    cdpBridge.handleTouch(2, 1, 103, 102); // < 8px -> still suppressed
    expect(sentCdp).toHaveLength(0);

    cdpBridge.handleTouch(2, 1, 100, 130); // 30px drag -> promoted!
    expect(sentCdp.map((m) => m.params.type)).toEqual(['touchStart', 'touchMove']);
  });

  it('should enforce 8px touch slop on MOVE and handle multi-touch POINTER_DOWN / POINTER_UP', () => {
    const cdpBridge = (inputManager as any).cdpBridge;
    cdpBridge.isConnected = () => true;
    const sentCdp: any[] = [];
    cdpBridge.send = vi.fn((method: string, params: any) => {
      sentCdp.push({ method, params });
    });

    // Finger 1 DOWN
    cdpBridge.handleTouch(0, 1, 200, 200);
    // Micro-jitter (< 8px) must NOT emit touchMove so Blink synthetic click stays intact
    cdpBridge.handleTouch(2, 1, 204, 203);
    expect(sentCdp.map((m) => m.params.type)).toEqual(['touchStart']);

    // Real drag (>= 8px) emits touchMove
    cdpBridge.handleTouch(2, 1, 220, 200);
    expect(sentCdp.map((m) => m.params.type)).toEqual(['touchStart', 'touchMove']);

    // Second finger joins (POINTER_DOWN = 5)
    sentCdp.length = 0;
    cdpBridge.handleTouch(5, 2, 400, 400);
    expect(sentCdp[0].params.type).toBe('touchStart');
    expect(sentCdp[0].params.touchPoints).toHaveLength(2);

    // Second finger lifts while finger 1 remains (POINTER_UP = 6 -> touchMove with remaining finger)
    sentCdp.length = 0;
    cdpBridge.handleTouch(6, 2, 400, 400);
    expect(sentCdp[0].params.type).toBe('touchMove');
    expect(sentCdp[0].params.touchPoints).toEqual([{ x: 220, y: 200, id: 1 }]);

    // Last finger lifts -> touchEnd
    sentCdp.length = 0;
    cdpBridge.handleTouch(1, 1, 220, 200);
    expect(sentCdp[0].params.type).toBe('touchEnd');
    expect(sentCdp[0].params.touchPoints).toEqual([]);
  });

  it('should ignore unpaired MOVE events and auto-prune stale touches (>2500ms)', () => {
    const cdpBridge = (inputManager as any).cdpBridge;
    cdpBridge.isConnected = () => true;
    const sentCdp: any[] = [];
    cdpBridge.send = vi.fn((method: string, params: any) => {
      sentCdp.push({ method, params });
    });

    // Unpaired hover MOVE ignored
    cdpBridge.handleTouch(2, 1, 300, 300);
    expect(sentCdp).toHaveLength(0);

    // Dangling touch older than 2500ms is auto-cancelled on next touch check
    let fakeNow = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);

    cdpBridge.handleTouch(0, 7, 150, 150);
    expect(sentCdp.map((m) => m.params.type)).toEqual(['touchStart']);

    sentCdp.length = 0;
    fakeNow = 4000; // +3000ms (> 2500ms STALE_TOUCH_TIMEOUT_MS)
    cdpBridge.handleTouch(2, 99, 300, 300); // triggers pruneStaleTouches
    expect(sentCdp.map((m) => m.params.type)).toEqual(['touchCancel']);
  });

  it('should auto-recover with touchCancel if a previous touch was left unclosed when a new primary DOWN arrives', () => {
    const cdpBridge = (inputManager as any).cdpBridge;
    cdpBridge.isConnected = () => true;
    const sentCdp: any[] = [];
    cdpBridge.send = vi.fn((method: string, params: any) => {
      sentCdp.push({ method, params });
    });

    cdpBridge.handleTouch(0, 10, 200, 200);
    sentCdp.length = 0;

    cdpBridge.handleTouch(0, 11, 400, 400);
    cdpBridge.handleTouch(1, 11, 400, 400);

    expect(sentCdp.map((c) => c.params.type)).toEqual(['touchCancel', 'touchStart', 'touchEnd']);
    expect(sentCdp[1].params.touchPoints).toEqual([{ x: 400, y: 400, id: 11 }]);
  });

  it('should route browser history/reload/fullscreen via CDP when connected and fallback to xdotool when disconnected', () => {
    const cdpBridge = (inputManager as any).cdpBridge;

    // 1. Disconnected -> xdotool keys
    cdpBridge.isConnected = () => false;
    inputManager.navigateBack();
    inputManager.navigateForward();
    inputManager.reloadPage();
    inputManager.toggleVideoFullscreen();
    inputManager.sendKey('Escape');
    expect(sentCommands).toEqual(['key alt+Left', 'key alt+Right', 'key ctrl+r', 'key f', 'key Escape']);

    // 2. Connected -> CDP commands, zero xdotool keys
    sentCommands = [];
    cdpBridge.isConnected = () => true;
    const sentCdp: string[] = [];
    cdpBridge.send = vi.fn((method: string) => sentCdp.push(method));

    inputManager.navigateBack();
    inputManager.navigateForward();
    inputManager.reloadPage();
    inputManager.toggleVideoFullscreen();

    expect(sentCommands).toEqual([]);
    expect(sentCdp).toEqual(['Runtime.evaluate', 'Runtime.evaluate', 'Page.reload', 'Runtime.evaluate']);
  });
});
