// 仕様 06 AC-01: PulseAudio ソケット経路の単一正典（サーバー設定と Dockerfile 焼き込み .pa の一致）
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PULSE_SOCKET_PATH } from "../../src/app/container.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("仕様 06 AC-01 PulseAudio ソケット経路の整合", () => {
  it("サーバー設定のソケット経路は仕様 06 §2.1 の /tmp/pulse-socket である", () => {
    expect(PULSE_SOCKET_PATH).toBe("/tmp/pulse-socket");
  });

  it("Dockerfile が焼き込む tesroid.pa の socket= と一致する", () => {
    const dockerfile = readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
    const sockets = [
      ...dockerfile.matchAll(/module-native-protocol-unix[^"']*socket=(\/[^\s'"]+)/g),
    ].map((m) => m[1]);
    expect(sockets).toEqual([PULSE_SOCKET_PATH]);
  });
});
