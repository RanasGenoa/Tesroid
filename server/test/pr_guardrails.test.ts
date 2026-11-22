import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_FLAGS as CLIENT_AUDIO_FLAGS,
  VIDEO_FLAGS as CLIENT_VIDEO_FLAGS,
  WSS_CHANNEL as CLIENT_WSS_CHANNEL,
} from '../../client/src/transport/protocol.js';
import {
  buildWebAuthnSuppressorScript,
  WEBAUTHN_CORE_END_MARKER,
  WEBAUTHN_CORE_START_MARKER,
} from '../src/browser/webauthn-script.js';
import {
  AUDIO_FLAGS as SERVER_AUDIO_FLAGS,
  VIDEO_FLAGS as SERVER_VIDEO_FLAGS,
  WSS_CHANNEL as SERVER_WSS_CHANNEL,
} from '../src/ws/protocol.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

function walkWorkspaceFiles(dir: string, out: string[] = []): string[] {
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', '.cache', 'data']);
  const ignoredFiles = new Set(['.git', '.env', 'PRIVATE_ENVIRONMENT.md', 'package-lock.json']);

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name) && !entry.name.startsWith('tmp-')) {
        walkWorkspaceFiles(path.join(dir, entry.name), out);
      }
    } else if (!ignoredFiles.has(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('Contributor PR Quality & Architectural Guardrails (AGENTS.md)', () => {
  it('maintains 100% bit-exact binary protocol constant symmetry between client and server', () => {
    expect(CLIENT_WSS_CHANNEL).toEqual(SERVER_WSS_CHANNEL);
    expect(CLIENT_VIDEO_FLAGS).toEqual(SERVER_VIDEO_FLAGS);
    expect(CLIENT_AUDIO_FLAGS).toEqual(SERVER_AUDIO_FLAGS);
  });

  it('enforces Xvfb + VAAPI hybrid rendering rules and forbids compositor-deadlocking Chrome flags', () => {
    const managerSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'server/src/browser/manager.ts'),
      'utf-8',
    );
    const codeOnly = managerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Forbidden anti-patterns (AGENTS.md §5.1 & docs/OPTIMIZATION_KNOWLEDGE.md §2, §6)
    expect(codeOnly).not.toContain('--enable-gpu-rasterization');
    expect(codeOnly).not.toContain('--enable-zero-copy');
    expect(codeOnly).not.toContain('--disable-gpu-vsync');
    expect(codeOnly).not.toContain('--disable-frame-rate-limit');
    expect(codeOnly).not.toContain('CanvasOopRasterization');

    // Mandatory hardware decode, container audio, touch & loopback-only CDP security flags
    expect(codeOnly).toContain('AcceleratedVideoDecodeLinuxGL');
    expect(codeOnly).toContain('--render-node-override=');
    expect(codeOnly).toContain('Av1Decoder');
    expect(codeOnly).toContain('AudioServiceSandbox');
    expect(codeOnly).toContain('--touch-events=enabled');
    expect(codeOnly).toContain('--remote-debugging-address=127.0.0.1');
    expect(codeOnly).not.toContain('--remote-debugging-address=0.0.0.0');
  });

  it('preserves PulseAudio UNIX socket and zero-latency FFmpeg encoding invariants', () => {
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf-8');
    const managerSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'server/src/browser/manager.ts'),
      'utf-8',
    );
    const ffmpegSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'server/src/encoder/ffmpeg.ts'),
      'utf-8',
    );

    // Dedicated /etc/pulse/tesroid.pa & UNIX socket /tmp/pulse-socket + virtual_sink
    expect(dockerfile).toContain('/etc/pulse/tesroid.pa');
    expect(dockerfile).toContain('/tmp/pulse-socket');
    expect(dockerfile).toContain('/etc/libva.conf');
    expect(dockerfile).toContain('i965-va-driver-shaders');
    expect(dockerfile).toContain('libpci3');
    expect(managerSrc).toContain('unix:/tmp/pulse-socket');
    expect(managerSrc).toContain('virtual_sink');
    expect(ffmpegSrc).toContain('unix:/tmp/pulse-socket');
    expect(ffmpegSrc).toContain('virtual_sink.monitor');

    // Zero B-frames (-bf 0) and explicit AUD insertion for deterministic WebCodecs frame boundaries
    expect(ffmpegSrc).toMatch(/['"]-bf['"]\s*,\s*['"]0['"]/);
    expect(ffmpegSrc).toContain('h264_metadata=aud=insert');
  });

  it('preserves dual-watermark hysteresis backpressure and CDP native touch priority', () => {
    const wsHandlerSrc = fs.readFileSync(path.join(REPO_ROOT, 'server/src/ws/handler.ts'), 'utf-8');
    const xdotoolSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'server/src/input/xdotool.ts'),
      'utf-8',
    );
    const canvasRendererSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'client/src/core/canvas-renderer.ts'),
      'utf-8',
    );

    expect(wsHandlerSrc).toContain('HIGH_WATER_MARK');
    expect(wsHandlerSrc).toContain('LOW_WATER_MARK');
    expect(xdotoolSrc).toContain('Input.dispatchTouchEvent');
    expect(xdotoolSrc).toContain('this.cdpBridge.handleTouch');
    expect(canvasRendererSrc).toContain('desynchronized: true');
    expect(canvasRendererSrc).toContain('frame.close()');
  });

  it('preserves WebAuthn suppression in extension content script, BrowserManager and persistent CdpTouchBridge', () => {
    const extContentJs = fs.readFileSync(
      path.join(REPO_ROOT, 'server/extension/content.js'),
      'utf-8',
    );
    const managerSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'server/src/browser/manager.ts'),
      'utf-8',
    );
    const xdotoolSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'server/src/input/xdotool.ts'),
      'utf-8',
    );

    const webauthnScriptTs = fs.readFileSync(
      path.join(REPO_ROOT, 'server/src/browser/webauthn-script.ts'),
      'utf-8',
    );
    const suppressorScript = buildWebAuthnSuppressorScript();

    // Canonical WebAuthn suppressor lives in content.js and is shared via buildWebAuthnSuppressorScript()
    expect(extContentJs).toContain(WEBAUTHN_CORE_START_MARKER);
    expect(extContentJs).toContain(WEBAUTHN_CORE_END_MARKER);
    expect(webauthnScriptTs).toContain('loadContentScriptSection');
    expect(webauthnScriptTs).not.toContain('isUserVerifyingPlatformAuthenticatorAvailable');

    for (const src of [extContentJs, suppressorScript]) {
      expect(src).toContain('isUserVerifyingPlatformAuthenticatorAvailable');
      expect(src).toContain('isConditionalMediationAvailable');
      expect(src).toContain('Passkeys are not supported in this environment');
      expect(src).toContain('NotAllowedError');
      expect(src).toContain('_tesroidWebAuthnHooked');
    }

    expect(managerSrc).toContain('buildWebAuthnSuppressorScript()');
    expect(xdotoolSrc).toContain('buildWebAuthnSuppressorScript()');
  });

  it('preserves Chrome password save and autofill Views Bubble suppression in BrowserManager (Issue #44)', () => {
    const managerSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'server/src/browser/manager.ts'),
      'utf-8',
    );
    const codeOnly = managerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(codeOnly).toContain('credentials_enable_service');
    expect(codeOnly).toContain('credentials_enable_autosignin');
    expect(codeOnly).toContain('password_manager_enabled');
    expect(codeOnly).toContain('password_manager_leak_detection');
    expect(codeOnly).toContain('profile_enabled');
    expect(codeOnly).toContain('credit_card_enabled');
    expect(codeOnly).toContain('--password-store=basic');
  });

  it('prevents accidental commits of private keys, local developer paths, or Chrome image registry pushes', () => {
    const files = walkWorkspaceFiles(REPO_ROOT);
    const selfPath = path.resolve(__filename);

    const privateKeyPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
    const localHomePathPattern =
      /\/(Users|home)\/(?!ubuntu|chrome|node|runner|user\b)[a-zA-Z0-9_-]+\//;

    for (const filePath of files) {
      if (path.resolve(filePath) === selfPath) continue;
      let content: string;
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 512 * 1024) continue;
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (err: any) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      const rel = path.relative(REPO_ROOT, filePath);

      expect(content, `Private key material detected in ${rel}`).not.toMatch(privateKeyPattern);
      expect(content, `Hardcoded host user path detected in ${rel}`).not.toMatch(
        localHomePathPattern,
      );

      if (rel.startsWith('.github/workflows/') || rel.startsWith('scripts/')) {
        expect(
          content,
          `Forbidden public container registry push detected in ${rel} (Google Chrome redistribution rule)`,
        ).not.toMatch(/\bdocker\s+push\b/);
      }
    }
  });

  it('ensures AI PR review workflow isolates concurrency groups by event name to prevent race cancellation', () => {
    const aiReviewWorkflow = fs.readFileSync(
      path.join(REPO_ROOT, '.github/workflows/ai-review.yml'),
      'utf-8',
    );
    expect(aiReviewWorkflow).toMatch(
      /group:\s*\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.event_name\s*\}\}-\$\{\{\s*github\.event\.pull_request\.number\s*\|\|\s*github\.ref\s*\}\}/,
    );
  });

  it('enforces touch-only / no physical keyboard or mouse assumption guardrail in AGENTS.md and AI review workflow', () => {
    const agentsMd = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
    const aiReviewWorkflow = fs.readFileSync(
      path.join(REPO_ROOT, '.github/workflows/ai-review.yml'),
      'utf-8',
    );
    const optimizationKnowledge = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/OPTIMIZATION_KNOWLEDGE.md'),
      'utf-8',
    );

    expect(agentsMd).toMatch(/タッチオンリー/);
    expect(agentsMd).toMatch(/物理キーボード.*マウス|マウス.*物理キーボード/);
    expect(agentsMd).toContain('Escape');

    expect(aiReviewWorkflow).toMatch(/タッチオンリー/);
    expect(aiReviewWorkflow).toMatch(/物理キーボード.*マウス|マウス.*物理キーボード/);
    expect(aiReviewWorkflow).toContain('Escape');

    expect(optimizationKnowledge).toMatch(/タッチオンリー/);
    expect(optimizationKnowledge).toMatch(/物理キーボード.*マウス|マウス.*物理キーボード/);
  });
});
