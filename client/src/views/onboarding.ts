export function renderOnboardingGuide(container: HTMLElement, onNext: () => void): void {
  container.innerHTML = `
    <div class="card" style="max-width: 800px; max-height: 90vh; overflow-y: auto;">
      <h2>Tesroid オンボーディングガイド</h2>
      <p>テスラ車載ブラウザから接続するためのリバースプロキシ設定・ネットワーク要件の確認です。</p>

      <div style="background-color: #222; border-left: 4px solid var(--primary-color); padding: 12px; margin-bottom: 16px; border-radius: 4px;">
        <h3 style="font-size: 15px; margin-bottom: 6px; color: #fff;">必須要件: 公的SSL証明書 (Let's Encrypt等)</h3>
        <p style="font-size: 13px; margin: 0; color: #bbb;">
          テスラ車載ブラウザはセキュリティが極めて厳格であり、自己署名証明書（オレオレ証明書）の警告をバイパスすることが実質不可能です。
          必ず独自ドメインに Let's Encrypt / Cloudflare 等の有効なSSL証明書を設定してください。
        </p>
      </div>

      <h3 style="font-size: 16px;">1. ネットワーク転送構成</h3>
      <p style="font-size: 13px;">
        外部アクセス <code>https://&lt;独自ドメイン&gt;:443</code> ➔ リバースプロキシ ➔ <code>http://&lt;SERVER_IP&gt;:9001</code> (HTTP & WSS)
      </p>
      <p style="font-size: 12px; color: #888;">
        ※ ポート開放が困難な回線（CGNAT等）では <strong>Cloudflare Tunnels</strong> の利用を推奨します（詳細は <code>docs/NETWORK.md</code> を参照）。
      </p>

      <h3 style="font-size: 16px;">2. Nginx 設定スニペット</h3>
      <pre id="nginx-snippet">server {
    listen 443 ssl http2;
    server_name tesroid.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/tesroid.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tesroid.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9001; # またはサーバーIP (例: http://192.168.1.100:9001)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 低遅延ストリーミングのための必須設定
        proxy_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
} </pre>

      <h3 style="font-size: 16px;">3. Caddy 設定スニペット</h3>
      <pre id="caddy-snippet">tesroid.your-domain.com {
    reverse_proxy 127.0.0.1:9001 # またはサーバーIP (例: 192.168.1.100:9001)
}</pre>

      <div style="background-color: #222; border-left: 4px solid #34c759; padding: 12px; margin-top: 16px; margin-bottom: 16px; border-radius: 4px;">
        <h3 style="font-size: 15px; margin-bottom: 6px; color: #fff;">💡 重要: 車載ブラウザでの文字入力方法（Google / YouTube ログイン等）</h3>
        <p style="font-size: 13px; margin: 0 0 8px 0; color: #bbb;">
          テスラ車載ブラウザは、映像描画キャンバス（<code>&lt;canvas&gt;</code>）をタップしても OS のソフトウェアキーボードが表示されません。
        </p>
        <p style="font-size: 13px; margin: 0 0 8px 0; color: #bbb;">
          検索や Google アカウントへのサインイン（メールアドレス・パスワード入力）を行う際は、<strong>上部 HUD の ⌨️（キーボード）ボタン</strong> をタップしてください。
        </p>
        <ul style="font-size: 13px; color: #bbb; padding-left: 20px; margin: 0;">
          <li>展開された入力バーをタップするとテスラ車載キーボードが起動します。</li>
          <li>文字を入力して <strong>「送信」</strong> または <strong>「Enter ⏎」</strong> を押すと、画面内の入力欄へ直接注入されます。</li>
          <li>パスキー設定済みアカウントでも、Tesroid が自動でダイアログを抑止するため「パスワードを入力」から安全にログイン可能です。</li>
        </ul>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px;">
        <button id="guide-next-btn" class="btn">理解しました。初期設定へ進む ➔</button>
      </div>
    </div>
  `;

  document.getElementById('guide-next-btn')?.addEventListener('click', onNext);
}
