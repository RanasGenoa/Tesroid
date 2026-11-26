import {
  AUDIO_FLAG,
  DEFAULT_STREAM_SETTINGS,
  type EncoderMode,
  STREAM_EPOCH_INITIAL,
  VIDEO_FLAG,
} from "@tesroid/shared";
import { describe, expect, it } from "vitest";
import {
  buildAudioFfmpegArgs,
  buildEncoderProcessEnv,
  buildVideoFfmpegArgs,
  computeNextFallbackStep,
  detectBestEncoderBackend,
  ENCODER_RETRY_BACKOFF_MS,
  ENCODER_WATCHDOG_CONSTANTS,
  type EncodedMediaPacket,
  EncoderService,
  getEncoderRetryDelayMs,
  H264AvccParser,
  isNvidiaVisibleFromEnv,
  OggOpusParser,
  parseVainfoSupportsH264Encode,
} from "../../src/domains/encoder/index.js";
import { SettingsService } from "../../src/domains/settings/settings-service.js";
import {
  FakeAtomicJsonStore,
  FakeClock,
  FakeGpuHardwareProbe,
  FakeProcessRunner,
} from "../helpers/fakes.js";

function makeAnnexBNal(startCode: readonly number[], nalBytes: readonly number[]): Uint8Array {
  return new Uint8Array([...startCode, ...nalBytes]);
}

function concatArrays(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function buildOggPage(
  segments: readonly Uint8Array[],
  options?: { continued?: boolean; lacingOverride?: readonly number[] },
): Uint8Array {
  const lacing = options?.lacingOverride ?? segments.map((s) => s.byteLength);
  let bodyLength = 0;
  for (const seg of segments) {
    bodyLength += seg.byteLength;
  }
  const headerLength = 27 + lacing.length;
  const out = new Uint8Array(headerLength + bodyLength);
  out.set([0x4f, 0x67, 0x67, 0x53], 0);
  out[4] = 0;
  out[5] = options?.continued ? 0x01 : 0x00;
  out[26] = lacing.length;
  for (let i = 0; i < lacing.length; i += 1) {
    out[27 + i] = lacing[i] ?? 0;
  }
  let offset = headerLength;
  for (const seg of segments) {
    out.set(seg, offset);
    offset += seg.byteLength;
  }
  return out;
}

function makeOpusHead(length = 19): Uint8Array {
  const head = new Uint8Array(length);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
  if (length >= 19) {
    head[8] = 1;
    head[9] = 2;
  }
  return head;
}

function makeOpusTags(): Uint8Array {
  return new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73, 0, 0, 0, 0]);
}

