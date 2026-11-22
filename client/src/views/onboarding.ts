import { escapeHtml, ICONS } from './icons.js';

interface OnboardingCardItem {
  icon: string;
  title: string;
  description: string;
}

interface OnboardingHudItem {
  badgeHtml: string;
  description: string;
}

interface OnboardingCardOptions {
  actionButtonId: string;
  actionButtonHtml: string;
  closeIconId?: string;
}

const CAPABILITY_ITEMS: OnboardingCardItem[] = [
  {
    icon: ICONS.play,
    title: 'Dレンジ走行中も停止しない視聴体験',
    description:
      '通常の動画プレーヤー要素を使わず WebCodecs による直接描画を行うため、走行中も動画やWebブラウザの視聴を継続できます。',
  },
  {
    icon: ICONS.globe,
    title: 'ログイン状態・設定をそのまま保持',
    description:
      'コンテナ内のブラウザプロファイルを永続化するため、一度ログインした動画サービスや設定を次回以降も引き継げます。',
  },
  {
    icon: ICONS.power,
    title: '自動省電力スタンバイ & 即時復帰',
    description:
      '切断や未操作が続くとサーバー負荷を自動で 0% に凍結し、再接続または画面タップですぐに再開できます。',
  },
  {
    icon: ICONS.lock,
    title: 'PIN 認証 & セキュリティ保護',
    description:
      '接続時の半角数字 4〜8 桁の PIN 認証に加え、10 回連続の誤入力でサーバーを自動緊急停止して不正アクセスを防ぎます。',
  },
];

const HUD_CONTROL_ITEMS: OnboardingHudItem[] = [
  {
    badgeHtml: `<span class="onboarding-icon">${ICONS.power}</span><span>停止</span>`,
    description: '省電力スタンバイへの移行、ブラウザ＆配信の再起動、セッション切断を行います。',
  },
  {
    badgeHtml: `<span class="onboarding-icon">${ICONS.zap}</span><span>30 / 60</span>・<span class="onboarding-icon">${ICONS.signal}</span><span>0.5M〜2.0M</span>`,
    description:
      '通信環境や走行状況に合わせて、フレームレート（FPS）とビットレートをワンタップで切り替えます。',
  },
  {
    badgeHtml: '<span>LIVE</span>',
    description:
      '回線瞬断による遅延や追っかけ再生の状態から、最新のライブ位置へ強制同期・再エンコードします。',
  },
  {
    badgeHtml: `<span class="onboarding-icon">${ICONS.back}</span> <span class="onboarding-icon">${ICONS.home}</span> <span class="onboarding-icon">${ICONS.star}</span><span>ナビ & お気に入り</span>`,
    description:
      '履歴を戻る、ホームサイトへ移動、お気に入り一覧の開閉や現在ページの追加を行います（YouTube閲覧時は専用検索バーも表示されます）。',
  },
  {
    badgeHtml: `<span class="onboarding-icon">${ICONS.settings}</span><span>設定・管理</span>`,
    description:
      'URL 直接移動、お気に入り編集・ホーム設定、表示拡大率・言語・先行バッファ深度（トンネル対策）・音質・PIN 変更、品質統計を確認できます。',
  },
];

function renderFeatureGrid(): string {
  return CAPABILITY_ITEMS.map(
    (item) => `
      <div class="onboarding-feature-item">
        <div class="onboarding-feature-head">
          <span class="onboarding-icon">${item.icon}</span>
          <span>${escapeHtml(item.title)}</span>
        </div>
        <p class="onboarding-feature-desc">${escapeHtml(item.description)}</p>
      </div>
    `,
  ).join('');
}

function renderHudControlList(): string {
  return HUD_CONTROL_ITEMS.map(
    (item) => `
      <div class="onboarding-hud-row">
        <div class="onboarding-hud-badge">${item.badgeHtml}</div>
        <p class="onboarding-hud-desc">${escapeHtml(item.description)}</p>
      </div>
    `,
  ).join('');
}

