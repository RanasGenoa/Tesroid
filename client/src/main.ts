import { AudioPlayer } from './core/audio-player.js';
import { AvSyncController } from './core/av-sync.js';
import { ClientProtocol, WS_CLOSE_CODE } from './transport/protocol.js';
import { WsClient } from './transport/ws-client.js';
import { showToast } from './views/icons.js';
import { renderLockoutView } from './views/lockout.js';
import { openOnboardingGuideModal } from './views/onboarding.js';
import { renderPinEntry } from './views/pin-entry.js';
import { openSettingsWithAuth } from './views/settings-modal.js';
import { renderSetupWizard } from './views/setup-wizard.js';
import { renderStreamingView } from './views/streaming.js';

class AppRouter {
  private appEl: HTMLElement;
  private wsClient: WsClient;
  private avSync: AvSyncController;
  private audioPlayer: AudioPlayer;

  private authToken: string | null = null;
  private currentPin: string | null = null;
  private hasActiveSession: boolean = false;
  private primarySessionActive: boolean = true;
  private sessionRole: 'primary' | 'secondary' = 'primary';
  private remainingAttempts: number = 10;
  private cleanupCurrentView: (() => void) | null = null;
  private isStreaming: boolean = false;

  constructor() {
    this.appEl = document.getElementById('app')!;
    this.wsClient = new WsClient();
    this.avSync = new AvSyncController();
    this.audioPlayer = new AudioPlayer(this.avSync);

    // Restore cached token and role if available
    try {
      this.authToken = sessionStorage.getItem('tesroid_token');
      const savedRole = sessionStorage.getItem('tesroid_role');
      if (savedRole === 'primary' || savedRole === 'secondary') {
        this.sessionRole = savedRole;
      }
    } catch {
      this.authToken = null;
      this.sessionRole = 'primary';
    }

    this.bindWsEvents();
  }

  public async init(): Promise<void> {
    try {
      const res = await fetch('/api/status');
      const status = await res.json();

      this.remainingAttempts = status.remainingAttempts ?? 10;
      this.hasActiveSession = Boolean(status.hasActiveSession);
      this.primarySessionActive = this.hasActiveSession;

      if (status.consecutiveFailures >= 10) {
        this.showLockout();
        return;
      }

      if (!status.isSetupCompleted) {
        this.showSetupWizard();
      } else {
        this.showPinEntry();
      }
    } catch (err) {
      console.warn('Status check failed, falling back to PIN entry:', err);
      this.showPinEntry();
    }
  }

  private showSetupWizard(): void {
    this.clearView();
    renderSetupWizard(this.appEl, () => {
      this.showPinEntry();
    });
  }

  private showPinEntry(): void {
    this.clearView();
    renderPinEntry(
      this.appEl,
      this.remainingAttempts,
      async (pin: string, isSecondary?: boolean) => {
        const authPayload = isSecondary ? `SECONDARY:${pin}` : pin;
        this.sessionRole = isSecondary ? 'secondary' : 'primary';
        this.primarySessionActive = isSecondary ? this.hasActiveSession : true;
        this.currentPin = authPayload;
        this.authToken = null;

        // Unlock AudioContext inside tap gesture (disabled for secondary display sessions)
        if (!isSecondary) {
          await this.audioPlayer.unlock();
        }

        // Connect WebSocket and send auth
        if (!this.wsClient.isConnected()) {
          this.wsClient.connect();
        }

        // Send auth packet immediately if connected, or the 'open' handler will send it
        this.wsClient.send(ClientProtocol.packAuth(authPayload));
      },
      (enteredPin?: string) => {
        this.openSettings(enteredPin);
      },
      {
        hasActiveSession: this.hasActiveSession,
        onOpenGuide: () => openOnboardingGuideModal(this.appEl),
      },
    );
  }

  private showStreaming(): void {
    this.clearView();
    this.cleanupCurrentView = renderStreamingView(
      this.appEl,
      this.wsClient,
      this.audioPlayer,
      this.avSync,
      () => this.openSettings(),
      this.authToken,
      this.sessionRole,
      { initialPrimaryActive: this.primarySessionActive },
    );
  }

  private showLockout(): void {
    this.clearView();
    this.wsClient.close();
    renderLockoutView(this.appEl);
  }

