import { AudioPlayer } from './core/audio-player.js';
import { AvSyncController } from './core/av-sync.js';
import { ClientProtocol } from './transport/protocol.js';
import { WsClient } from './transport/ws-client.js';
import { showToast } from './views/icons.js';
import { renderLockoutView } from './views/lockout.js';
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
  private remainingAttempts: number = 10;
  private cleanupCurrentView: (() => void) | null = null;
  private isStreaming: boolean = false;

  constructor() {
    this.appEl = document.getElementById('app')!;
    this.wsClient = new WsClient();
    this.avSync = new AvSyncController();
    this.audioPlayer = new AudioPlayer(this.avSync);

    // Restore cached token if available
    try {
      this.authToken = sessionStorage.getItem('tesroid_token');
    } catch {
      this.authToken = null;
    }

    this.bindWsEvents();
  }

  public async init(): Promise<void> {
    try {
      const res = await fetch('/api/status');
      const status = await res.json();

      this.remainingAttempts = status.remainingAttempts ?? 10;

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
      async (pin: string) => {
        this.currentPin = pin;

        // Unlock AudioContext inside tap gesture
        await this.audioPlayer.unlock();

        // Connect WebSocket and send auth
        if (!this.wsClient.isConnected()) {
          this.wsClient.connect();
        }

        // Send auth packet immediately if connected, or the 'open' handler will send it
        this.wsClient.send(ClientProtocol.packAuth(pin));
      },
      () => {
        this.openSettings();
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
    );
  }

  private showLockout(): void {
    this.clearView();
    this.wsClient.close();
    renderLockoutView(this.appEl);
  }

  private openSettings(): void {
    openSettingsWithAuth(
      this.appEl,
      this.authToken,
      (callback) => {
        // Simple prompt for PIN re-auth if no valid session
        const pin = prompt('設定にアクセスするにはPINコードを入力してください:');
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
        try {
          sessionStorage.setItem('tesroid_token', msg.token);
        } catch {}

        if (!this.isStreaming) {
          this.isStreaming = true;
          this.showStreaming();
        }
      } else if (msg.type === 'AUTH_FAILED') {
        try {
          sessionStorage.removeItem('tesroid_token');
        } catch {}
        this.authToken = null;
        this.currentPin = null;

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
      }
    });

    this.wsClient.on('close', (ev) => {
      if (ev.code === 1008) {
        // Policy violation / lockout
        try {
          sessionStorage.removeItem('tesroid_token');
        } catch {}
        this.authToken = null;
        this.showLockout();
      }
    });
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