function mustItem<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Expected defined ${label}`);
  }
  return value;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function createEncoderHarness(options?: {
  mode?: EncoderMode;
  probe?: FakeGpuHardwareProbe;
  explicitVaapiDevice?: string | null;
  explicitVaapiDriver?: string | null;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}) {
  const clock = new FakeClock(1_700_000_000_000);
  const store = new FakeAtomicJsonStore();
  const settings = new SettingsService({
    store,
    filePath: "/data/settings.json",
  });
  await settings.load();

  const processRunner = new FakeProcessRunner();
  const gpuProbe = options?.probe ?? new FakeGpuHardwareProbe();
  const packets: EncodedMediaPacket[] = [];

  const service = new EncoderService({
    clock,
    settings,
    processRunner,
    gpuProbe,
    mode: options?.mode ?? "auto",
    display: ":99",
    pulseSocketPath: "/tmp/pulse-native",
    explicitVaapiDevice: options?.explicitVaapiDevice ?? null,
    explicitVaapiDriver: options?.explicitVaapiDriver ?? null,
    baseEnv: options?.baseEnv ?? { PATH: "/usr/bin" },
  });
  service.subscribePackets((pkt) => {
    packets.push(pkt);
  });

  return { clock, settings, processRunner, gpuProbe, service, packets };
}

describe("server/domains/encoder (Spec 05)", () => {
  it("AC-01: prioritizes NVENC -> AMD radeonsi -> Intel iHD/i965 -> WSL2 d3d12 -> libx264 in auto mode and honors fixed ENCODER_MODE=nvenc/vaapi without fallback to software", async () => {
    expect(
      parseVainfoSupportsH264Encode(
        "VAProfileH264High : VAEntrypointVLD\nVAProfileH264Main : VAEntrypointEncSlice\n",
      ),
    ).toBe(true);
    expect(
      parseVainfoSupportsH264Encode(
        "VAProfileH264High : VAEntrypointVLD\nVAProfileHEVCMain : VAEntrypointEncSlice\n",
      ),
    ).toBe(false);
    expect(isNvidiaVisibleFromEnv({ NVIDIA_VISIBLE_DEVICES: "all" })).toBe(true);
    expect(isNvidiaVisibleFromEnv({ NVIDIA_VISIBLE_DEVICES: "none" })).toBe(false);
    expect(isNvidiaVisibleFromEnv({ NVIDIA_VISIBLE_DEVICES: "void" })).toBe(false);
    expect(isNvidiaVisibleFromEnv({})).toBe(false);

    const d3d12Env = buildEncoderProcessEnv(
      { PATH: "/usr/bin", TUNNEL_TOKEN: "secret" },
      "d3d12",
      "/tmp/pulse.sock",
    );
    expect(d3d12Env.LIBVA_DRIVER_NAME).toBe("d3d12");
    expect(d3d12Env.GALLIUM_DRIVER).toBe("d3d12");
    expect(d3d12Env.TUNNEL_TOKEN).toBeUndefined();
    expect(d3d12Env.PULSE_SERVER).toBe("unix:/tmp/pulse.sock");

    const radeonsiEnv = buildEncoderProcessEnv(
      { PATH: "/usr/bin", GALLIUM_DRIVER: "d3d12" },
      "radeonsi",
      "/tmp/pulse.sock",
    );
    expect(radeonsiEnv.LIBVA_DRIVER_NAME).toBe("radeonsi");
    expect(radeonsiEnv.GALLIUM_DRIVER).toBeUndefined();

    const noDriverEnv = buildEncoderProcessEnv(
      { PATH: "/usr/bin", GALLIUM_DRIVER: "d3d12" },
      null,
      "/tmp/pulse.sock",
    );
    expect(noDriverEnv.LIBVA_DRIVER_NAME).toBeUndefined();
    expect(noDriverEnv.GALLIUM_DRIVER).toBeUndefined();

    const nvencProbe = new FakeGpuHardwareProbe();
    nvencProbe.nvidiaDevice = true;
    nvencProbe.nvencAvailable = true;
    nvencProbe.driRenderNodes = [
      { path: "/dev/dri/renderD128", vendorId: "0x1002" },
      { path: "/dev/dri/renderD129", vendorId: "0x8086" },
    ];
    nvencProbe.vaapiProbeHandler = () => true;
    expect(await detectBestEncoderBackend("auto", nvencProbe, null, null)).toMatchObject({
      backend: "nvenc",
      vaapiDevice: null,
      vaapiDriver: null,
    });

    const amdProbe = new FakeGpuHardwareProbe();
    amdProbe.nvidiaDevice = true;
    amdProbe.nvencAvailable = false;
    amdProbe.driRenderNodes = [
      { path: "/dev/dri/renderD128", vendorId: "0x8086" },
      { path: "/dev/dri/renderD129", vendorId: "0x1002" },
    ];
    amdProbe.vaapiProbeHandler = () => true;
    expect(await detectBestEncoderBackend("auto", amdProbe, null, null)).toMatchObject({
      backend: "vaapi",
      vaapiDevice: "/dev/dri/renderD129",
      vaapiDriver: "radeonsi",
    });

    const intelProbe = new FakeGpuHardwareProbe();
    intelProbe.driRenderNodes = [{ path: "/dev/dri/renderD128", vendorId: "0x8086" }];
    intelProbe.vaapiProbeHandler = (_dev, driver) => driver === "i965";
    expect(await detectBestEncoderBackend("auto", intelProbe, null, null)).toMatchObject({
      backend: "vaapi",
      vaapiDevice: "/dev/dri/renderD128",
      vaapiDriver: "i965",
    });
    expect(intelProbe.probedVaapiCalls.map((c) => c.driverName)).toEqual(["iHD", "i965"]);

    const wslOkProbe = new FakeGpuHardwareProbe();
    wslOkProbe.wslDxgDevice = true;
    wslOkProbe.vaapiProbeHandler = (_dev, driver) => driver === "d3d12";
    expect(await detectBestEncoderBackend("auto", wslOkProbe, null, null)).toMatchObject({
      backend: "vaapi",
      vaapiDriver: "d3d12",
    });

    const wslVideoProcOnlyProbe = new FakeGpuHardwareProbe();
    wslVideoProcOnlyProbe.wslDxgDevice = true;
    wslVideoProcOnlyProbe.vaapiProbeHandler = () => false;
    expect(await detectBestEncoderBackend("auto", wslVideoProcOnlyProbe, null, null)).toMatchObject(
      {
        backend: "software",
        vaapiDevice: null,
        vaapiDriver: null,
      },
    );

    const emptyProbe = new FakeGpuHardwareProbe();
    const fixedNvenc = await detectBestEncoderBackend("nvenc", emptyProbe, null, null);
    expect(fixedNvenc.backend).toBe("nvenc");

    const fixedVaapi = await detectBestEncoderBackend("vaapi", emptyProbe, null, null);
    expect(fixedVaapi.backend).toBe("vaapi");
    expect(fixedVaapi.vaapiDriver).toBeNull();
  });

  it("AC-01: steps down fallback ladder on < 5,000 ms zero-frame exit with exponential backoff [1s, 2s, 4s, 8s, 10s] and resets backoff after first valid frame", async () => {
    expect([...ENCODER_RETRY_BACKOFF_MS]).toEqual([1_000, 2_000, 4_000, 8_000, 10_000]);
    expect(getEncoderRetryDelayMs(0)).toBe(1_000);
    expect(getEncoderRetryDelayMs(1)).toBe(2_000);
    expect(getEncoderRetryDelayMs(2)).toBe(4_000);
    expect(getEncoderRetryDelayMs(3)).toBe(8_000);
    expect(getEncoderRetryDelayMs(4)).toBe(10_000);
    expect(getEncoderRetryDelayMs(9)).toBe(10_000);

    expect(
      computeNextFallbackStep(
        {
          mode: "nvenc",
          backend: "nvenc",
          vaapiLowPower: false,
          gpuColorConvert: true,
          retryAttempt: 0,
        },
        true,
      ),
    ).toBeNull();

    const probe = new FakeGpuHardwareProbe();
    probe.nvidiaDevice = true;
    probe.nvencAvailable = true;
    probe.driRenderNodes = [{ path: "/dev/dri/renderD128", vendorId: "0x1002" }];
    probe.vaapiProbeHandler = (_dev, driver) => driver === "radeonsi";

    const { clock, settings, processRunner, service } = await createEncoderHarness({
      mode: "auto",
      probe,
    });
    await settings.updateSettings(
      { stream: { vaapi: { lowPower: true, gpuColorConvert: true } } },
      { backend: "vaapi" },
    );

    await service.ensureDualRunning();
    expect(service.getActiveBackend()).toBe("nvenc");

    const videoSpawnCount = () =>
      processRunner.spawnCalls.filter((call) => call.args.includes("x11grab")).length;

    clock.advanceByMs(500);
    mustItem(processRunner.spawnedProcesses[0], "nvencProc").emitExit(1);
    await flushMicrotasks();
    expect(service.getActiveBackend()).toBe("vaapi");
    clock.advanceByMs(999);
    expect(videoSpawnCount()).toBe(1);
    clock.advanceByMs(1);
    expect(videoSpawnCount()).toBe(2);

    clock.advanceByMs(500);
    const vaapiProc1 = mustItem(processRunner.spawnedProcesses.at(-1), "vaapiProc1");
    expect(vaapiProc1.spawnOptions.args).toContain("-low_power");
    vaapiProc1.emitExit(1);
    await flushMicrotasks();
    clock.advanceByMs(2_000);
    expect(videoSpawnCount()).toBe(3);
    const vaapiProc2 = mustItem(processRunner.spawnedProcesses.at(-1), "vaapiProc2");
    expect(vaapiProc2.spawnOptions.args).not.toContain("-low_power");
    expect(vaapiProc2.spawnOptions.args.join(" ")).toContain("scale_vaapi");

    clock.advanceByMs(500);
    vaapiProc2.emitExit(1);
    await flushMicrotasks();
    clock.advanceByMs(4_000);
    expect(videoSpawnCount()).toBe(4);
    const vaapiProc3 = mustItem(processRunner.spawnedProcesses.at(-1), "vaapiProc3");
    expect(vaapiProc3.spawnOptions.args.join(" ")).toContain("format=nv12,hwupload");

    clock.advanceByMs(500);
    vaapiProc3.emitExit(1);
    await flushMicrotasks();
    expect(service.getActiveBackend()).toBe("software");
    clock.advanceByMs(8_000);
    expect(videoSpawnCount()).toBe(5);

    clock.advanceByMs(500);
    const swProc1 = mustItem(processRunner.spawnedProcesses.at(-1), "swProc1");
    swProc1.emitExit(1);
    await flushMicrotasks();
    clock.advanceByMs(9_999);
    expect(videoSpawnCount()).toBe(5);
    clock.advanceByMs(1);
    expect(videoSpawnCount()).toBe(6);

    const swProc2 = mustItem(processRunner.spawnedProcesses.at(-1), "swProc2");
    swProc2.emitStdout(
      concatArrays(
        makeAnnexBNal([0, 0, 0, 1], [0x67, 0x42, 0xe0, 0x1e]),
        makeAnnexBNal([0, 0, 0, 1], [0x68, 0xce, 0x3c, 0x80]),
        makeAnnexBNal([0, 0, 0, 1], [0x65, 0x88, 0x84]),
        makeAnnexBNal([0, 0, 0, 1], [0x09, 0x30]),
        makeAnnexBNal([0, 0, 0, 1], [0x41, 0x9a, 0x22]),
      ),
    );
    clock.advanceByMs(500);
    swProc2.emitExit(1);
    await flushMicrotasks();
    clock.advanceByMs(1_000);
    expect(videoSpawnCount()).toBe(7);

    const fixedHarness = await createEncoderHarness({ mode: "nvenc" });
    await fixedHarness.service.ensureDualRunning();
    fixedHarness.clock.advanceByMs(100);
    mustItem(fixedHarness.processRunner.spawnedProcesses[0], "fixedProc").emitExit(1);
    await flushMicrotasks();
    expect(fixedHarness.service.getActiveBackend()).toBe("nvenc");
    expect(fixedHarness.service.getHealthStatus().lastFallbackReason).toBe("fixed_nvenc_retry");

    await service.stopAll();
    await fixedHarness.service.stopAll();
  });

  it("AC-02: parses Annex-B H.264 split at 1-byte boundaries or missing AUD, drops NAL 6/9, emits 4-byte SPS/PPS CONFIG (PTS=0), and packs slices into single AVCC AU", () => {
    const parser = new H264AvccParser();
    const sps = [0x67, 0x42, 0xc0, 0x1e];
    const pps = [0x68, 0xce, 0x38, 0x80];
    const sei = [0x06, 0x05, 0x01, 0xaa];
    const aud = [0x09, 0xf0];
    const idrSlice1 = [0x65, 0x88, 0x84, 0x21];
    const idrSlice2 = [0x65, 0x11, 0x22, 0x33];
    const pSlice1 = [0x41, 0x9a, 0x22, 0x44];

    const stream = concatArrays(
      makeAnnexBNal([0, 0, 1], aud),
      makeAnnexBNal([0, 0, 1], sps),
      makeAnnexBNal([0, 0, 1], pps),
      makeAnnexBNal([0, 0, 0, 1], sei),
      makeAnnexBNal([0, 0, 0, 1], idrSlice1),
      makeAnnexBNal([0, 0, 1], idrSlice2),
      makeAnnexBNal([0, 0, 0, 1], pSlice1),
    );

    const emitted = [];
    for (let i = 0; i < stream.byteLength; i += 1) {
      emitted.push(...parser.push(stream.subarray(i, i + 1)));
    }
    emitted.push(...parser.flush());

    expect(emitted).toHaveLength(3);

    const unit0 = mustItem(emitted[0], "unit0");
    expect(unit0.kind).toBe("CONFIG");
    expect(unit0.isKeyframe).toBe(false);
    expect(Array.from(unit0.data)).toEqual([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps]);

    const unit1 = mustItem(emitted[1], "unit1");
    expect(unit1.kind).toBe("ACCESS_UNIT");
    expect(unit1.isKeyframe).toBe(true);
    expect(Array.from(unit1.data)).toEqual([
      0,
      0,
      0,
      idrSlice1.length,
      ...idrSlice1,
      0,
      0,
      0,
      idrSlice2.length,
      ...idrSlice2,
    ]);

    const unit2 = mustItem(emitted[2], "unit2");
    expect(unit2.kind).toBe("ACCESS_UNIT");
    expect(unit2.isKeyframe).toBe(false);
    expect(Array.from(unit2.data)).toEqual([0, 0, 0, pSlice1.length, ...pSlice1]);

    parser.reset();
    expect(parser.flush()).toEqual([]);
  });

  it("AC-02: parses OggOpus pages, emits >= 19B OpusHead CONFIG, skips OpusTags, and emits 20ms raw Opus packets", async () => {
    const parser = new OggOpusParser();
    const head19 = makeOpusHead(19);
    const shortHead = makeOpusHead(12);
    const tags = makeOpusTags();
    const opus1 = new Uint8Array([0xfc, 0xff, 0xfe, 0x01, 0x02]);
    const opusSpanPart1 = new Uint8Array(255).fill(0xab);
    const opusSpanPart2 = new Uint8Array(10).fill(0xcd);

    const oggStream = concatArrays(
      buildOggPage([shortHead]),
      buildOggPage([head19]),
      buildOggPage([tags]),
      buildOggPage([opus1]),
      buildOggPage([opusSpanPart1], { lacingOverride: [255] }),
      buildOggPage([opusSpanPart2], { continued: true, lacingOverride: [10] }),
    );

    const packets = [];
    for (let i = 0; i < oggStream.byteLength; i += 1) {
      packets.push(...parser.push(oggStream.subarray(i, i + 1)));
    }

    expect(packets).toHaveLength(3);
    const pkt0 = mustItem(packets[0], "pkt0");
    const pkt1 = mustItem(packets[1], "pkt1");
    const pkt2 = mustItem(packets[2], "pkt2");
    expect(pkt0.kind).toBe("CONFIG");
    expect(pkt0.data).toEqual(head19);
    expect(pkt1.kind).toBe("AUDIO_PACKET");
    expect(pkt1.data).toEqual(opus1);
    expect(pkt2.kind).toBe("AUDIO_PACKET");
    expect(pkt2.data).toEqual(concatArrays(opusSpanPart1, opusSpanPart2));

    parser.reset();

    const clampedArgs = buildVideoFfmpegArgs({
      backend: "software",
      display: ":99",
      captureDimensions: { width: 1280, height: 720 },
      encodeDimensions: { width: 1280, height: 720 },
      settings: { ...DEFAULT_STREAM_SETTINGS, videoBitrate: 5_000_000 },
      vaapiDevice: null,
    });
    const bvIdx = clampedArgs.indexOf("-b:v");
    expect(clampedArgs[bvIdx + 1]).toBe("2000000");

    const { clock, settings, processRunner, service } = await createEncoderHarness({
      mode: "software",
    });
    await service.ensureDualRunning();
    expect(service.getHealthStatus().captureResolution).toEqual({ width: 1280, height: 720 });

    await settings.updateSettings({ stream: { maxSize: 960 } }, { backend: "software" });
    const updatePromise = service.applySettingsUpdate({
      videoChanged: true,
      audioChanged: false,
      dimensionsChanged: true,
    });
    await flushMicrotasks();
    clock.advanceByMs(ENCODER_WATCHDOG_CONSTANTS.restartDelayMs);
    await updatePromise;

    expect(service.getHealthStatus().captureResolution).toEqual({ width: 960, height: 540 });
    const lastVideoArgs = mustItem(
      processRunner.spawnCalls.filter((c) => c.args.includes("x11grab")).at(-1),
      "lastVideoArgs",
    ).args;
    expect(lastVideoArgs).toContain("960x540");

    await service.stopAll();
  });

  it("AC-03: applies scaling filter across VAAPI, NVENC, and Software backends and updates active dimensions atomically after encoder restart", async () => {
    const layout = { width: 966, height: 752 };

    const vaapiArgs = buildVideoFfmpegArgs({
      backend: "vaapi",
      display: ":99",
      captureDimensions: layout,
      encodeDimensions: { width: 624, height: 488 },
      settings: { ...DEFAULT_STREAM_SETTINGS, fps: 30, videoBitrate: 500_000 },
      vaapiDevice: "/dev/dri/renderD128",
    });
    expect(vaapiArgs).toContain("hwupload,scale_vaapi=w=624:h=488:format=nv12");
    expect(vaapiArgs).toContain("-draw_mouse");
    expect(vaapiArgs).toContain("0");

    const nvencArgs = buildVideoFfmpegArgs({
      backend: "nvenc",
      display: ":99",
      captureDimensions: layout,
      encodeDimensions: { width: 624, height: 488 },
      settings: { ...DEFAULT_STREAM_SETTINGS, fps: 30, videoBitrate: 500_000 },
      vaapiDevice: null,
    });
    expect(nvencArgs).toContain("scale=624:488,format=yuv420p");
    expect(nvencArgs).not.toContain("-vaapi_device");

    const softwareArgs = buildVideoFfmpegArgs({
      backend: "software",
      display: ":99",
      captureDimensions: layout,
      encodeDimensions: { width: 624, height: 488 },
      settings: { ...DEFAULT_STREAM_SETTINGS, fps: 30, videoBitrate: 500_000 },
      vaapiDevice: null,
    });
    expect(softwareArgs).toContain("scale=624:488");
    expect(softwareArgs).not.toContain("-vaapi_device");

    const probe = new FakeGpuHardwareProbe();
    probe.driRenderNodes = [{ path: "/dev/dri/renderD128", vendorId: "0x1002" }];
    probe.vaapiProbeHandler = () => true;

    const { clock, settings, processRunner, service } = await createEncoderHarness({
      mode: "vaapi",
      probe,
    });
    await settings.updateSettings(
      { stream: { fps: 60, preset: "high", maxSize: 1920 } },
      { backend: "vaapi" },
    );
    await service.reconfigureDimensions(layout);
    await service.ensureDualRunning();

    const initialVideoSpawns = processRunner.spawnCalls.filter((c) =>
      c.args.includes("x11grab"),
    ).length;
    expect(service.getHealthStatus().encodeResolution).toEqual({ width: 966, height: 752 });

    await settings.updateSettings(
      { stream: { clientProfile: { active: "lightweight" }, videoBitrate: 500_000 } },
      { backend: "vaapi" },
    );

    const applyPromise = service.applySettingsUpdate({
      videoChanged: true,
      audioChanged: false,
      dimensionsChanged: true,
    });
    await flushMicrotasks();

    expect(service.getHealthStatus().encodeResolution).toEqual({ width: 966, height: 752 });

    clock.advanceByMs(ENCODER_WATCHDOG_CONSTANTS.restartDelayMs);
    await applyPromise;

    const afterVideoSpawns = processRunner.spawnCalls.filter((c) => c.args.includes("x11grab"));
    expect(afterVideoSpawns).toHaveLength(initialVideoSpawns + 1);
    expect(service.getHealthStatus().encodeResolution).toEqual({ width: 624, height: 488 });

    const restartedArgs = mustItem(afterVideoSpawns.at(-1), "restartedArgs").args;
    expect(restartedArgs).toContain("hwupload,scale_vaapi=w=624:h=488:format=nv12");
    expect(restartedArgs[restartedArgs.indexOf("-framerate") + 1]).toBe("30");

    await service.stopAll();
  });

  it("AC-04: keeps video process uninterrupted when only audioBitrate changes, and triggers video watchdog restart after >= 3,000 ms stall", async () => {
    const { clock, settings, processRunner, service, packets } = await createEncoderHarness({
      mode: "software",
    });

    await service.ensureDualRunning();
    expect(service.getHealthStatus().running).toBe(true);
    expect(processRunner.spawnCalls).toHaveLength(2);

    await settings.updateSettings({ stream: { audioBitrate: 256_000 } }, { backend: "software" });
    const audioUpdatePromise = service.applySettingsUpdate({
      videoChanged: false,
      audioChanged: true,
      dimensionsChanged: false,
    });
    await flushMicrotasks();
    clock.advanceByMs(ENCODER_WATCHDOG_CONSTANTS.restartDelayMs);
    await audioUpdatePromise;

    const videoSpawnsBeforeWatchdog = processRunner.spawnCalls.filter((c) =>
      c.args.includes("x11grab"),
    );
    const audioSpawnsAfterUpdate = processRunner.spawnCalls.filter((c) =>
      c.args.includes("libopus"),
    );
    expect(videoSpawnsBeforeWatchdog).toHaveLength(1);
    expect(audioSpawnsAfterUpdate).toHaveLength(2);
    expect(audioSpawnsAfterUpdate[1]?.args).toEqual(
      buildAudioFfmpegArgs({ audioBitrateBps: 256_000, pulseSocketPath: "/tmp/pulse-native" }),
    );

    const videoProc1 = mustItem(processRunner.spawnedProcesses[0], "videoProc1");
    clock.advanceByMs(2_000);
    videoProc1.emitStdout(
      concatArrays(
        makeAnnexBNal([0, 0, 0, 1], [0x67, 0x42, 0xe0, 0x1e]),
        makeAnnexBNal([0, 0, 0, 1], [0x68, 0xce, 0x3c, 0x80]),
        makeAnnexBNal([0, 0, 0, 1], [0x65, 0x88, 0x84]),
        makeAnnexBNal([0, 0, 0, 1], [0x09, 0x30]),
        makeAnnexBNal([0, 0, 0, 1], [0x41, 0x9a, 0x22]),
      ),
    );
    const configPkt = packets.find((p) => p.mediaType === "video" && p.flags === VIDEO_FLAG.CONFIG);
    const keyPkt = packets.find(
      (p) => p.mediaType === "video" && (p.flags & VIDEO_FLAG.KEYFRAME) !== 0,
    );
    expect(configPkt?.ptsUs).toBe(0n);
    expect(keyPkt?.ptsUs).toBe(2_100_000n);
    expect(keyPkt?.streamEpoch).toBe(STREAM_EPOCH_INITIAL);

    clock.advanceByMs(2_999);
    await flushMicrotasks();
    expect(processRunner.spawnCalls.filter((c) => c.args.includes("x11grab"))).toHaveLength(1);

    clock.advanceByMs(1);
    await flushMicrotasks();
    expect(videoProc1.killedSignals).toContain("SIGTERM");
    expect(processRunner.terminatedProcesses.at(-1)?.graceMs).toBe(
      ENCODER_WATCHDOG_CONSTANTS.sigtermGraceMs,
    );

    clock.advanceByMs(ENCODER_WATCHDOG_CONSTANTS.restartDelayMs);
    await flushMicrotasks();
    expect(processRunner.spawnCalls.filter((c) => c.args.includes("x11grab"))).toHaveLength(2);

    const audioProc2 = mustItem(
      processRunner.spawnedProcesses.find(
        (p) => p.spawnOptions.args.includes("libopus") && p.killedSignals.length === 0,
      ),
      "audioProc2",
    );
    audioProc2.emitExit(1);
    clock.advanceByMs(ENCODER_WATCHDOG_CONSTANTS.audioRestartDelayMs - 1);
    expect(processRunner.spawnCalls.filter((c) => c.args.includes("libopus"))).toHaveLength(2);
    await service.ensureDualRunning();
    expect(service.getHealthStatus().running).toBe(true);
    expect(processRunner.spawnCalls.filter((c) => c.args.includes("libopus"))).toHaveLength(3);

    await service.pauseWithTimelineComp();
    clock.advanceByMs(10_000);
    await flushMicrotasks();
    expect(service.getHealthStatus().running).toBe(false);

    const epoch2 = service.advanceEpochAndResetClock();
    expect(epoch2).toBe(STREAM_EPOCH_INITIAL + 1);
    await service.ensureDualRunning();

    const videoAfterHold = mustItem(
      processRunner.spawnedProcesses.filter((p) => p.spawnOptions.args.includes("x11grab")).at(-1),
      "videoAfterHold",
    );
    const audioAfterHold = mustItem(
      processRunner.spawnedProcesses.filter((p) => p.spawnOptions.args.includes("libopus")).at(-1),
      "audioAfterHold",
    );

    clock.advanceByMs(500);
    videoAfterHold.emitStdout(
      concatArrays(
        makeAnnexBNal([0, 0, 0, 1], [0x67, 0x42, 0xe0, 0x1e]),
        makeAnnexBNal([0, 0, 0, 1], [0x68, 0xce, 0x3c, 0x80]),
        makeAnnexBNal([0, 0, 0, 1], [0x65, 0x88, 0x84]),
        makeAnnexBNal([0, 0, 0, 1], [0x09, 0x30]),
        makeAnnexBNal([0, 0, 0, 1], [0x41, 0x9a, 0x22]),
      ),
    );
    const compensatedVideoPkt = mustItem(packets.at(-1), "compensatedVideoPkt");
    expect(compensatedVideoPkt.streamEpoch).toBe(epoch2);
    expect(compensatedVideoPkt.ptsUs).toBe(6_699_000n);

    audioAfterHold.emitStdout(
      concatArrays(
        buildOggPage([makeOpusHead(19)]),
        buildOggPage([makeOpusTags()]),
        buildOggPage([new Uint8Array([0xfc, 0x01])]),
        buildOggPage([new Uint8Array([0xfc, 0x02])]),
      ),
    );
    const audioPkts = packets.filter((p) => p.mediaType === "audio" && p.streamEpoch === epoch2);
    expect(audioPkts[0]?.flags).toBe(AUDIO_FLAG.CONFIG);
    expect(audioPkts[0]?.ptsUs).toBe(0n);
    expect(audioPkts[1]?.ptsUs).toBe(6_699_000n);
    expect(audioPkts[2]?.ptsUs).toBe(6_719_000n);

    await service.stopAll();
    service.clearTimelineComp();
    const epoch3 = service.advanceEpochAndResetClock();
    expect(epoch3).toBe(STREAM_EPOCH_INITIAL + 2);
    await service.ensureDualRunning();

    const videoAfterReset = mustItem(
      processRunner.spawnedProcesses.filter((p) => p.spawnOptions.args.includes("x11grab")).at(-1),
      "videoAfterReset",
    );
    clock.advanceByMs(250);
    videoAfterReset.emitStdout(
      concatArrays(
        makeAnnexBNal([0, 0, 0, 1], [0x67, 0x42, 0xe0, 0x1e]),
        makeAnnexBNal([0, 0, 0, 1], [0x68, 0xce, 0x3c, 0x80]),
        makeAnnexBNal([0, 0, 0, 1], [0x65, 0x88, 0x84]),
        makeAnnexBNal([0, 0, 0, 1], [0x09, 0x30]),
        makeAnnexBNal([0, 0, 0, 1], [0x41, 0x9a, 0x22]),
      ),
    );
    expect(packets.at(-1)?.ptsUs).toBe(250_000n);

    await service.stopAll();
  });
});