  private openSettings(prefilledPin?: string): void {
    openSettingsWithAuth(
      this.appEl,
      this.authToken,
      (callback) => {
        // Use entered PIN if provided, otherwise prompt for PIN re-auth
        const pin =
          prefilledPin && prefilledPin.length >= 4
            ? prefilledPin
            : prompt('設定にアクセスするにはPINコードを入力してください:');
        if (pin) {
          fetch('/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
          })
            .then((r) => r.json())
            .then((data) => {
              if (data.success && data.token) {
                this.authToken = data.token;
                try {
                  sessionStorage.setItem('tesroid_token', data.token);
                } catch {}
                callback(data.token);
              } else {
                showToast(`認証エラー: ${data.error || 'PINが違います'}`, 'error');
                if (data.remainingAttempts <= 0) {
                  this.showLockout();
                }
              }
            })
            .catch(() => showToast('通信エラーが発生しました。', 'error'));
        }
      },
      () => {
        // Settings modal closed
      },
    );
  }

  private bindWsEvents(): void {
    // When connection is opened (or reconnected automatically on network recovery)
    this.wsClient.on('open', () => {
      console.log('[AppRouter] WebSocket connected.');
      // Prefer restoring with token if known, otherwise use cached PIN
      if (this.authToken) {
        console.log('[AppRouter] Auto-reauthenticating with stored session token...');
        this.wsClient.send(ClientProtocol.packAuth(`TOKEN:${this.authToken}`));
      } else if (this.currentPin) {
        console.log('[AppRouter] Reauthenticating with PIN...');
        this.wsClient.send(ClientProtocol.packAuth(this.currentPin));
      }
    });

    this.wsClient.on('control', (msg) => {
      if (msg.type === 'STATUS_UPDATE') {
        if (!this.isStreaming) {
          this.isStreaming = true;
          this.showStreaming();
        }
      } else if (msg.type === 'AUTH_SUCCESS') {
        this.authToken = msg.token;
        if (msg.role === 'secondary' || msg.role === 'primary') {
          this.sessionRole = msg.role;
        }
        try {
          sessionStorage.setItem('tesroid_token', msg.token);
          sessionStorage.setItem('tesroid_role', this.sessionRole);
        } catch {}

        if (!this.isStreaming) {
          this.isStreaming = true;
          this.showStreaming();
        }
      } else if (msg.type === 'AUTH_FAILED') {
        try {
          sessionStorage.removeItem('tesroid_token');
          sessionStorage.removeItem('tesroid_role');
        } catch {}
        this.authToken = null;
        this.currentPin = null;
        this.sessionRole = 'primary';

        this.remainingAttempts = msg.remainingAttempts ?? 0;
        if (this.remainingAttempts <= 0) {
          this.showLockout();
        } else {
          showToast(
            `PINコードが違います。（残り入力可能回数: ${this.remainingAttempts}回）`,
            'error',
          );
          this.showPinEntry();
        }
      } else if (msg.type === 'PRIMARY_SESSION_STATUS') {
        this.primarySessionActive = Boolean(msg.active);
      } else if (msg.type === 'SESSION_CONFLICT') {
        const nextHasActiveSession =
          typeof msg.hasActiveSession === 'boolean' ? msg.hasActiveSession : true;
        this.handleSessionConflict(msg.error, nextHasActiveSession);
      }
    });

    this.wsClient.on('close', (ev) => {
      if (ev.code === WS_CLOSE_CODE.POLICY_VIOLATION) {
        // Policy violation / lockout
        try {
          sessionStorage.removeItem('tesroid_token');
          sessionStorage.removeItem('tesroid_role');
        } catch {}
        this.authToken = null;
        this.sessionRole = 'primary';
        this.showLockout();
      } else if (
        ev.code === WS_CLOSE_CODE.SESSION_CONFLICT ||
        ev.code === WS_CLOSE_CODE.REPLACED_BY_RECONNECT
      ) {
        this.handleSessionConflict(undefined, this.hasActiveSession);
      }
    });
  }

  private handleSessionConflict(message?: string, hasActiveSession = true): void {
    const hadSession = Boolean(this.authToken || this.currentPin || this.isStreaming);
    try {
      sessionStorage.removeItem('tesroid_token');
      sessionStorage.removeItem('tesroid_role');
    } catch {}
    this.authToken = null;
    this.currentPin = null;
    this.sessionRole = 'primary';
    this.hasActiveSession = hasActiveSession;
    this.primarySessionActive = hasActiveSession;
    this.wsClient.close();
    if (hadSession || message) {
      showToast(
        message || '他の端末が接続中のため切断されました。PINを再入力してください。',
        'error',
        4000,
      );
    }
    this.showPinEntry();
  }

  private clearView(): void {
    this.isStreaming = false;
    if (this.cleanupCurrentView) {
      this.cleanupCurrentView();
      this.cleanupCurrentView = null;
    }
    this.appEl.innerHTML = '';
  }
}

// Start application
const router = new AppRouter();
router.init();
