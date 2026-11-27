// 仕様 06 AC-06: managed policy による infobar 恒久抑止と廃止済みフラグの非依存（Dockerfile 焼き込みの機械保証）
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildChromeLaunchArgs } from "../../src/domains/browser/launch-args.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("仕様 06 AC-06 managed policy による infobar 恒久抑止", () => {
  it("Dockerfile が managed policy へ CommandLineFlagSecurityWarningsEnabled=false を焼き込む", () => {
    const dockerfile = readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
    const policyWrites = [
      ...dockerfile.matchAll(
        /printf '(\{[^']*?\})\\n?' > (\/etc\/opt\/chrome\/policies\/managed\/\S+)/g,
      ),
    ];
    expect(policyWrites).toHaveLength(1);
    const write = policyWrites[0];
    if (write === undefined) {
      throw new Error("unreachable");
    }
    expect(write[2]).toBe("/etc/opt/chrome/policies/managed/tesroid.json");
    expect(JSON.parse(write[1] as string)).toEqual({
      CommandLineFlagSecurityWarningsEnabled: false,
    });
  });

  it("現行 Chrome で廃止済みで無効な --disable-infobars は起動引数に含まれない", () => {
    const args = buildChromeLaunchArgs({
      display: ":99",
      locale: "ja-JP",
      timezone: "Asia/Tokyo",
      userDataDir: "/tmp/tesroid-profile",
      pulseSocketPath: "/tmp/pulse-socket",
      cdpPort: 9222,
      initialUrl: "https://example.com/",
      viewport: { width: 1280, height: 720 },
    });
    expect(args).not.toContain("--disable-infobars");
    expect(args).toContain("--no-sandbox");
  });
});
