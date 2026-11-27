import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  DEFAULT_LOCALE,
  STREAM_EPOCH_INITIAL,
  TOUCH_ACTION,
  type TouchFrame,
} from "@tesroid/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserInputRouter,
  BrowserService,
  buildChromeLaunchArgs,
  buildChromeProcessEnv,
  buildCombinedPageInitScript,
  buildDisplayScaleScript,
  buildPulseAudioLaunchArgs,
  buildXvfbLaunchArgs,
  PROHIBITED_CHROME_FLAGS,
  sanitizeChromePreferences,
} from "../../src/domains/browser/index.js";
import { PowerService, PowerTimers } from "../../src/domains/power/index.js";
import type {
  PowerEncoderPort,
  PowerSessionPort,
  PowerStreamingPort,
} from "../../src/domains/power/ports.js";
import { SettingsService } from "../../src/domains/settings/settings-service.js";
import { NodeProcessTreeController, parseProcessListOutput } from "../../src/infra/process.js";
import {
  FakeAtomicJsonStore,
  FakeCdpClient,
  FakeClock,
  FakeProcessRunner,
} from "../helpers/fakes.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tesroid-p4-browser-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function makeTouchFrame(overrides: Partial<TouchFrame> = {}): TouchFrame {
  return {
    action: TOUCH_ACTION.DOWN,
    pointerId: 1n,
    x: 200,
    y: 200,
    screenWidth: 1280,
    screenHeight: 720,
    pressure: 1000,
    actionButton: 0,
    buttons: 1,
    ...overrides,
  };
}

interface SyntheticDomHarness {
  readonly context: vm.Context;
  readonly windowObj: {
    innerWidth: number;
    innerHeight: number;
    screen: { width: number; height: number; availWidth: number; availHeight: number };
  };
  readonly docObj: {
    cookie: string;
    fullscreenElement: unknown;
    fullscreenEnabled: boolean;
    documentElement: {
      style: { zoom: string };
      classList: Set<string> & { contains(c: string): boolean };
    };
    head: { children: unknown[]; appendChild(el: unknown): void };
    dispatchEvent(evt: unknown): boolean;
    exitFullscreen?: () => Promise<void>;
  };
  readonly playerElement: {
    classList: Set<string>;
    requestFullscreen?: () => Promise<void>;
  };
  readonly videoElement: {
    muted: boolean;
    volume: number;
    removedAttributes: string[];
    removeAttribute(attr: string): void;
  };
  readonly ytPlayer: {
    unMuteCalls: number;
    lastVolume: number | null;
    unMute(): void;
    setVolume(v: number): void;
  };
  readonly passthroughCalls: unknown[];
  readonly dispatchedEvents: string[];
  triggerDocumentEvent(eventName: string): void;
  advanceIntervals(ms: number): void;
}

