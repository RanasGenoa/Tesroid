import { TouchInputProcessor, ViewportResizeReporter } from "./input/index.js";
import { type CanvasElementLike, PlaybackController } from "./media/index.js";
import { ClientMetricsCollector, ClientTelemetryReporter } from "./observability/index.js";
import { AppStore, BrowserTabSessionStorage } from "./state/index.js";
import { FetchRestApiClient, ReconnectingWsClient } from "./transport/index.js";
import {
  AppModalsView,
  HudBarView,
  PinAndStatusViews,
  SettingsModalView,
  SetupWizardView,
  ViewportOverlayView,
} from "./ui/index.js";

export interface ClientAppHandle {
  readonly store: AppStore;
  dispose(): void;
}

// Spec: docs/architecture.md#1.3
export function bootstrapClientApp(root: HTMLElement): ClientAppHandle {
  const doc = root.ownerDocument ?? globalThis.document;
  const hudRoot = root.querySelector("#hud-root") as HTMLElement | null;
  const viewportRoot = root.querySelector("#viewport-root") as HTMLElement | null;
  const canvas = root.querySelector("#stream-canvas") as HTMLCanvasElement | null;
  const overlayRoot = root.querySelector("#overlay-root") as HTMLElement | null;
  const modalRoot = root.querySelector("#modal-root") as HTMLElement | null;

  const rest = new FetchRestApiClient();
  const transport = new ReconnectingWsClient();
  const sessionStorage = new BrowserTabSessionStorage();
  const metrics = new ClientMetricsCollector({ transport });
  const telemetry = new ClientTelemetryReporter({ transport });

  let storeRef: AppStore | null = null;
  const playback = new PlaybackController({
    transport,
    onRequestStreamReset: () => {
      void storeRef?.requestStreamReset();
    },
  });

  const store = new AppStore({
    rest,
    transport,
    playback,
    sessionStorage,
    telemetry,
    metrics,
  });
  storeRef = store;

  if (canvas !== null) {
    playback.attachCanvas(canvas as unknown as CanvasElementLike);
  }

  const touchProcessor = new TouchInputProcessor({
    onTouchFrame: (frame) => {
      store.sendTouchFrame(frame);
    },
    onUserInteraction: (atMs) => {
      store.notifyUserInteraction(atMs);
      void store.unlockAudioOnGesture();
    },
  });
  if (canvas !== null) {
    touchProcessor.attach(canvas);
  }

  const resizeReporter = new ViewportResizeReporter({
    onResizeFrame: (frame) => {
      store.sendResizeFrame(frame);
      touchProcessor.updateStreamDimensions(frame.width, frame.height);
      metrics.setViewportMetrics(frame.width, frame.height, frame.dprX100 / 100);
    },
  });
  if (viewportRoot !== null) {
    resizeReporter.attach(viewportRoot);
  }

  const setupHost = doc.createElement("div");
  setupHost.setAttribute("data-testid", "setup-screen-host");
  root.appendChild(setupHost);

  const pinStatusHost = doc.createElement("div");
  pinStatusHost.setAttribute("data-testid", "pin-status-screen-host");
  root.appendChild(pinStatusHost);

  const appModalHost = doc.createElement("div");
  appModalHost.setAttribute("data-testid", "app-modal-host");
  const settingsModalHost = doc.createElement("div");
  settingsModalHost.setAttribute("data-testid", "settings-modal-host");
  if (modalRoot !== null) {
    modalRoot.appendChild(appModalHost);
    modalRoot.appendChild(settingsModalHost);
  }

  const hudView = new HudBarView(store);
  const overlayView = new ViewportOverlayView(store);
  const setupView = new SetupWizardView(store);
  const pinStatusView = new PinAndStatusViews(store);
  const modalsView = new AppModalsView(store);
  const settingsView = new SettingsModalView(store);

  if (hudRoot !== null) {
    hudView.mount(hudRoot);
  }
  if (overlayRoot !== null) {
    overlayView.mount(overlayRoot);
  }
  setupView.mount(setupHost);
  pinStatusView.mount(pinStatusHost);
  if (modalRoot !== null) {
    modalsView.mount(appModalHost);
    settingsView.mount(settingsModalHost);
  }

  const unsubscribe = store.subscribe((nextState) => {
    hudView.render(nextState);
    overlayView.render(nextState);
    setupView.render(nextState);
    pinStatusView.render(nextState);
    modalsView.render(nextState);
    settingsView.render(nextState);
  });

  void store.bootstrap();

  return {
    store,
    dispose: () => {
      unsubscribe();
      hudView.unmount();
      overlayView.unmount();
      setupView.unmount();
      pinStatusView.unmount();
      modalsView.unmount();
      settingsView.unmount();
      touchProcessor.detach();
      resizeReporter.detach();
      playback.dispose();
      telemetry.dispose();
      store.dispose();
    },
  };
}

if (typeof globalThis.document !== "undefined") {
  const mountRoot = globalThis.document.getElementById("app");
  if (mountRoot !== null) {
    bootstrapClientApp(mountRoot);
  }
}
