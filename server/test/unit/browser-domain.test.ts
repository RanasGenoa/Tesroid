import { describe, it } from "vitest";

describe("server/domains/browser (Spec 06)", () => {
  it.todo(
    "AC-01: builds Chrome launch args with --app=<homeUrl>, basic password store, VAAPI video decode, PulseAudio UNIX socket env, and zero prohibited GPU flags",
  );
  it.todo(
    "AC-02: applies 8px slop, 80ms/15px debounce (promoting >8px drag to touchStart), 2,500ms stuck-touch cancel via CDP, and sanitizes text/wheel fallback on X11 when CDP disconnected",
  );
  it.todo(
    "AC-03: builds single-source init script suppressing WebAuthn platform authenticators (NotAllowedError on publicKey, passthrough otherwise, idempotent on re-injection) and sanitizes Chrome Preferences",
  );
  it.todo(
    "AC-04: clamps displayScale to [50, 250]% (default 100%), enforces virtual Web fullscreen matching window dims, and locks video player volume to 100% unmuted",
  );
  it.todo(
    "AC-05: freezes process tree with SIGSTOP bottom-up (descendants -> root) and resumes with SIGCONT top-down (root -> descendants), guarding against PPID cycles",
  );
});
