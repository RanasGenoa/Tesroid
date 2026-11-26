import fs from "node:fs";
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

  it("Spec 01 AC-05 & Spec 07 AC-01: client source and built dist contain zero localStorage references", () => {
    const filesToInspect = [
      path.join(rootDir, "client/index.html"),
      ...collectFiles(path.join(rootDir, "client/src"), [".ts", ".html"]),
      ...collectFiles(path.join(rootDir, "client/dist"), [".js", ".html"]),
    ];

    for (const filePath of filesToInspect) {
      const content = fs.readFileSync(filePath, "utf8");
      expect(content, `${filePath} must not reference localStorage`).not.toMatch(
        /\blocalStorage\b/,
      );
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

  it.todo(
    "Spec 05 §3 & Spec 09 AC-03: no hardcoded driver in /etc/libva.conf, no forced default LIBVA_DRIVER_NAME in entrypoint, and GALLIUM_DRIVER=d3d12 never passed to Chrome",
  );
  it.todo(
    "Spec 09 AC-01/02/04: Dockerfile preserves no-systemd APT pinning (Pin-Priority: -1), dbus-x11, --no-install-recommends, and INSTALL_CHROME=false default for public builds",
  );
  it.todo(
    "Spec 09 AC-04: entrypoint never passes TUNNEL_TOKEN via CLI args, unsets TUNNEL_TOKEN before launching app/browser, and repository contains zero hardcoded secrets or private IPs",
  );
});