function createSyntheticDomHarness(options?: {
  hostname?: string;
  includeVideo?: boolean;
}): SyntheticDomHarness {
  const clock = new FakeClock();
  const docListeners = new Map<string, ((evt: unknown) => void)[]>();
  const dispatchedEvents: string[] = [];
  const passthroughCalls: unknown[] = [];

  class FakeClassList extends Set<string> {
    contains(token: string): boolean {
      return this.has(token);
    }
    remove(token: string): void {
      this.delete(token);
    }
  }
  class FakeElement {}
  class FakeDocument {}
  class FakeEvent {
    readonly type: string;
    constructor(type: string) {
      this.type = type;
    }
  }

  const headChildren: unknown[] = [];
  const docElementClassList = new FakeClassList();
  const playerElement = Object.assign(new FakeElement(), {
    classList: new FakeClassList(),
  });
  const videoElement = Object.assign(new FakeElement(), {
    muted: true,
    volume: 0.25,
    removedAttributes: [] as string[],
    removeAttribute(attr: string): void {
      this.removedAttributes.push(attr);
    },
  });
  const ytPlayer = {
    unMuteCalls: 0,
    lastVolume: null as number | null,
    unMute(): void {
      this.unMuteCalls += 1;
    },
    setVolume(v: number): void {
      this.lastVolume = v;
    },
  };

  const includeVideo = options?.includeVideo ?? true;

  const cookies: string[] = [];
  const docObj = Object.assign(new FakeDocument(), {
    cookie: "",
    fullscreenElement: null as unknown,
    fullscreenEnabled: false,
    documentElement: {
      style: { zoom: "" },
      classList: docElementClassList,
    },
    head: {
      children: headChildren,
      appendChild(el: unknown): void {
        headChildren.push(el);
      },
    },
    getElementById(id: string): unknown {
      return headChildren.find((item) => (item as { id?: string }).id === id) ?? null;
    },
    createElement(tag: string): unknown {
      return { tagName: tag.toUpperCase(), id: "", textContent: "" };
    },
    querySelector(selector: string): unknown {
      if (!includeVideo) {
        return null;
      }
      if (selector === ".html5-video-player") {
        return playerElement;
      }
      if (selector === "video") {
        return videoElement;
      }
      if (selector === "#movie_player") {
        return ytPlayer;
      }
      return null;
    },
    querySelectorAll(selector: string): unknown[] {
      if (!includeVideo || !selector.includes("video")) {
        return [];
      }
      return [videoElement];
    },
    addEventListener(type: string, listener: (evt: unknown) => void): void {
      const list = docListeners.get(type) ?? [];
      list.push(listener);
      docListeners.set(type, list);
    },
    dispatchEvent(evt: unknown): boolean {
      const type = (evt as { type?: string }).type ?? "";
      dispatchedEvents.push(type);
      return true;
    },
  });

  Object.defineProperty(docObj, "cookie", {
    get(): string {
      return cookies.join("; ");
    },
    set(value: string) {
      const pair = value.split(";")[0]?.trim() ?? "";
      if (pair.length > 0) {
        cookies.push(pair);
      }
    },
    configurable: true,
  });

  const windowObj = {
    innerWidth: 1184,
    innerHeight: 848,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1080,
    },
  };

  const PublicKeyCredentialMock = {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    isConditionalMediationAvailable: async () => true,
  };

  const navigatorMock = {
    credentials: {
      get: async (opts: unknown) => {
        passthroughCalls.push(["get", opts]);
        return { id: "password-cred" };
      },
      create: async (opts: unknown) => {
        passthroughCalls.push(["create", opts]);
        return { id: "created-cred" };
      },
    },
  };

  const sandbox: Record<string, unknown> = {
    window: windowObj,
    document: docObj,
    screen: windowObj.screen,
    location: { hostname: options?.hostname ?? "www.youtube.com" },
    navigator: navigatorMock,
    PublicKeyCredential: PublicKeyCredentialMock,
    Element: FakeElement,
    Document: FakeDocument,
    Event: FakeEvent,
    setInterval: (cb: () => void, ms: number) => clock.setInterval(cb, ms),
    clearInterval: (h: ReturnType<FakeClock["setInterval"]>) => clock.clearInterval(h),
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  return {
    context,
    windowObj,
    docObj,
    playerElement,
    videoElement,
    ytPlayer,
    passthroughCalls,
    dispatchedEvents,
    triggerDocumentEvent: (eventName: string) => {
      for (const listener of docListeners.get(eventName) ?? []) {
        listener(new FakeEvent(eventName));
      }
    },
    advanceIntervals: (ms: number) => {
      clock.advanceByMs(ms);
    },
  };
}