function buildOnboardingCardHtml(options: OnboardingCardOptions): string {
  const closeHeaderBtn = options.closeIconId
    ? `<button id="${options.closeIconId}" type="button" class="hud-btn" style="font-size: 20px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" title="閉じる">${ICONS.close}</button>`
    : '';

  return `
    <div class="card onboarding-card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
        <h2 style="margin-bottom: 8px;">Tesroid オンボーディングガイド</h2>
        ${closeHeaderBtn}
      </div>
      <p class="onboarding-subtitle">
        Tesroid でできることと車載ブラウザでの基本操作を確認できます。
      </p>

      <div class="onboarding-callout onboarding-callout-ssl">
        <div class="onboarding-callout-title">
          <span class="onboarding-icon" style="color: #f59e0b;">${ICONS.lock}</span>
          <span>前提条件: 公的 SSL 証明書による HTTPS 接続が必須です</span>
        </div>
        <p class="onboarding-callout-body">
          テスラ車載ブラウザは自己署名証明書（オレオレ証明書）を許可できません。車載から接続する際は Let's Encrypt や Cloudflare Tunnel 等の有効な公的 SSL 証明書を通した HTTPS URL をご利用ください（構築詳細は <code>docs/NETWORK.md</code> を参照）。
        </p>
      </div>

      <h3 class="onboarding-section-title">
        <span class="onboarding-icon">${ICONS.star}</span>
        <span>Tesroid でできること</span>
      </h3>
      <div class="onboarding-feature-grid">
        ${renderFeatureGrid()}
      </div>

      <h3 class="onboarding-section-title">
        <span class="onboarding-icon">${ICONS.keyboard}</span>
        <span>基本操作と文字入力（ログイン・検索）</span>
      </h3>
      <ul class="onboarding-list">
        <li><strong>タップ &amp; スワイプ</strong>: 映像画面を直接タップしてボタン操作、上下スワイプで慣性スクロールができます。</li>
        <li><strong>お気に入り &amp; URL移動</strong>: 上部 HUD のお気に入り（★）から登録サイトへすぐ移動でき、現在開いているページの追加やホームサイト変更にも対応しています。</li>
      </ul>

      <div class="onboarding-callout onboarding-callout-keyboard">
        <div class="onboarding-callout-title">
          <span class="onboarding-icon" style="color: #34c759;">${ICONS.keyboard}</span>
          <span>重要: 車載ブラウザでの文字入力方法</span>
        </div>
        <p class="onboarding-callout-body" style="margin-bottom: 6px;">
          テスラ車載ブラウザは映像キャンバスをタップしても OS キーボードが開きません。検索や Google / 動画サービスのログイン時は、上部 HUD の <strong>キーボードボタン</strong> から専用入力バーを開いてください。
        </p>
        <ul class="onboarding-list" style="margin-bottom: 0;">
          <li>展開した入力欄をタップすると車載ソフトウェアキーボードが起動します。</li>
          <li>文字を入力して <strong>「送信」</strong> または <strong>「Enter ⏎」</strong> を押すと、画面内の入力欄へ直接送信されます。</li>
          <li>パスキー設定済みアカウントでもネイティブダイアログを自動抑止するため、「パスワードを入力」からサインインできます。</li>
        </ul>
      </div>

      <h3 class="onboarding-section-title">
        <span class="onboarding-icon">${ICONS.settings}</span>
        <span>上部 HUD バーの主な操作</span>
      </h3>
      <div class="onboarding-hud-list">
        ${renderHudControlList()}
      </div>

      <div class="onboarding-callout">
        <div class="onboarding-callout-title">
          <span class="onboarding-icon">${ICONS.cinema}</span>
          <span>後席モニター同時視聴 &amp; 待ち受けモード</span>
        </div>
        <p class="onboarding-callout-body">
          前席と後席モニターの同時視聴に対応しています。後席側から先に接続して前席の配信開始を待機したい場合は、PIN 入力画面右上の設定メニューから <strong>「後席モニター待ち受けモードで接続」</strong> を利用できます。
        </p>
      </div>

      <div class="onboarding-actions">
        <button id="${options.actionButtonId}" type="button" class="btn" style="gap: 8px;">
          ${options.actionButtonHtml}
        </button>
      </div>
    </div>
  `;
}

/**
 * Renders the first-run onboarding guide focused on capabilities, touch operations, and HUD usage.
 */
export function renderOnboardingGuide(container: HTMLElement, onNext: () => void): void {
  container.innerHTML = buildOnboardingCardHtml({
    actionButtonId: 'guide-next-btn',
    actionButtonHtml: `<span>理解しました。初期設定へ進む</span>${ICONS.arrowRight}`,
  });

  document.getElementById('guide-next-btn')?.addEventListener('click', onNext);
}

/**
 * Opens the onboarding guide inside a modal overlay so it can be viewed anytime without losing screen state.
 */
export function openOnboardingGuideModal(container: HTMLElement): void {
  document.getElementById('onboarding-guide-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'onboarding-guide-modal';
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '1100';
  overlay.innerHTML = buildOnboardingCardHtml({
    actionButtonId: 'onboarding-modal-close-action-btn',
    actionButtonHtml: '<span>閉じる</span>',
    closeIconId: 'onboarding-modal-close-btn',
  });

  container.appendChild(overlay);

  const closeModal = () => {
    overlay.remove();
  };

  overlay.querySelector('#onboarding-modal-close-btn')?.addEventListener('click', closeModal);
  overlay
    .querySelector('#onboarding-modal-close-action-btn')
    ?.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  });
}
