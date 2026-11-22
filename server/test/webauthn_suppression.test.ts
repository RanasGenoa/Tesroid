import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWebAuthnSuppressorScript,
  loadWebAuthnCoreScript,
  WEBAUTHN_CORE_END_MARKER,
  WEBAUTHN_CORE_START_MARKER,
} from '../src/browser/webauthn-script.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('WebAuthn / Passkey Suppression (Issue #35)', () => {
  const extContentJs = fs.readFileSync(path.resolve(__dirname, '../extension/content.js'), 'utf-8');

  const createMockEnvironment = () => {
    const origGet = vi.fn().mockResolvedValue({ id: 'mock-cred' });
    const origCreate = vi.fn().mockResolvedValue({ id: 'mock-new-cred' });

    class MockPublicKeyCredential {
      public static isUserVerifyingPlatformAuthenticatorAvailable = vi.fn().mockResolvedValue(true);
      public static isConditionalMediationAvailable = vi.fn().mockResolvedValue(true);
    }

    const mockCredentials = {
      get: origGet,
      create: origCreate,
    };

    const mockNavigator = {
      credentials: mockCredentials,
    };

    const mockDoc: any = {
      cookie: '',
      head: { appendChild: vi.fn() },
      documentElement: {
        style: {
          setProperty: vi.fn(),
          getPropertyValue: vi.fn(),
        },
        classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn() },
      },
      body: {
        classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn() },
      },
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ id: '', textContent: '', style: {} }),
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
    };

    class FakeElement {
      public classList = { add: vi.fn(), remove: vi.fn(), contains: vi.fn() };
      public style: any = {};
      public removeAttribute() {}
      public dispatchEvent() {
        return true;
      }
    }

    const mockWin: any = {
      document: mockDoc,
      navigator: mockNavigator,
      PublicKeyCredential: MockPublicKeyCredential,
      DOMException: globalThis.DOMException,
      Element: FakeElement,
      Event: class {
        type: string;
        constructor(t: string) {
          this.type = t;
        }
      },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      setInterval: vi.fn(() => 1),
    };

    const ctx = vm.createContext({
      window: mockWin,
      document: mockDoc,
      navigator: mockNavigator,
      PublicKeyCredential: MockPublicKeyCredential,
      DOMException: globalThis.DOMException,
      Element: FakeElement,
      Event: mockWin.Event,
      setInterval: mockWin.setInterval,
      Promise,
      Object,
      Number,
      String,
      isNaN,
      console,
    });

    return { ctx, mockWin, mockNavigator, MockPublicKeyCredential, origGet, origCreate };
  };

  it('overrides isUserVerifyingPlatformAuthenticatorAvailable and isConditionalMediationAvailable to return false', async () => {
    const { ctx, mockWin } = createMockEnvironment();

    vm.runInContext(extContentJs, ctx);

    const isAvailable =
      await mockWin.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    expect(isAvailable).toBe(false);

    const isConditionalAvailable =
      await mockWin.PublicKeyCredential.isConditionalMediationAvailable();
    expect(isConditionalAvailable).toBe(false);
  });

  it('rejects navigator.credentials.get with NotAllowedError when publicKey option is passed', async () => {
    const { ctx, mockNavigator, origGet } = createMockEnvironment();

    vm.runInContext(extContentJs, ctx);

    const publicKeyOptions = {
      publicKey: {
        challenge: new Uint8Array([1, 2, 3]),
        rpId: 'google.com',
      },
    };

    let caughtError: any = null;
    try {
      await mockNavigator.credentials.get(publicKeyOptions);
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError.name).toBe('NotAllowedError');
    expect(caughtError.message).toContain('Passkeys are not supported in this environment');
    expect(origGet).not.toHaveBeenCalled();
  });

  it('delegates navigator.credentials.get to original method when publicKey option is not present', async () => {
    const { ctx, mockNavigator, origGet } = createMockEnvironment();

    vm.runInContext(extContentJs, ctx);

    const passwordOptions = { password: true } as any;
    const result = await mockNavigator.credentials.get(passwordOptions);

    expect(origGet).toHaveBeenCalledWith(passwordOptions);
    expect(result).toEqual({ id: 'mock-cred' });

    // Also handles undefined options safely
    origGet.mockClear();
    await mockNavigator.credentials.get();
    expect(origGet).toHaveBeenCalledWith(undefined);
  });

  it('rejects navigator.credentials.create with NotAllowedError when publicKey option is passed', async () => {
    const { ctx, mockNavigator, origCreate } = createMockEnvironment();

    vm.runInContext(extContentJs, ctx);

    const createOptions = {
      publicKey: {
        challenge: new Uint8Array([4, 5, 6]),
        rp: { name: 'Google' },
        user: { id: new Uint8Array([1]), name: 'test', displayName: 'Test' },
      },
    };

    let caughtError: any = null;
    try {
      await mockNavigator.credentials.create(createOptions);
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError.name).toBe('NotAllowedError');
    expect(caughtError.message).toContain('Passkeys are not supported in this environment');
    expect(origCreate).not.toHaveBeenCalled();
  });

  it('delegates navigator.credentials.create to original method when publicKey option is not present', async () => {
    const { ctx, mockNavigator, origCreate } = createMockEnvironment();

    vm.runInContext(extContentJs, ctx);

    const nonPasskeyOptions = { federated: { provider: 'https://example.com' } } as any;
    const result = await mockNavigator.credentials.create(nonPasskeyOptions);

    expect(origCreate).toHaveBeenCalledWith(nonPasskeyOptions);
    expect(result).toEqual({ id: 'mock-new-cred' });
  });

  it('prevents infinite recursion and safely handles double execution', async () => {
    const { ctx, mockNavigator, origGet } = createMockEnvironment();

    // Execute script twice (simulating extension + CDP injection)
    vm.runInContext(extContentJs, ctx);
    // Reset window._tesroidExtensionLoaded so body runs again
    ctx.window._tesroidExtensionLoaded = false;
    vm.runInContext(extContentJs, ctx);

    const nonPasskeyOptions = { password: true } as any;
    await mockNavigator.credentials.get(nonPasskeyOptions);
    expect(origGet).toHaveBeenCalledTimes(1);

    const publicKeyOptions = { publicKey: {} };
    await expect(mockNavigator.credentials.get(publicKeyOptions)).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });

  it('validates BrowserManager uses buildWebAuthnSuppressorScript() and executes all invariants in vm', async () => {
    const managerSource = fs.readFileSync(
      path.resolve(__dirname, '../src/browser/manager.ts'),
      'utf-8',
    );
    const coreScript = loadWebAuthnCoreScript();
    const suppressorScript = buildWebAuthnSuppressorScript();

    expect(extContentJs).toContain(WEBAUTHN_CORE_START_MARKER);
    expect(extContentJs).toContain(WEBAUTHN_CORE_END_MARKER);
    expect(extContentJs).toContain(coreScript);
    expect(suppressorScript).toContain(coreScript);
    expect(suppressorScript).toContain(
      'isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false)',
    );
    expect(suppressorScript).toContain(
      "createNotAllowedError('Passkeys are not supported in this environment.')",
    );
    expect(managerSource).toContain('buildWebAuthnSuppressorScript()');
    expect(managerSource).toContain('Page.addScriptToEvaluateOnNewDocument');

    // Verify the generated script itself executes and enforces all WebAuthn invariants in vm
    const { ctx, mockWin, mockNavigator, origGet, origCreate } = createMockEnvironment();
    vm.runInContext(`(() => { ${suppressorScript} })()`, ctx);

    expect(await mockWin.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).toBe(
      false,
    );
    expect(await mockWin.PublicKeyCredential.isConditionalMediationAvailable()).toBe(false);
    await expect(mockNavigator.credentials.get({ publicKey: {} })).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
    await expect(mockNavigator.credentials.create({ publicKey: {} })).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
    expect(origGet).not.toHaveBeenCalled();
    expect(origCreate).not.toHaveBeenCalled();

    // Double-execution via buildWebAuthnSuppressorScript() stays idempotent
    vm.runInContext(`(() => { ${suppressorScript} })()`, ctx);
    await mockNavigator.credentials.get({ password: true } as any);
    expect(origGet).toHaveBeenCalledTimes(1);
  });

  it('validates CdpTouchBridge in xdotool.ts delegates to buildWebAuthnSuppressorScript() and keeps setAutoAttach', async () => {
    const xdotoolSource = fs.readFileSync(
      path.resolve(__dirname, '../src/input/xdotool.ts'),
      'utf-8',
    );
    const suppressorScript = buildWebAuthnSuppressorScript();

    // CdpTouchBridge holds the persistent WebSocket connection across navigations
    expect(xdotoolSource).toContain('buildWebAuthnSuppressorScript()');
    expect(xdotoolSource).toContain('Target.setAutoAttach');
    expect(xdotoolSource).toContain('Page.addScriptToEvaluateOnNewDocument');
    expect(suppressorScript).toContain(
      'isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false)',
    );
    expect(suppressorScript).toContain(
      "createNotAllowedError('Passkeys are not supported in this environment.')",
    );
  });

  it('validates manifest.json specifies host_permissions <all_urls> for cross-origin navigation', () => {
    const manifestPath = path.resolve(__dirname, '../extension/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });
});
