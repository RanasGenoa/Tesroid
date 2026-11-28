import { describe, expect, it } from "vitest";
import { NodeGpuHardwareProbe } from "../../src/domains/encoder/gpu-detector.js";
import { FakeProcessRunner } from "../helpers/fakes.js";

describe("server/domains/encoder NVENC プローブ (仕様 05 AC-01)", () => {
  it("AC-01: NVENC プローブは稼働時と同一の低遅延構成（-preset p1 -tune ll -zerolatency 1・入力 256×144:r=1・yuv420p）で実行される", async () => {
    const runner = new FakeProcessRunner();
    runner.execHandler = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    const probe = new NodeGpuHardwareProbe({ processRunner: runner, env: {} });
    expect(await probe.probeNvenc()).toBe(true);

    const nvencCall = runner.execCalls.find((call) => call.args.includes("h264_nvenc"));
    expect(nvencCall).toBeDefined();
    const args = nvencCall?.args ?? [];
    expect(args).toContain("-preset");
    expect(args[args.indexOf("-preset") + 1]).toBe("p1");
    expect(args).toContain("-tune");
    expect(args[args.indexOf("-tune") + 1]).toBe("ll");
    expect(args).toContain("-zerolatency");
    expect(args[args.indexOf("-zerolatency") + 1]).toBe("1");
    expect(args).toContain("-pix_fmt");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(args).toContain("color=black:s=256x144:r=1");
  });

  it("AC-01: プローブ失敗（非0終了・8秒タイムアウト）では false を返し、自動採用を中止する", async () => {
    const runner = new FakeProcessRunner();
    runner.execHandler = (_command, _args, options) => {
      expect(options?.timeoutMs).toBe(8_000);
      return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
    };

    const probe = new NodeGpuHardwareProbe({ processRunner: runner, env: {} });
    expect(await probe.probeNvenc()).toBe(false);
  });
});
