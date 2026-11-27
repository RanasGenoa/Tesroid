import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildChromeLaunchArgs,
  buildChromeProcessEnv,
  PROHIBITED_CHROME_FLAGS,
} from "../../server/src/domains/browser/index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function collectFiles(dirPath: string, extensions: readonly string[]): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const results: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

interface ParsedImport {
  readonly isTypeOnly: boolean;
  readonly specifier: string;
}

function extractModuleImports(source: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  const importRegex = /\b(?:import|export)\s+(type\s+)?[\s\S]*?\bfrom\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(importRegex)) {
    results.push({
      isTypeOnly: Boolean(match[1]),
      specifier: match[2] ?? "",
    });
  }
  const sideEffectImportRegex = /\bimport\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(sideEffectImportRegex)) {
    results.push({
      isTypeOnly: false,
      specifier: match[1] ?? "",
    });
  }
  return results;
}

describe("Architecture & Specification Invariant Guardrails", () => {
  it("Spec 04 AC-01 & Spec 07 AC-01: client source, index.html, and built dist contain zero <video> tags or createElement('video') and include <canvas> after HUD", () => {
    const indexHtmlPath = path.join(rootDir, "client/index.html");
    const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
    expect(indexHtml).toMatch(/<canvas\b/i);
    expect(indexHtml.indexOf("<header")).toBeGreaterThanOrEqual(0);
    expect(indexHtml.indexOf("<header")).toBeLessThan(indexHtml.indexOf("<canvas"));

    const clientSrcFiles = collectFiles(path.join(rootDir, "client/src"), [".ts", ".html"]);
    const clientDistFiles = collectFiles(path.join(rootDir, "client/dist"), [".js", ".html"]);
    const filesToInspect = [indexHtmlPath, ...clientSrcFiles, ...clientDistFiles];

    for (const filePath of filesToInspect) {
      const content = fs.readFileSync(filePath, "utf8");
      expect(content, `${filePath} must not contain <video>`).not.toMatch(/<video\b/i);
      expect(content, `${filePath} must not create <video>`).not.toMatch(
        /createElement\s*\(\s*["'`]video["'`]\s*\)/i,
      );
      expect(content, `${filePath} must not reference HTMLVideoElement`).not.toMatch(
        /\bHTMLVideoElement\b/,
      );
    }

    const distHtmlPath = path.join(rootDir, "client/dist/index.html");
    if (fs.existsSync(distHtmlPath)) {
      const distHtml = fs.readFileSync(distHtmlPath, "utf8");
      expect(distHtml).toMatch(/<canvas\b/i);
      expect(distHtml.indexOf("<header")).toBeGreaterThanOrEqual(0);
      expect(distHtml.indexOf("<header")).toBeLessThan(distHtml.indexOf("<canvas"));
    }
  });

  it("Spec 01 AC-05 & Spec 07 AC-01: client source and built dist contain zero localStorage references and zero hardcoded 1.53 DPR literals", () => {
    const filesToInspect = [
      path.join(rootDir, "client/index.html"),
      ...collectFiles(path.join(rootDir, "client/src"), [".ts", ".css", ".html"]),
      ...collectFiles(path.join(rootDir, "client/dist"), [".js", ".css", ".html"]),
    ];

    for (const filePath of filesToInspect) {
      const content = fs.readFileSync(filePath, "utf8");
      expect(content, `${filePath} must not reference localStorage`).not.toMatch(
        /\blocalStorage\b/,
      );
      expect(content, `${filePath} must not hardcode DPR 1.53`).not.toMatch(/\b1\.53\b/);
    }
  });

  it("Spec 01 AC-06 & Spec 07 AC-05: client source and built dist contain zero window.prompt(), window.confirm(), or UI keydown shortcuts", () => {
    const srcFiles = collectFiles(path.join(rootDir, "client/src"), [".ts"]);
    const distFiles = collectFiles(path.join(rootDir, "client/dist"), [".js"]);

    for (const filePath of [...srcFiles, ...distFiles]) {
      const content = fs.readFileSync(filePath, "utf8");
      expect(content, `${filePath} must not call window.prompt/confirm`).not.toMatch(
        /\b(?:window|globalThis|self)\.(?:prompt|confirm)\s*\(/,
      );
      expect(content, `${filePath} must not call prompt/confirm`).not.toMatch(
        /(?<![.\w$])(?:prompt|confirm)\s*\(/,
      );
    }

    const uiFiles = collectFiles(path.join(rootDir, "client/src/ui"), [".ts"]);
    for (const filePath of uiFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      expect(content, `${filePath} must not bind keydown handlers`).not.toMatch(
        /addEventListener\s*\(\s*["'`]keydown["'`]/,
      );
    }
  });

  it("Architecture §2.1: shared workspace has zero external runtime dependencies, zero Node.js/DOM API usage, and zero imports from server or client", () => {
    const sharedPkg = JSON.parse(
      fs.readFileSync(path.join(rootDir, "shared/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(sharedPkg.dependencies ?? {})).toEqual([]);

    const forbiddenModules = new Set([
      "fs",
      "path",
      "child_process",
      "os",
      "crypto",
      "http",
      "https",
      "net",
      "stream",
      "worker_threads",
      "fastify",
      "ws",
      "vite",
    ]);
    const forbiddenDomOrNodeGlobals = [
      /\bwindow\b/,
      /\bdocument\b/,
      /\bHTMLElement\b/,
      /\bHTMLCanvasElement\b/,
      /\bHTMLVideoElement\b/,
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
      /\bWebSocket\b/,
      /\bVideoDecoder\b/,
      /\bAudioDecoder\b/,
      /\bprocess\.env\b/,
      /\bBuffer\./,
    ];

    const sharedFiles = collectFiles(path.join(rootDir, "shared/src"), [".ts"]);
    expect(sharedFiles.length).toBeGreaterThan(0);

    for (const filePath of sharedFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      for (const imp of extractModuleImports(content)) {
        expect(imp.specifier, `${filePath} must not import node:`).not.toMatch(/^node:/);
        expect(forbiddenModules.has(imp.specifier), `${filePath} imports ${imp.specifier}`).toBe(
          false,
        );
        expect(imp.specifier, `${filePath} must not import server/client`).not.toMatch(
          /(?:^|\/)(?:server|client)(?:\/|$)/,
        );
      }
      for (const pattern of forbiddenDomOrNodeGlobals) {
        expect(content, `${filePath} matched forbidden ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("Architecture §2.1: server/domains/* forbids cross-domain concrete imports and reverse dependencies to app, interfaces, Fastify, or ws", () => {
    const domainsRoot = path.join(rootDir, "server/src/domains");
    const domainDirs = fs
      .readdirSync(domainsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(domainDirs.length).toBe(8);

    for (const domainName of domainDirs) {
      const domainFiles = collectFiles(path.join(domainsRoot, domainName), [".ts"]);
      for (const filePath of domainFiles) {
        const content = fs.readFileSync(filePath, "utf8");
        for (const imp of extractModuleImports(content)) {
          expect(imp.specifier, `${filePath} must not import fastify/ws`).not.toMatch(
            /^(?:fastify|@fastify\/|ws$)/,
          );
          expect(imp.specifier, `${filePath} must not import app or interfaces`).not.toMatch(
            /(?:^|\/)(?:app|interfaces)(?:\/|$)/,
          );

          if (imp.specifier.startsWith("../")) {
            const targetSegment = imp.specifier.split("/")[1];
            if (targetSegment && targetSegment !== ".." && targetSegment !== domainName) {
              expect(
                imp.isTypeOnly,
                `${filePath} cross-domain import ${imp.specifier} must be type-only`,
              ).toBe(true);
              expect(
                imp.specifier,
                `${filePath} cross-domain import must target ports.js only`,
              ).toBe(`../${targetSegment}/ports.js`);
            }
          }
        }
      }
    }
  });

  it("Architecture §2.1: enforces layer boundaries for server/infra, server/app, client/transport, and client/ui", () => {
    for (const filePath of collectFiles(path.join(rootDir, "server/src/infra"), [".ts"])) {
      const content = fs.readFileSync(filePath, "utf8");
      for (const imp of extractModuleImports(content)) {
        expect(imp.specifier, `${filePath} infra cannot import upper layers`).not.toMatch(
          /(?:^|\/)(?:domains|app|interfaces)(?:\/|$)/,
        );
      }
    }

    for (const filePath of collectFiles(path.join(rootDir, "server/src/app"), [".ts"])) {
      const content = fs.readFileSync(filePath, "utf8");
      for (const imp of extractModuleImports(content)) {
        expect(imp.specifier, `${filePath} app cannot import interfaces`).not.toMatch(
          /(?:^|\/)interfaces(?:\/|$)/,
        );
        expect(imp.specifier, `${filePath} app cannot import fastify/ws`).not.toMatch(
          /^(?:fastify|@fastify\/|ws$)/,
        );
      }
    }

    for (const filePath of collectFiles(path.join(rootDir, "client/src/transport"), [".ts"])) {
      const content = fs.readFileSync(filePath, "utf8");
      for (const imp of extractModuleImports(content)) {
        expect(imp.specifier, `${filePath} transport cannot import ui or media`).not.toMatch(
          /(?:^|\/)(?:ui|media)(?:\/|$)/,
        );
      }
    }

    for (const filePath of collectFiles(path.join(rootDir, "client/src/ui"), [".ts"])) {
      const content = fs.readFileSync(filePath, "utf8");
      for (const imp of extractModuleImports(content)) {
        expect(imp.specifier, `${filePath} ui cannot import transport or media`).not.toMatch(
          /(?:^|\/)(?:transport|media)(?:\/|$)/,
        );
      }
    }
  });

  it("Spec 06 AC-01: browser launch-args excludes prohibited Chrome GPU flags and strips GALLIUM_DRIVER=d3d12", () => {
    const launchArgsPath = path.join(rootDir, "server/src/domains/browser/launch-args.ts");
    const content = fs.readFileSync(launchArgsPath, "utf8");
    for (const flag of PROHIBITED_CHROME_FLAGS) {
      expect(content).not.toContain(flag);
    }

    const args = buildChromeLaunchArgs({
      display: ":99",
      locale: "ja-JP",
      timezone: "Asia/Tokyo",
      userDataDir: "/tmp/tesroid-chrome-guard",
      pulseSocketPath: "/tmp/pulse-socket",
      cdpPort: 9222,
      initialUrl: "https://www.youtube.com",
      viewport: { width: 1280, height: 720 },
      vaapiRenderNode: "/dev/dri/renderD128",
    });
    for (const flag of PROHIBITED_CHROME_FLAGS) {
      expect(args).not.toContain(flag);
    }

    const chromeEnv = buildChromeProcessEnv(
      { GALLIUM_DRIVER: "d3d12" },
      "ja-JP",
      "Asia/Tokyo",
      ":99",
      "/tmp/pulse-socket",
    );
    expect(chromeEnv.GALLIUM_DRIVER).toBeUndefined();
    expect(chromeEnv.LIBVA_DRIVER_NAME).toBeUndefined();
  });

  const ABOLISHED_ENV_KEYS = [
    "FPS",
    "VIDEO_BITRATE",
    "AUDIO_BITRATE",
    "DISPLAY_WIDTH",
    "DISPLAY_HEIGHT",
    "BROWSER_URL",
  ] as const;

  function parseEnvOutput(stdout: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of stdout.split(/\r?\n/)) {
      const eqIndex = line.indexOf("=");
      if (eqIndex > 0) {
        result[line.slice(0, eqIndex)] = line.slice(eqIndex + 1);
      }
    }
    return result;
  }

  function createExecutableStub(dirPath: string, name: string, scriptBody: string): void {
    const filePath = path.join(dirPath, name);
    fs.writeFileSync(filePath, `#!/usr/bin/env bash\nset -euo pipefail\n${scriptBody}\n`, {
      mode: 0o755,
    });
  }

  async function getFreeLoopbackPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        if (addr === null || typeof addr === "string") {
          probe.close();
          reject(new Error("Failed to resolve ephemeral port"));
          return;
        }
        const { port } = addr;
        probe.close((closeErr) => {
          if (closeErr) {
            reject(closeErr);
            return;
          }
          resolve(port);
        });
      });
    });
  }

  async function waitForFileContent(filePath: string, timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.length > 0) {
          return content;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${filePath}`);
  }

  it("Spec 05 §3 & Spec 09 AC-03: no hardcoded driver in /etc/libva.conf, no forced default LIBVA_DRIVER_NAME in entrypoint, and GALLIUM_DRIVER=d3d12 never passed to Chrome", () => {
    const dockerfile = fs.readFileSync(path.join(rootDir, "Dockerfile"), "utf8");
    const envExample = fs.readFileSync(path.join(rootDir, ".env.example"), "utf8");
    const entrypointPath = path.join(rootDir, "docker/entrypoint.sh");
    const entrypoint = fs.readFileSync(entrypointPath, "utf8");

    expect(dockerfile).toContain("/etc/libva.conf");
    expect(dockerfile).not.toMatch(/ENV[^\n]*\bLIBVA_DRIVER_NAME=/);
    expect(dockerfile).not.toMatch(/ENV[^\n]*\bGALLIUM_DRIVER=/);

    const composeFiles = [
      "docker-compose.yml",
      "docker-compose.prebuilt.yml",
      "docker-compose.windows.yml",
      "docker-compose.nvidia.yml",
    ] as const;

    for (const fileName of composeFiles) {
      const content = fs.readFileSync(path.join(rootDir, fileName), "utf8");
      for (const key of ABOLISHED_ENV_KEYS) {
        expect(content, `${fileName} must not include abolished ${key}`).not.toMatch(
          new RegExp(`\\b${key}\\b`),
        );
      }
      expect(content, `${fileName} must not include DEPLOY_*`).not.toMatch(/\bDEPLOY_[A-Z0-9_]+\b/);
    }

    for (const key of ABOLISHED_ENV_KEYS) {
      expect(dockerfile, `Dockerfile must not include ${key}`).not.toMatch(
        new RegExp(`\\b${key}\\b`),
      );
      expect(envExample, `.env.example must not include ${key}`).not.toMatch(
        new RegExp(`\\b${key}\\b`),
      );
      expect(entrypoint, `entrypoint.sh must not include ${key}`).not.toMatch(
        new RegExp(`\\b${key}\\b`),
      );
    }
    expect(envExample).not.toMatch(/\bDEPLOY_[A-Z0-9_]+\b/);

    const standardCompose = fs.readFileSync(path.join(rootDir, "docker-compose.yml"), "utf8");
    const prebuiltCompose = fs.readFileSync(
      path.join(rootDir, "docker-compose.prebuilt.yml"),
      "utf8",
    );
    const windowsCompose = fs.readFileSync(
      path.join(rootDir, "docker-compose.windows.yml"),
      "utf8",
    );
    const nvidiaCompose = fs.readFileSync(path.join(rootDir, "docker-compose.nvidia.yml"), "utf8");

    expect(standardCompose).toContain("/dev/dri:/dev/dri");
    expect(standardCompose).not.toMatch(/LIBVA_DRIVER_NAME:\s*"\$\{LIBVA_DRIVER_NAME:-[^}]+\}"/);
    expect(prebuiltCompose).toContain("/dev/dri:/dev/dri");
    expect(prebuiltCompose).not.toMatch(/LIBVA_DRIVER_NAME:\s*"\$\{LIBVA_DRIVER_NAME:-[^}]+\}"/);

    expect(windowsCompose).not.toContain("/dev/dri");
    expect(windowsCompose).toContain("/dev/dxg:/dev/dxg");
    expect(windowsCompose).toContain("/usr/lib/wsl:/usr/lib/wsl:ro");
    expect(windowsCompose).toContain("d3d12");

    expect(nvidiaCompose).not.toContain("/dev/dri");
    expect(nvidiaCompose).toContain("driver: nvidia");
    expect(nvidiaCompose).toContain("NVIDIA_VISIBLE_DEVICES");
    expect(nvidiaCompose).toContain("NVIDIA_DRIVER_CAPABILITIES");
    expect(nvidiaCompose).toContain("ENCODER_MODE");
    expect(nvidiaCompose).toContain("nvenc");

    const syntaxCheck = spawnSync("bash", ["-n", entrypointPath], { encoding: "utf8" });
    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tesroid-ep-env-"));
    try {
      const binDir = path.join(tmpRoot, "bin");
      const dataDir = path.join(tmpRoot, "data");
      fs.mkdirSync(binDir);
      createExecutableStub(binDir, "google-chrome", "exit 0");

      const baseEnv: NodeJS.ProcessEnv = {
        PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        DATA_DIR: dataDir,
        ENCODER_MODE: "nvenc",
        LIBVA_DRIVER_NAME: "auto",
        VAAPI_DEVICE: "auto",
        GALLIUM_DRIVER: "d3d12",
      };

      const validRun = spawnSync("bash", [entrypointPath, "env"], {
        env: baseEnv,
        encoding: "utf8",
      });
      expect(validRun.status, validRun.stderr).toBe(0);
      const childEnv = parseEnvOutput(validRun.stdout);
      expect(childEnv.ENCODER_MODE).toBe("nvenc");
      expect(childEnv.LIBVA_DRIVER_NAME).toBeUndefined();
      expect(childEnv.VAAPI_DEVICE).toBeUndefined();
      expect(childEnv.GALLIUM_DRIVER).toBeUndefined();

      const invalidRun = spawnSync("bash", [entrypointPath, "env"], {
        env: {
          ...baseEnv,
          ENCODER_MODE: "invalid_mode",
        },
        encoding: "utf8",
      });
      expect(invalidRun.status).not.toBe(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("Spec 09 AC-01/02/05: Dockerfile preserves no-systemd APT pinning, dbus-x11, --no-install-recommends, INSTALL_CHROME=false, Node 22, and valid scripts/workflows", async () => {
    const dockerfile = fs.readFileSync(path.join(rootDir, "Dockerfile"), "utf8");
    const entrypoint = fs.readFileSync(path.join(rootDir, "docker/entrypoint.sh"), "utf8");
    const installScriptPath = path.join(rootDir, "scripts/install.sh");
    const installScript = fs.readFileSync(installScriptPath, "utf8");
    const ciWorkflow = fs.readFileSync(path.join(rootDir, ".github/workflows/ci.yml"), "utf8");
    const publishWorkflow = fs.readFileSync(
      path.join(rootDir, ".github/workflows/docker-publish.yml"),
      "utf8",
    );

    expect(dockerfile).toContain("FROM --platform=linux/amd64 node:22-slim AS builder");
    expect(dockerfile).toContain("FROM --platform=linux/amd64 ubuntu:24.04 AS runtime");
    expect(dockerfile).toContain("node_22.x");
    expect(dockerfile).toContain("ARG INSTALL_CHROME=false");
    expect(dockerfile).toContain("ARG CLOUDFLARED_VERSION=2026.11.1");
    expect(dockerfile).toContain(
      "ARG CLOUDFLARED_SHA256=97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7",
    );
    expect(dockerfile).toContain("sha256sum -c");
    expect(dockerfile).toContain("/etc/apt/preferences.d/no-systemd");
    expect(dockerfile).toContain("Pin-Priority: -1");
    for (const blockedPkg of [
      "systemd",
      "systemd-sysv",
      "systemd-standalone-sysusers",
      "systemd-standalone-tmpfiles",
      "libpam-systemd",
      "dbus-user-session",
      "udev",
    ]) {
      expect(dockerfile).toContain(blockedPkg);
    }
    expect(dockerfile).toContain("dbus-x11");
    expect(dockerfile).toContain("tini");
    expect(dockerfile).toContain("TINI_KILL_PROCESS_GROUP=1");
    expect(dockerfile).toContain("/etc/pulse/tesroid.pa");
    expect(dockerfile).toContain("/etc/xdg/openbox/rc.xml");
    expect(dockerfile).not.toContain("xdotool");

    const aptInstallLines = dockerfile
      .split(/\r?\n/)
      .filter((line) => line.includes("apt-get install"));
    expect(aptInstallLines.length).toBeGreaterThanOrEqual(2);
    for (const line of aptInstallLines) {
      expect(line).toContain("--no-install-recommends");
    }

    expect(entrypoint).toContain("--tlsv1.2");
    expect(entrypoint).toContain("dpkg-deb --info");
    expect(entrypoint).toContain("google-chrome-stable");
    expect(entrypoint).toContain("--no-install-recommends");

    const installSyntax = spawnSync("bash", ["-n", installScriptPath], { encoding: "utf8" });
    expect(installSyntax.status, installSyntax.stderr).toBe(0);
    expect(installScript).toContain("Linux");
    expect(installScript).toContain("x86_64");
    expect(installScript).toContain("2048");
    expect(installScript).toContain("nvidia-smi");
    expect(installScript).toContain("/dev/dri/renderD");
    expect(installScript).toContain("chmod 0600 .env");

    expect(ciWorkflow).toContain("node-version: 22");
    expect(ciWorkflow).toContain("contents: read");
    expect(ciWorkflow).not.toMatch(/^\s*pull_request_target\s*:/m);
    expect(ciWorkflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(ciWorkflow).toContain("npm ci");
    expect(ciWorkflow).toContain("npm run check");
    expect(ciWorkflow).toContain("npm run test");
    expect(ciWorkflow).toContain("npm run build");
    expect(ciWorkflow).toContain("test/guardrails/invariants.test.ts");

    expect(publishWorkflow).toContain("platforms: linux/amd64");
    expect(publishWorkflow).toContain("INSTALL_CHROME=false");
    expect(publishWorkflow).toContain("latest=false");
    expect(publishWorkflow).toContain("!contains(github.ref, '-')");

    const upstream = http.createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    upstream.on("upgrade", (_req, socket, head) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      if (head.length > 0) {
        socket.write(head);
      }
      socket.pipe(socket);
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamAddr = upstream.address();
    if (upstreamAddr === null || typeof upstreamAddr === "string") {
      throw new Error("Unexpected upstream address");
    }

    const proxyPort = await getFreeLoopbackPort();
    const proxyProc = spawn("node", [path.join(rootDir, "scripts/pc-proxy.mjs")], {
      env: {
        ...process.env,
        TARGET_HOST: "127.0.0.1",
        TARGET_PORT: String(upstreamAddr.port),
        LISTEN_PORT: String(proxyPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      let healthBody = "";
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${proxyPort}/api/health`);
          if (response.ok) {
            healthBody = await response.text();
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      expect(JSON.parse(healthBody)).toEqual({ ok: true });

      const wsEcho = await new Promise<string>((resolve, reject) => {
        const client = net.connect(proxyPort, "127.0.0.1", () => {
          client.write(
            [
              "GET /ws HTTP/1.1",
              `Host: 127.0.0.1:${proxyPort}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              "",
              "PING_FRAME",
            ].join("\r\n"),
          );
        });
        let received = "";
        client.on("data", (chunk) => {
          received += chunk.toString("utf8");
          if (received.includes("101 Switching Protocols") && received.includes("PING_FRAME")) {
            client.destroy();
            resolve(received);
          }
        });
        client.on("error", reject);
        setTimeout(() => {
          client.destroy();
          reject(new Error("WebSocket upgrade proxy timeout"));
        }, 2000);
      });
      expect(wsEcho).toContain("101 Switching Protocols");
      expect(wsEcho).toContain("PING_FRAME");
    } finally {
      proxyProc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proxyProc.once("exit", () => resolve());
        setTimeout(() => resolve(), 1000);
      });
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("Spec 09 AC-04: entrypoint never passes TUNNEL_TOKEN via CLI args, unsets TUNNEL_TOKEN before launching app/browser, and repository contains zero hardcoded secrets or private IPs", async () => {
    const entrypointPath = path.join(rootDir, "docker/entrypoint.sh");
    const entrypoint = fs.readFileSync(entrypointPath, "utf8");
    expect(entrypoint).toContain("unset TUNNEL_TOKEN");
    expect(entrypoint).toContain("unset _tunnel_token");
    expect(entrypoint).toContain("rc != 0 && rc != 130 && rc != 143");
    expect(entrypoint).not.toMatch(/cloudflared[^\n]*--token/);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tesroid-ep-token-"));
    try {
      const binDir = path.join(tmpRoot, "bin");
      const dataDir = path.join(tmpRoot, "data");
      const argsLog = path.join(tmpRoot, "cf-args.txt");
      const tokenLog = path.join(tmpRoot, "cf-token.txt");
      fs.mkdirSync(binDir);

      createExecutableStub(binDir, "google-chrome", "exit 0");
      createExecutableStub(
        binDir,
        "cloudflared",
        `printf '%s\\n' "$*" > "${argsLog}"\nprintf '%s' "\${TUNNEL_TOKEN:-}" > "${tokenLog}"\nexit 0`,
      );

      const sampleToken = "tesroid_test_token_value_1234567890";
      const runResult = spawnSync("bash", [entrypointPath, "env"], {
        env: {
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          DATA_DIR: dataDir,
          TUNNEL_TOKEN: sampleToken,
        },
        encoding: "utf8",
      });
      expect(runResult.status, runResult.stderr).toBe(0);

      const childEnv = parseEnvOutput(runResult.stdout);
      expect(childEnv.TUNNEL_TOKEN).toBeUndefined();

      const recordedArgs = await waitForFileContent(argsLog);
      const recordedToken = await waitForFileContent(tokenLog);
      expect(recordedArgs).not.toContain(sampleToken);
      expect(recordedArgs).not.toContain("--token");
      expect(recordedToken).toBe(sampleToken);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    const trackedFiles = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      {
        cwd: rootDir,
        encoding: "utf8",
      },
    )
      .split(/\r?\n/)
      .filter((relPath) => relPath.length > 0 && relPath !== "package-lock.json");

    const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff2", ".wasm"]);
    const pemHeaderPattern = new RegExp(
      `-----BEGIN (?:RSA |EC |OPENSSH |DSA )?${["PRIVATE", "KEY"].join(" ")}-----`,
    );
    const githubPatPattern = new RegExp(
      `\\b(?:${"ghp"}|${"gho"}|${"github_pat"})_[A-Za-z0-9_]{16,}\\b`,
    );
    const awsKeyPattern = new RegExp(`\\b${"AKIA"}[0-9A-Z]{16}\\b`);
    const privateIpv4Pattern =
      /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
    const localAbsPathPattern = new RegExp(
      `(?:file://)?(?:/${"Users"}/[A-Za-z0-9._-]+/|/${"home"}/[A-Za-z0-9._-]+/|[A-Za-z]:\\\\${"Users"}\\\\[A-Za-z0-9._-]+\\\\)`,
    );

    for (const relPath of trackedFiles) {
      const ext = path.extname(relPath).toLowerCase();
      if (binaryExtensions.has(ext)) {
        continue;
      }
      const absPath = path.join(rootDir, relPath);
      if (!fs.existsSync(absPath)) {
        continue;
      }
      const content = fs.readFileSync(absPath, "utf8");
      expect(content, `${relPath} must not contain PEM private key`).not.toMatch(pemHeaderPattern);
      expect(content, `${relPath} must not contain GitHub PAT`).not.toMatch(githubPatPattern);
      expect(content, `${relPath} must not contain AWS access key`).not.toMatch(awsKeyPattern);
      expect(content, `${relPath} must not contain RFC1918 private IP`).not.toMatch(
        privateIpv4Pattern,
      );
      expect(content, `${relPath} must not contain local absolute path`).not.toMatch(
        localAbsPathPattern,
      );
    }
  });
});
