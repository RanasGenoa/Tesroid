import { clampDisplayScale } from "@tesroid/shared";

export const PROHIBITED_CHROME_FLAGS = [
  "--enable-gpu-rasterization",
  "--enable-zero-copy",
  "--disable-gpu-vsync",
] as const;

export interface PageScriptConfig {
  readonly displayScale: number;
}

// Spec: docs/specs/06-browser-input-cdp.md#2.3
export function buildWebAuthnSuppressionScript(): string {
  return `(() => {
  const g = globalThis;
  if (g.__tesroidWebAuthnSuppressed) {
    return;
  }
  g.__tesroidWebAuthnSuppressed = true;

  const makeNotAllowedError = () => {
    if (typeof DOMException === "function") {
      return new DOMException("WebAuthn is disabled in Tesroid virtual browser", "NotAllowedError");
    }
    const err = new Error("WebAuthn is disabled in Tesroid virtual browser");
    err.name = "NotAllowedError";
    return err;
  };

  if (typeof PublicKeyCredential !== "undefined" && PublicKeyCredential !== null) {
    const denyAvailability = () => Promise.resolve(false);
    try {
      Object.defineProperty(PublicKeyCredential, "isUserVerifyingPlatformAuthenticatorAvailable", {
        value: denyAvailability,
        configurable: true,
        writable: true,
      });
    } catch {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = denyAvailability;
    }
    try {
      Object.defineProperty(PublicKeyCredential, "isConditionalMediationAvailable", {
        value: denyAvailability,
        configurable: true,
        writable: true,
      });
    } catch {
      PublicKeyCredential.isConditionalMediationAvailable = denyAvailability;
    }
  }

  const creds = typeof navigator !== "undefined" && navigator !== null ? navigator.credentials : null;
  if (!creds) {
    return;
  }

  const wrapCredentialMethod = (methodName) => {
    const original = typeof creds[methodName] === "function" ? creds[methodName].bind(creds) : null;
    if (!original || original.__tesroidWrapped) {
      return;
    }
    const wrapped = function (options) {
      if (options && typeof options === "object" && "publicKey" in options && options.publicKey !== undefined) {
        return Promise.reject(makeNotAllowedError());
      }
      return original(options);
    };
    wrapped.__tesroidWrapped = true;
    try {
      Object.defineProperty(creds, methodName, {
        value: wrapped,
        configurable: true,
        writable: true,
      });
    } catch {
      creds[methodName] = wrapped;
    }
  };

  wrapCredentialMethod("get");
  wrapCredentialMethod("create");
})();`;
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function buildDisplayScaleScript(displayScale: number): string {
  const clamped = clampDisplayScale(displayScale);
  return `(() => {
  const g = globalThis;
  g.__tesroidDisplayScale = ${clamped};

  const applyScale = (nextScale) => {
    const raw = typeof nextScale === "number" && Number.isFinite(nextScale) ? Math.min(250, Math.max(50, Math.round(nextScale))) : g.__tesroidDisplayScale;
    g.__tesroidDisplayScale = raw;
    const doc = g.document;
    if (!doc || !doc.documentElement || !doc.documentElement.style) {
      return;
    }
    const isVfs = Boolean(g.__tesroidVfsElement) || (doc.documentElement.classList && doc.documentElement.classList.contains("tesroid-vfs-active"));
    doc.documentElement.style.zoom = isVfs ? "1" : String(raw / 100);
  };

  g.__tesroidApplyDisplayScale = applyScale;
  applyScale(${clamped});

  if (g.document && !g.document.documentElement && typeof g.document.addEventListener === "function") {
    g.document.addEventListener("DOMContentLoaded", () => applyScale(g.__tesroidDisplayScale), { once: true });
  }
})();`;
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function buildVirtualFullscreenScript(): string {
  return `(() => {
  const g = globalThis;
  if (g.__tesroidVirtualFullscreenInstalled) {
    return;
  }
  g.__tesroidVirtualFullscreenInstalled = true;

  const win = g.window || g;
  const doc = g.document;
  const scr = win.screen || g.screen;

  if (scr) {
    const defineScreenDim = (prop, readDim) => {
      try {
        Object.defineProperty(scr, prop, {
          get: readDim,
          configurable: true,
        });
      } catch {
        // Ignore non-configurable screen properties.
      }
    };
    defineScreenDim("width", () => Number(win.innerWidth) || 0);
    defineScreenDim("availWidth", () => Number(win.innerWidth) || 0);
    defineScreenDim("height", () => Number(win.innerHeight) || 0);
    defineScreenDim("availHeight", () => Number(win.innerHeight) || 0);
  }

  const host = (g.location && typeof g.location.hostname === "string" ? g.location.hostname : "").toLowerCase();
  const isYouTubeHost = host === "youtube.com" || host.endsWith(".youtube.com");
  if (doc && isYouTubeHost) {
    try {
      doc.cookie = "wide=1; path=/; domain=.youtube.com";
      doc.cookie = "PREF=f6=400; path=/; domain=.youtube.com";
    } catch {
      // Ignore cookie assignment errors in restricted contexts.
    }
  }

  const injectStyle = () => {
    if (!doc || !doc.head || (typeof doc.getElementById === "function" && doc.getElementById("tesroid-vfs-style"))) {
      return;
    }
    if (typeof doc.createElement !== "function") {
      return;
    }
    const style = doc.createElement("style");
    style.id = "tesroid-vfs-style";
    style.textContent = [
      ".tesroid-vfs-active, .tesroid-vfs-active body { overflow: hidden !important; }",
      ".tesroid-vfs-target { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; z-index: 2147483647 !important; background: #000 !important; object-fit: contain !important; }",
      ".tesroid-vfs-active #masthead-container, .tesroid-vfs-active #guide-wrapper, .tesroid-vfs-active #secondary, .tesroid-vfs-active #below, .tesroid-vfs-active #comments, .tesroid-vfs-active #cinematics, .tesroid-vfs-active .player-container-background { display: none !important; }",
    ].join("\\n");
    doc.head.appendChild(style);
  };

  injectStyle();

  const dispatchFsEvent = () => {
    if (doc && typeof g.Event === "function" && typeof doc.dispatchEvent === "function") {
      doc.dispatchEvent(new g.Event("fullscreenchange"));
    }
  };

  const enterVfs = function () {
    const target = this;
    if (!target || !doc) {
      return Promise.resolve();
    }
    injectStyle();
    if (g.__tesroidVfsElement && g.__tesroidVfsElement !== target && g.__tesroidVfsElement.classList) {
      g.__tesroidVfsElement.classList.remove("tesroid-vfs-target");
    }
    g.__tesroidVfsElement = target;
    if (target.classList) {
      target.classList.add("tesroid-vfs-target");
    }
    if (doc.documentElement) {
      if (doc.documentElement.classList) {
        doc.documentElement.classList.add("tesroid-vfs-active");
      }
      if (doc.documentElement.style) {
        doc.documentElement.style.zoom = "1";
      }
    }
    dispatchFsEvent();
    return Promise.resolve();
  };

  const exitVfs = function () {
    const current = g.__tesroidVfsElement;
    if (current && current.classList) {
      current.classList.remove("tesroid-vfs-target");
    }
    g.__tesroidVfsElement = null;
    if (doc && doc.documentElement && doc.documentElement.classList) {
      doc.documentElement.classList.remove("tesroid-vfs-active");
    }
    if (typeof g.__tesroidApplyDisplayScale === "function") {
      g.__tesroidApplyDisplayScale();
    }
    dispatchFsEvent();
    return Promise.resolve();
  };

  const elemProto = typeof g.Element === "function" ? g.Element.prototype : null;
  if (elemProto) {
    elemProto.requestFullscreen = enterVfs;
    elemProto.webkitRequestFullscreen = enterVfs;
  }

  const docProto = typeof g.Document === "function" ? g.Document.prototype : null;
  if (docProto) {
    docProto.exitFullscreen = exitVfs;
    docProto.webkitExitFullscreen = exitVfs;
    try {
      Object.defineProperty(docProto, "fullscreenElement", {
        get: () => g.__tesroidVfsElement || null,
        configurable: true,
      });
      Object.defineProperty(docProto, "fullscreenEnabled", {
        get: () => true,
        configurable: true,
      });
    } catch {
      // Ignore if Document prototype properties are non-configurable.
    }
  }

  if (doc) {
    doc.exitFullscreen = exitVfs;
    doc.webkitExitFullscreen = exitVfs;
    try {
      Object.defineProperty(doc, "fullscreenElement", {
        get: () => g.__tesroidVfsElement || null,
        configurable: true,
      });
      Object.defineProperty(doc, "fullscreenEnabled", {
        get: () => true,
        configurable: true,
      });
    } catch {
      // Ignore if already inherited from Document prototype.
    }
  }

  g.__tesroidToggleFullscreen = () => {
    if (!doc) {
      return false;
    }
    if (g.__tesroidVfsElement) {
      void exitVfs.call(doc);
      return true;
    }
    const query = typeof doc.querySelector === "function" ? doc.querySelector.bind(doc) : null;
    const target = query ? query(".html5-video-player") || query("video") : null;
    if (!target) {
      return false;
    }
    if (typeof target.requestFullscreen === "function") {
      void target.requestFullscreen();
    } else {
      void enterVfs.call(target);
    }
    return true;
  };

  // YouTube は再生開始 2 秒後にフルスクリーンボタンを disabled 化するため、周期的に操作可能へ復元する。
  if (doc && isYouTubeHost) {
    const keepFullscreenButtonEnabled = () => {
      if (typeof doc.querySelector !== "function") {
        return;
      }
      const button = doc.querySelector(".ytp-fullscreen-button");
      if (button) {
        if (typeof button.removeAttribute === "function") {
          button.removeAttribute("disabled");
          button.removeAttribute("aria-disabled");
        }
        if (button.style && typeof button.style.setProperty === "function") {
          button.style.setProperty("pointer-events", "auto", "important");
        }
      }
      const player = doc.querySelector("#movie_player");
      if (player && typeof player.toggleFullscreen !== "function") {
        try {
          player.toggleFullscreen = () => g.__tesroidToggleFullscreen();
        } catch {
          // 非拡張のプレイヤーオブジェクトには接続しない。
        }
      }
    };
    keepFullscreenButtonEnabled();
    if (typeof g.setInterval === "function") {
      g.setInterval(keepFullscreenButtonEnabled, 2_000);
    }
    // ボタンタップは capture 位相で遮断し、プレイヤー内部の OS フルスクリーン要求を仮想化へ接続する。
    if (typeof doc.addEventListener === "function") {
      doc.addEventListener(
        "click",
        (event) => {
          const target = event && event.target;
          if (!target || typeof target.closest !== "function") {
            return;
          }
          if (target.closest(".ytp-fullscreen-button") === null) {
            return;
          }
          if (typeof event.preventDefault === "function") {
            event.preventDefault();
          }
          g.__tesroidToggleFullscreen();
        },
        true,
      );
      // SPA 遷移では旧動画のフルスクリーン対象と装飾が失効するため仮想フルスクリーンを自動解除する。
      doc.addEventListener("yt-navigate-start", () => {
        if (g.__tesroidVfsElement) {
          void exitVfs.call(doc);
        }
      });
    }
  }
})();`;
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function buildVolumeLockScript(): string {
  return `(() => {
  const g = globalThis;
  if (g.__tesroidVolumeLockInstalled) {
    return;
  }
  g.__tesroidVolumeLockInstalled = true;

  let enforcing = false;

  const enforceVolumeInner = () => {
    const doc = g.document;
    if (!doc || typeof doc.querySelectorAll !== "function") {
      return;
    }
    const mediaElements = doc.querySelectorAll("video, audio");
    for (const media of mediaElements) {
      if (media.muted !== false) {
        media.muted = false;
      }
      if (media.volume !== 1) {
        media.volume = 1;
      }
      if (typeof media.removeAttribute === "function") {
        media.removeAttribute("muted");
      }
    }
    if (typeof doc.querySelector === "function") {
      const ytPlayer = doc.querySelector("#movie_player");
      if (ytPlayer) {
        // 条件付き呼び出し: 音量100%・非ミュート成立中は再呼び出ししない。無条件呼び出しは
        // プレイヤー側の volumechange 再発火と相互に発火し合い main thread を飽和させる。
        const muted = typeof ytPlayer.isMuted === "function" ? Boolean(ytPlayer.isMuted()) : null;
        if (muted !== false && typeof ytPlayer.unMute === "function") {
          ytPlayer.unMute();
        }
        const volume = typeof ytPlayer.getVolume === "function" ? Number(ytPlayer.getVolume()) : null;
        if (volume !== 100 && typeof ytPlayer.setVolume === "function") {
          ytPlayer.setVolume(100);
        }
      }
    }
  };

  // 再入ガード: イベント経由の同期再突入を遮断し、収束後の恒久ループを構造的に成立させない。
  const enforceVolume = () => {
    if (enforcing) {
      return;
    }
    enforcing = true;
    try {
      enforceVolumeInner();
    } finally {
      enforcing = false;
    }
  };

  g.__tesroidEnforceVolume = enforceVolume;
  enforceVolume();

  if (g.document && typeof g.document.addEventListener === "function") {
    g.document.addEventListener("volumechange", enforceVolume, true);
    g.document.addEventListener("play", enforceVolume, true);
  }
  if (typeof g.setInterval === "function") {
    g.setInterval(enforceVolume, 2000);
  }
})();`;
}

// Spec: docs/specs/06-browser-input-cdp.md#2.1
export function buildVp9CodecPolicyScript(): string {
  return `(() => {
  if (globalThis.__tesroidCodecPolicy) { return; }
  globalThis.__tesroidCodecPolicy = true;
  const isBlockedVideoCodec = (type) => /vp0?9|av0?1/i.test(String(type || ""));
  if (typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function") {
    const nativeIsTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (type) =>
      isBlockedVideoCodec(type) ? false : nativeIsTypeSupported(type);
  }
  if (typeof navigator !== "undefined" && navigator.mediaCapabilities &&
      typeof navigator.mediaCapabilities.decodingInfo === "function") {
    const nativeDecodingInfo = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
    navigator.mediaCapabilities.decodingInfo = async (config) => {
      if (isBlockedVideoCodec(config && config.video && config.video.contentType)) {
        return { supported: false, smooth: false, powerEfficient: false };
      }
      return nativeDecodingInfo(config);
    };
  }
})();`;
}

// Spec: docs/specs/06-browser-input-cdp.md#2.4
export function buildCombinedPageInitScript(config: PageScriptConfig): string {
  return [
    buildWebAuthnSuppressionScript(),
    buildDisplayScaleScript(config.displayScale),
    buildVirtualFullscreenScript(),
    buildVolumeLockScript(),
    buildVp9CodecPolicyScript(),
  ].join("\n");
}