describe("server/domains/browser (Spec 06)", () => {
  it("AC-01: builds Chrome/Xvfb/PulseAudio args and env without prohibited GPU flags, resolves home URL, cleans locks, and auto-restarts on crash", async () => {
    const userDataDir = await makeTempDir();
    await fs.writeFile(path.join(userDataDir, "SingletonLock"), "stale", "utf8");
    await fs.writeFile(path.join(userDataDir, "SingletonSocket"), "stale", "utf8");
    await fs.writeFile(path.join(userDataDir, "SingletonCookie"), "stale", "utf8");

    const args = buildChromeLaunchArgs({
      display: ":99",
      locale: "",
      timezone: "Asia/Tokyo",
      userDataDir,
      pulseSocketPath: "/tmp/pulse-socket",
      cdpPort: 9222,
      initialUrl: "https://tver.jp",
      viewport: { width: 1280, height: 720 },
    });

    for (const prohibited of PROHIBITED_CHROME_FLAGS) {
      expect(args).not.toContain(prohibited);
    }
    expect(args).toContain("--app=https://tver.jp");
    expect(args).toContain(`--lang=${DEFAULT_LOCALE}`);
    expect(args).toContain("--password-store=basic");
    expect(args).toContain("--disable-gpu-rasterization");
    expect(args).toContain("--enable-accelerated-video-decode");
    expect(args.some((arg) => arg.includes("VaapiVideoDecoder"))).toBe(true);
    expect(args.some((arg) => arg.includes("Dav1dVideoDecoder"))).toBe(true);
    expect(() =>
      buildChromeLaunchArgs({
        display: ":99",
        locale: "ja-JP",
        timezone: "Asia/Tokyo",
        userDataDir,
        pulseSocketPath: "/tmp/pulse-socket",
        cdpPort: 9222,
        initialUrl: "file:///etc/passwd",
        viewport: { width: 1280, height: 720 },
      }),
    ).toThrow();

    expect(buildXvfbLaunchArgs(":99")).toEqual([
      ":99",
      "-screen",
      "0",
      "1920x1080x24",
      "+extension",
      "GLX",
      "+extension",
      "RANDR",
      "+extension",
      "RENDER",
      "-noreset",
      "-nolisten",
      "tcp",
    ]);
    expect(buildPulseAudioLaunchArgs()).toEqual([
      "--daemonize=no",
      "--exit-idle-time=-1",
      "--disallow-exit",
      "--disable-shm",
      "--flat-volumes=no",
      "-n",
      "-F",
      "/etc/pulse/tesroid.pa",
    ]);

    const chromeEnv = buildChromeProcessEnv(
      {
        PATH: "/usr/bin",
        GALLIUM_DRIVER: "d3d12",
        TUNNEL_TOKEN: "secret-token",
      },
      "",
      "",
      ":99",
      "/tmp/pulse-socket",
    );
    expect(chromeEnv.GALLIUM_DRIVER).toBeUndefined();
    expect(chromeEnv.TUNNEL_TOKEN).toBeUndefined();
    expect(chromeEnv.LIBVA_DRIVER_NAME).toBeUndefined();
    expect(chromeEnv.PULSE_SERVER).toBe("unix:/tmp/pulse-socket");
    expect(chromeEnv.LANG).toBe("ja_JP.UTF-8");
    expect(chromeEnv.TZ).toBe("Asia/Tokyo");

    const clock = new FakeClock();
    const jsonStore = new FakeAtomicJsonStore();
    const settings = new SettingsService({
      store: jsonStore,
      filePath: path.join(userDataDir, "settings.json"),
    });
    await settings.load();

    const processRunner = new FakeProcessRunner();
    const processTree = new NodeProcessTreeController({ processRunner });
    const cdp = new FakeCdpClient();
    const inputRouter = new BrowserInputRouter({ clock, cdp });
    const service = new BrowserService({
      clock,
      settings,
      processRunner,
      processTree,
      cdp,
      inputRouter,
      config: {
        display: ":99",
        locale: "ja-JP",
        userDataDir,
        pulseSocketPath: "/tmp/pulse-socket",
        cdpPort: 9222,
        viewport: { width: 1280, height: 720 },
      },
    });

    await service.start();
    expect(processRunner.spawnCalls.map((call) => call.command)).toEqual([
      "pulseaudio",
      "Xvfb",
      "openbox",
      "google-chrome",
    ]);
    expect(processRunner.execCalls[0]?.command).toBe("pactl");
    expect(cdp.connectedPort).toBe(9222);

    await expect(fs.access(path.join(userDataDir, "SingletonLock"))).rejects.toThrow();
    await expect(fs.access(path.join(userDataDir, "SingletonSocket"))).rejects.toThrow();
    await expect(fs.access(path.join(userDataDir, "SingletonCookie"))).rejects.toThrow();

    const chromeProc = processRunner.spawnedProcesses[3];
    chromeProc?.emitExit(1);
    clock.advanceByMs(1_999);
    expect(processRunner.spawnCalls).toHaveLength(4);

    clock.advanceByMs(1);
    await vi.waitFor(() => {
      expect(processRunner.spawnCalls).toHaveLength(5);
    });
    expect(processRunner.spawnCalls[4]?.command).toBe("google-chrome");

    await service.stop();
  });

  it("AC-02: injects CDP native touch with 8px slop, 80ms/15px debounce (promoting >8px drag), 2,500ms cancel, residual reset, and safely drops inputs when CDP disconnected", async () => {
    const clock = new FakeClock();
    const cdp = new FakeCdpClient();
    const dropped: { kind: string; reason: string }[] = [];
    const router = new BrowserInputRouter({
      clock,
      cdp,
      onDroppedInput: (kind, reason) => {
        dropped.push({ kind, reason });
      },
    });

    // Disconnected CDP safely drops without throwing.
    await router.dispatchTouch(makeTouchFrame({ action: TOUCH_ACTION.DOWN }));
    await router.dispatchText("hello");
    await router.dispatchKey("Enter");
    expect(cdp.touchEvents).toEqual([]);
    expect(cdp.insertedTexts).toEqual([]);
    expect(cdp.dispatchedKeys).toEqual([]);
    expect(dropped).toEqual([
      { kind: "touch", reason: "cdp_disconnected" },
      { kind: "text", reason: "cdp_disconnected" },
      { kind: "key", reason: "cdp_disconnected" },
    ]);

    await cdp.connect(9222);

    // Invalid/non-positive screen dims are safely ignored.
    await router.dispatchTouch(makeTouchFrame({ screenWidth: 0, screenHeight: 720 }));
    await router.dispatchTouch(makeTouchFrame({ screenWidth: 1280, screenHeight: -10 }));
    expect(cdp.touchEvents).toEqual([]);

    // Tap + 8px slop suppression + tap up + 80ms/15px chatter debounce suppression.
    await router.dispatchTouch(makeTouchFrame({ action: TOUCH_ACTION.DOWN, x: 100, y: 100 }));
    await router.dispatchTouch(makeTouchFrame({ action: TOUCH_ACTION.MOVE, x: 105, y: 103 }));
    await router.dispatchTouch(makeTouchFrame({ action: TOUCH_ACTION.UP, x: 105, y: 103 }));
    expect(cdp.touchEvents.map((e) => e.type)).toEqual(["touchStart", "touchEnd"]);

    clock.advanceByMs(40);
    await router.dispatchTouch(makeTouchFrame({ action: TOUCH_ACTION.DOWN, x: 110, y: 105 }));
    expect(cdp.touchEvents).toHaveLength(2);
    await router.dispatchTouch(makeTouchFrame({ action: TOUCH_ACTION.UP, x: 110, y: 105 }));
    expect(cdp.touchEvents).toHaveLength(2);

    // Debounced touch promoted immediately to touchStart + touchMove when dragged > 8px.
    clock.advanceByMs(30);
    await router.dispatchTouch(makeTouchFrame({ action: TOUCH_ACTION.DOWN, x: 108, y: 108 }));
    expect(cdp.touchEvents).toHaveLength(2);
    await router.dispatchTouch(makeTouchFrame({ action: TOUCH_ACTION.MOVE, x: 130, y: 108 }));
    expect(cdp.touchEvents.slice(2).map((e) => e.type)).toEqual(["touchStart", "touchMove"]);

    // Multi-touch POINTER_DOWN / POINTER_UP.
    await router.dispatchTouch(
      makeTouchFrame({ action: TOUCH_ACTION.POINTER_DOWN, pointerId: 2n, x: 300, y: 300 }),
    );
    expect(cdp.touchEvents.at(-1)?.type).toBe("touchStart");
    expect(cdp.touchEvents.at(-1)?.touchPoints).toHaveLength(2);
    await router.dispatchTouch(
      makeTouchFrame({ action: TOUCH_ACTION.POINTER_UP, pointerId: 2n, x: 300, y: 300 }),
    );
    expect(cdp.touchEvents.at(-1)?.type).toBe("touchEnd");
    expect(cdp.touchEvents.at(-1)?.touchPoints).toHaveLength(1);

    // Residual touch auto-reset on new DOWN.
    await router.dispatchTouch(
      makeTouchFrame({ action: TOUCH_ACTION.DOWN, pointerId: 3n, x: 400, y: 400 }),
    );
    expect(cdp.touchEvents.slice(-2).map((e) => e.type)).toEqual(["touchCancel", "touchStart"]);

    // 2,500ms stuck touch auto-cancel.
    clock.advanceByMs(2_500);
    await Promise.resolve();
    expect(cdp.touchEvents.at(-1)).toEqual({ type: "touchCancel", touchPoints: [] });

    // Text and special keys resume after CDP connection.
    await router.dispatchText("Tesroid");
    await router.dispatchKey("Enter");
    expect(cdp.insertedTexts).toEqual(["Tesroid"]);
    expect(cdp.dispatchedKeys).toEqual(["Enter"]);

    // BrowserService navigation rejection & CDP-disconnect tolerance.
    const dir = await makeTempDir();
    const settings = new SettingsService({
      store: new FakeAtomicJsonStore(),
      filePath: path.join(dir, "settings.json"),
    });
    await settings.load();
    const processRunner = new FakeProcessRunner();
    const service = new BrowserService({
      clock,
      settings,
      processRunner,
      processTree: new NodeProcessTreeController({ processRunner }),
      cdp,
      inputRouter: router,
      config: {
        display: ":99",
        locale: "ja-JP",
        userDataDir: dir,
        pulseSocketPath: "/tmp/pulse-socket",
        cdpPort: 9222,
        viewport: { width: 1280, height: 720 },
      },
    });

    await expect(service.navigate("javascript:alert(1)")).rejects.toThrow();
    await expect(service.navigate("chrome://settings")).rejects.toThrow();
    await cdp.disconnect();
    await service.navigate("https://example.com");
    await service.goBack();
    await service.goForward();
    await service.reload();
    await service.toggleFullscreen();
    expect(cdp.navigatedUrls).toEqual([]);

    await cdp.connect(9222);
    await service.navigate("https://example.com");
    await service.goBack();
    expect(cdp.navigatedUrls).toEqual(["https://example.com"]);
    expect(cdp.backCount).toBe(1);
  });

  it("AC-03: single init script suppresses WebAuthn (NotAllowedError on publicKey, passthrough otherwise, idempotent) and sanitizes Chrome Preferences", async () => {
    const harness = createSyntheticDomHarness();
    const script = buildCombinedPageInitScript({ displayScale: 100 });
    vm.runInContext(script, harness.context);
    // Re-inject to guarantee idempotency without infinite recursion.
    vm.runInContext(script, harness.context);

    const pkc = harness.context.PublicKeyCredential as {
      isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean>;
      isConditionalMediationAvailable(): Promise<boolean>;
    };
    expect(await pkc.isUserVerifyingPlatformAuthenticatorAvailable()).toBe(false);
    expect(await pkc.isConditionalMediationAvailable()).toBe(false);

    const creds = (
      harness.context.navigator as {
        credentials: {
          get(opts: unknown): Promise<unknown>;
          create(opts: unknown): Promise<unknown>;
        };
      }
    ).credentials;

    await expect(
      creds.get({ publicKey: { challenge: new Uint8Array([1]) } }),
    ).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    await expect(
      creds.create({ publicKey: { challenge: new Uint8Array([2]) } }),
    ).rejects.toMatchObject({
      name: "NotAllowedError",
    });

    const passthroughGet = await creds.get({ password: true });
    expect(passthroughGet).toEqual({ id: "password-cred" });
    expect(harness.passthroughCalls).toEqual([["get", { password: true }]]);

    const repaired = sanitizeChromePreferences(
      JSON.stringify({
        profile: {
          name: "Person 1",
          exit_type: "Crashed",
          exited_cleanly: false,
        },
        custom_key: "preserved",
      }),
    );
    const parsed = JSON.parse(repaired.rawJson) as Record<string, unknown>;
    expect(parsed.custom_key).toBe("preserved");
    expect(parsed.credentials_enable_service).toBe(false);
    expect(parsed.credentials_enable_autosignin).toBe(false);
    expect(parsed.autofill).toEqual({
      enabled: false,
      profile_enabled: false,
      credit_card_enabled: false,
    });
    expect(parsed.translate).toEqual({ enabled: false });
    expect(parsed.profile).toEqual({
      name: "Person 1",
      exit_type: "Normal",
      exited_cleanly: true,
      password_manager_enabled: false,
      password_manager_leak_detection: false,
    });
  });

  it("AC-04: clamps displayScale [50, 250]% (default 100%), enforces virtual Web fullscreen & 100% volume lock, and pauses 3s URL monitoring during freeze", async () => {
    // 1) Virtual fullscreen, zoom clamping, screen dims, YouTube cookies, volume lock.
    const ytHarness = createSyntheticDomHarness({ hostname: "www.youtube.com" });
    vm.runInContext(buildCombinedPageInitScript({ displayScale: 400 }), ytHarness.context);
    expect(ytHarness.docObj.documentElement.style.zoom).toBe("2.5");
    expect(ytHarness.windowObj.screen.width).toBe(1184);
    expect(ytHarness.windowObj.screen.height).toBe(848);
    expect(ytHarness.docObj.cookie).toContain("wide=1");
    expect(ytHarness.docObj.cookie).toContain("PREF=f6=400");

    // Default fallback on invalid scale.
    vm.runInContext(buildDisplayScaleScript(Number.NaN), ytHarness.context);
    expect(ytHarness.docObj.documentElement.style.zoom).toBe("1");
    vm.runInContext(buildDisplayScaleScript(150), ytHarness.context);
    expect(ytHarness.docObj.documentElement.style.zoom).toBe("1.5");

    // Enter virtual fullscreen -> zoom locked to 100% ("1"), exit restores 150%.
    await ytHarness.playerElement.requestFullscreen?.();
    expect(ytHarness.docObj.fullscreenElement).toBe(ytHarness.playerElement);
    expect(ytHarness.docObj.documentElement.style.zoom).toBe("1");
    expect(ytHarness.dispatchedEvents).toContain("fullscreenchange");

    await ytHarness.docObj.exitFullscreen?.();
    expect(ytHarness.docObj.fullscreenElement).toBeNull();
    expect(ytHarness.docObj.documentElement.style.zoom).toBe("1.5");

    // Volume lock enforced initially, on volumechange, and on 2s interval.
    expect(ytHarness.videoElement.muted).toBe(false);
    expect(ytHarness.videoElement.volume).toBe(1);
    expect(ytHarness.ytPlayer.unMuteCalls).toBe(1);
    expect(ytHarness.ytPlayer.lastVolume).toBe(100);

    ytHarness.videoElement.muted = true;
    ytHarness.videoElement.volume = 0.1;
    ytHarness.triggerDocumentEvent("volumechange");
    expect(ytHarness.videoElement.muted).toBe(false);
    expect(ytHarness.videoElement.volume).toBe(1);

    ytHarness.videoElement.muted = true;
    ytHarness.advanceIntervals(2_000);
    expect(ytHarness.videoElement.muted).toBe(false);
    expect(ytHarness.videoElement.volume).toBe(1);

    // No-op when page has no video element.
    const emptyHarness = createSyntheticDomHarness({
      hostname: "example.com",
      includeVideo: false,
    });
    vm.runInContext(buildCombinedPageInitScript({ displayScale: 100 }), emptyHarness.context);
    const toggleFn = emptyHarness.context.__tesroidToggleFullscreen as () => boolean;
    expect(toggleFn()).toBe(false);

    // 2) URL monitoring (3s interval, filters non-HTTP/HTTPS, stops when paused).
    const dir = await makeTempDir();
    const clock = new FakeClock();
    const settings = new SettingsService({
      store: new FakeAtomicJsonStore(),
      filePath: path.join(dir, "settings.json"),
    });
    await settings.load();
    const processRunner = new FakeProcessRunner();
    const cdp = new FakeCdpClient();
    const pageUpdates: { url: string | null; title: string | null }[] = [];
    const service = new BrowserService({
      clock,
      settings,
      processRunner,
      processTree: new NodeProcessTreeController({ processRunner }),
      cdp,
      inputRouter: new BrowserInputRouter({ clock, cdp }),
      config: {
        display: ":99",
        locale: "ja-JP",
        userDataDir: dir,
        pulseSocketPath: "/tmp/pulse-socket",
        cdpPort: 9222,
        viewport: { width: 1280, height: 720 },
      },
      onPageInfoChanged: (info) => {
        pageUpdates.push(info);
      },
    });

    await service.start();
    expect(service.getCurrentPageInfo()).toEqual({
      url: "https://www.youtube.com",
      title: "YouTube",
    });

    cdp.pageInfo = { url: "chrome://newtab", title: "Unsafe" };
    clock.advanceByMs(3_000);
    await Promise.resolve();
    expect(service.getCurrentPageInfo().url).toBe("https://www.youtube.com");

    const callsBeforePause = cdp.getPageInfoCalls;
    service.setMonitoringPaused(true);
    clock.advanceByMs(9_000);
    await Promise.resolve();
    expect(cdp.getPageInfoCalls).toBe(callsBeforePause);

    await service.setDisplayScale(10);
    expect(cdp.evaluatedExpressions.at(-1)).toContain("50");
    await service.stop();
  });

  it("AC-05: freezes process tree bottom-up (SIGSTOP), resumes top-down (SIGCONT), guards PPID cycles, and integrates with PowerService", async () => {
    // 1) Process listing parser (including 15-char Linux comm truncation) and cycle guard.
    const parsed = parseProcessListOutput(
      "  100     1 chrome\n  101   100 chrome_zygote_1\n  102   101 renderer_proc_1\n",
    );
    expect(parsed).toEqual([
      { pid: 100, ppid: 1, command: "chrome" },
      { pid: 101, ppid: 100, command: "chrome_zygote_1" },
      { pid: 102, ppid: 101, command: "renderer_proc_1" },
    ]);

    const runner = new FakeProcessRunner();
    runner.processList = [
      { pid: 100, ppid: 102, command: "chrome" },
      { pid: 101, ppid: 100, command: "zygote" },
      { pid: 102, ppid: 101, command: "renderer" },
      { pid: 103, ppid: 101, command: "gpu" },
    ];
    runner.deadPids.add(103);

    const tree = new NodeProcessTreeController({ processRunner: runner });
    expect(await tree.collectDescendants(100)).toEqual([101, 102, 103]);

    await tree.freezeTree(100);
    expect(runner.signalCalls.slice(0, 4)).toEqual([
      { pid: 103, signal: "SIGSTOP" },
      { pid: 102, signal: "SIGSTOP" },
      { pid: 101, signal: "SIGSTOP" },
      { pid: 100, signal: "SIGSTOP" },
    ]);

    runner.signalCalls.length = 0;
    await tree.resumeTree(100);
    expect(runner.signalCalls).toEqual([
      { pid: 100, signal: "SIGCONT" },
      { pid: 101, signal: "SIGCONT" },
      { pid: 102, signal: "SIGCONT" },
      { pid: 103, signal: "SIGCONT" },
    ]);

    // 2) Boundary integration: PowerService <-> BrowserService <-> NodeProcessTreeController.
    const dir = await makeTempDir();
    const clock = new FakeClock();
    const settings = new SettingsService({
      store: new FakeAtomicJsonStore(),
      filePath: path.join(dir, "settings.json"),
    });
    await settings.load();

    const intRunner = new FakeProcessRunner();
    const intTree = new NodeProcessTreeController({ processRunner: intRunner });
    const intCdp = new FakeCdpClient();
    const intRouter = new BrowserInputRouter({ clock, cdp: intCdp });
    const browser = new BrowserService({
      clock,
      settings,
      processRunner: intRunner,
      processTree: intTree,
      cdp: intCdp,
      inputRouter: intRouter,
      config: {
        display: ":99",
        locale: "ja-JP",
        userDataDir: dir,
        pulseSocketPath: "/tmp/pulse-socket",
        cdpPort: 9222,
        viewport: { width: 1280, height: 720 },
      },
    });

    let epoch = STREAM_EPOCH_INITIAL;
    const encoderPort: PowerEncoderPort = {
      ensureDualRunning: async () => {},
      stopAll: async () => {},
      advanceEpochAndResetClock: () => {
        epoch += 1;
        return epoch;
      },
      pauseWithTimelineComp: async () => {},
      clearTimelineComp: () => {},
      getCurrentEpoch: () => epoch,
    };
    const streamingPort: PowerStreamingPort = {
      clearBufferAndQueues: () => {},
      broadcastPowerState: () => {},
      onPowerActive: () => {},
      onPowerSleep: () => {},
      onPowerHoldEntered: () => {},
      onPowerHoldExited: () => {},
    };
    const sessionPort: PowerSessionPort = {
      hasActivePrimaryOrActing: () => true,
      demoteAllStreamingToStandby: () => {},
      promoteStandbyToStreaming: () => {},
      clearPrimaryFeedback: () => {},
    };

    let powerRef: PowerService | undefined;
    const timers = new PowerTimers({
      clock,
      onAutoSleepExpired: () => {
        void powerRef?.handleAutoSleepExpired();
      },
      onHoldExpired: () => {
        void powerRef?.handleHoldExpired();
      },
    });
    const power = new PowerService({
      clock,
      settings,
      browser,
      encoder: encoderPort,
      streaming: streamingPort,
      session: sessionPort,
      timers,
      holdExpireMinutes: 10,
    });
    powerRef = power;

    const active = await power.ensureActive();
    expect(active.state).toBe("ACTIVE");
    const chromePid = intRunner.spawnedProcesses[3]?.pid ?? 0;
    expect(chromePid).toBeGreaterThan(0);

    intRunner.processList = [
      { pid: chromePid, ppid: 1, command: "chrome" },
      { pid: chromePid + 1, ppid: chromePid, command: "chrome-zygote" },
      { pid: chromePid + 2, ppid: chromePid + 1, command: "chrome-renderer" },
    ];

    await power.enterBufferHold();
    expect(intRunner.signalCalls).toEqual([
      { pid: chromePid + 2, signal: "SIGSTOP" },
      { pid: chromePid + 1, signal: "SIGSTOP" },
      { pid: chromePid, signal: "SIGSTOP" },
    ]);

    const callsWhileFrozen = intCdp.getPageInfoCalls;
    clock.advanceByMs(6_000);
    await Promise.resolve();
    expect(intCdp.getPageInfoCalls).toBe(callsWhileFrozen);

    intRunner.signalCalls.length = 0;
    await power.exitBufferHold("DRAINED");
    expect(intRunner.signalCalls).toEqual([
      { pid: chromePid, signal: "SIGCONT" },
      { pid: chromePid + 1, signal: "SIGCONT" },
      { pid: chromePid + 2, signal: "SIGCONT" },
    ]);

    clock.advanceByMs(3_000);
    await Promise.resolve();
    expect(intCdp.getPageInfoCalls).toBeGreaterThan(callsWhileFrozen);

    await power.sleep();
    expect(power.getStatus().state).toBe("SLEEP_PAUSED");

    const restarted = await power.restartBrowser();
    expect(restarted.state).toBe("ACTIVE");
    expect(intRunner.terminatedProcesses.length).toBeGreaterThanOrEqual(1);

    await browser.stop();
    power.dispose();
  });
});
