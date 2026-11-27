import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppContainer } from "../../src/app/container.js";
import { SERVER_ENV_DEFAULTS, type ServerEnvConfig } from "../../src/infra/env.js";
import { createHttpServer } from "../../src/interfaces/http/server.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeEnv(dataDir: string, clientDistPath: string): ServerEnvConfig {
  return {
    port: SERVER_ENV_DEFAULTS.port,
    dataDir,
    display: SERVER_ENV_DEFAULTS.display,
    locale: SERVER_ENV_DEFAULTS.locale,
    timezone: SERVER_ENV_DEFAULTS.timezone,
    encoderMode: "auto",
    vaapiDevice: null,
    libvaDriverName: null,
    telemetryLogDir: path.join(dataDir, "telemetry"),
    clientDistPath,
    bufferHoldExpireMinutes: SERVER_ENV_DEFAULTS.bufferHoldExpireMinutes,
    playbackBufferSeconds: SERVER_ENV_DEFAULTS.playbackBufferSeconds,
    playbackBufferMaxBytes: SERVER_ENV_DEFAULTS.playbackBufferMaxBytes,
    idleToBufferSeconds: SERVER_ENV_DEFAULTS.idleToBufferSeconds,
  };
}

async function buildStaticApp(): Promise<{
  app: ReturnType<typeof createHttpServer>;
  container: ReturnType<typeof createAppContainer>;
}> {
  const dataDir = await makeTempDir("tesroid-static-data-");
  const clientDist = await makeTempDir("tesroid-static-dist-");
  await fs.writeFile(
    path.join(clientDist, "index.html"),
    '<!doctype html><html><head><title>t</title></head><body><canvas id="stage"></canvas></body></html>',
  );
  await fs.mkdir(path.join(clientDist, "assets"));
  await fs.writeFile(path.join(clientDist, "assets", "index-a1b2c3d4.js"), "export const x = 1;");
  const container = createAppContainer(makeEnv(dataDir, clientDist));
  const app = createHttpServer(container);
  return { app, container };
}

// Spec: docs/specs/01-auth-security.md#5-ac-07（静的フロントエンド配信は公開境界で Bearer 認証を要求しない）
describe("仕様 01 AC-07 静的フロントエンドの公開配信", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("GET / は Bearer トークンなしで index.html を text/html で返す", async () => {
    const { app, container } = await buildStaticApp();
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain('<canvas id="stage">');
      // index.html は毎回再検証（HTTP キャッシュの都度再検証）で新しいバンドルハッシュを反映できる必要がある。
      expect(res.headers["cache-control"]).toBe("no-cache");
    } finally {
      await app.close();
      await container.dispose();
    }
  });

  it("ハッシュ付き assets は正しい MIME と長期不変キャッシュで配信される", async () => {
    const { app, container } = await buildStaticApp();
    try {
      const res = await app.inject({ method: "GET", url: "/assets/index-a1b2c3d4.js" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("javascript");
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    } finally {
      await app.close();
      await container.dispose();
    }
  });

  it("API 以外の未知パスは JSON 404 のまま（ディープリンクの SPA 書き換えは行わない）", async () => {
    const { app, container } = await buildStaticApp();
    try {
      const res = await app.inject({ method: "GET", url: "/missing-deep/path" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Not Found", statusCode: 404 });
    } finally {
      await app.close();
      await container.dispose();
    }
  });
});
