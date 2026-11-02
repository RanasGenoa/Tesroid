import { ICONS } from './icons.js';

export function renderLockoutView(container: HTMLElement): void {
  container.innerHTML = `
    <div class="card" style="border-color: var(--danger-color); text-align: center; max-width: 500px;">
      <div style="margin-bottom: 12px; display: flex; justify-content: center;">${ICONS.alert}</div>
      <h2 style="color: var(--danger-color); margin-bottom: 8px;">セキュリティロックアウト</h2>
      <p style="color: #fff; font-weight: bold; margin-bottom: 16px;">
        PINコードが10回連続で間違えられたため、外部攻撃（総当たり攻撃）防御機能によりサービスを強制終了しました。
      </p>
      <div style="background-color: #1a1a1a; padding: 16px; border-radius: 8px; text-align: left; font-size: 13px; color: #ccc; margin-bottom: 20px;">
        <p style="margin-bottom: 8px; color: #fff;"><strong>解除手順（サーバー管理者向け）:</strong></p>
        <ol style="padding-left: 20px; line-height: 1.6;">
          <li>Docker ホストサーバー（Linux / NAS / VPS 等）にアクセスします。</li>
          <li><code>docker compose restart tesroid</code>（またはコンテナ管理画面から再起動）を実行します。</li>
          <li>※ 恒久ロックファイルが残っている場合は永続ボリューム内の <code>lockout.json</code> を削除してから再起動してください。</li>
        </ol>
      </div>
      <p style="font-size: 12px; color: var(--text-muted); margin: 0;">
        ※ ブラウザのリロードを行っても、コンテナが手動再起動されるまで接続は復旧しません。
      </p>
    </div>
  `;
}
