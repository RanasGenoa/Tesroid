# 外部公開 & ネットワーク設定完全ガイド (docs/NETWORK.md)

本書は、Tesroid を自宅サーバー（オンプレミス）やクラウド VM（VPS）上に構築し、**テスラ車載ブラウザから安全かつ超低遅延でアクセスするためのネットワーク設計・構築マニュアル** です。

---

## 1. テスラ車載ブラウザのネットワーク通信要件（必読）

テスラ車載ブラウザ（Chromium ベース）から Tesroid にアクセスして動画ストリーミング・タッチ操作を行うには、以下の **4つの技術要件** を満たす必要があります。

```
[ Tesla 車載ブラウザ ]
        │
        │ 🔐 HTTPS / WSS (ポート 443 / 有効な公的SSL証明書)
        ▼
[ リバースプロキシ / トンネル ]  <-- Let's Encrypt / Cloudflare Edge (SSL終端)
        │
        │ 🚀 HTTP / WS (ポート 9001 / バッファリングOFF / タイムアウト延長)
        ▼
[ Tesroid コンテナ (Port 8080) ]
```

1. **HTTPS (SSL/TLS) の完全適用 (必須)**:
   - テスラ車載ブラウザは **セキュアコンテキスト（HTTPS）でのみ WebCodecs API (`VideoDecoder`) を有効化** します。HTTP (非暗号化) ではストリーミング画面が初期化されず真っ暗になります。
2. **公的 CA による有効な SSL/TLS 証明書 (必須)**:
   - Let's Encrypt、ZeroSSL、Cloudflare Edge 等の公的機関が署名した有効な証明書が必要です。
   - **自己署名証明書（オレオレ証明書）は不可**: テスラ車載ブラウザでは警告を無視して進む操作がブロックされる、あるいは WebSocket 接続が即座に拒否されます。
3. **単一ポート / 単一ドメイン構成 (推奨)**:
   - Web 画面の読み込み（HTTPS:443）とストリーミング用 WebSocket（WSS:443）を同一ドメイン・ポート（443）で中継します。
4. **WebSocket タイムアウト防止 & バッファリング無効化 (超低遅延に必須)**:
   - リバースプロキシ側のバッファリング（`proxy_buffering`）を必ず **OFF** にします。バッファリングが有効な場合、H.264フレームがプロキシ内に滞留し、致命的な遅延やカクつきが発生します。
   - 接続タイムアウト（Read/Send Timeout）を長期間（24時間以上）に設定し、走行中の不意な切断を防止します。

---

## 2. ネットワーク構築パターン（環境別）

ご自身の環境に合わせて以下の **パターン A 〜 C** から最適な方式を選択してください。

| パターン | 対象環境 | ルーターポート開放 | 難易度 | 特徴・推奨度 |
| :--- | :--- | :---: | :---: | :--- |
| **パターン A: Cloudflare Tunnels** | 自宅サーバー / オンプレ | **不要** | ★☆☆ (容易) | **最も推奨**。IP露出なし、CGNAT/二重ルーターでも動作可能 |
| **パターン B: Caddy / Nginx (オンプレ)** | 自宅サーバー (固定IP/DDNS) | **必要 (80/443)** | ★★☆ (普通) | 独自ドメイン直接運用、高速、完全ローカルコントロール |
| **パターン C: クラウド VM / VPS** | クラウド (さくら, ConoHa, AWS等)| **不要 (クラウド側設定)**| ★★☆ (普通) | 自宅にサーバーを置けない方向け、回線が安定 |

---

### パターン A: Cloudflare Tunnels (ポート開放不要・最も推奨)

自宅の光回線（NURO光、マンション一括回線、IPv6 IPoE / MAP-E 等）では、グローバル IPv4 アドレスが割り当てられずポート開放ができない（CGNAT）場合があります。
**Cloudflare Tunnel** を利用すると、自宅ルーターのポート開放を一切行うことなく、安全に `https://tesroid.your-domain.com` を外部公開できます。

```
[ Tesla Browser ] ──HTTPS/WSS──> [ Cloudflare Edge ] ══暗号化トンネル══> [ cloudflared コンテナ ] ──HTTP/WS──> [ Tesroid ]
```

#### セットアップ手順

1. **ドメインの Cloudflare 登録**:
   お持ちの独自ドメイン（お名前.com, Cloudflare Registrar 等で取得）のネームサーバーを Cloudflare に設定します。
2. **Cloudflare Zero Trust トンネルの作成**:
   - Cloudflare Zero Trust ダッシュボード (`https://one.dash.cloudflare.com/`) にアクセス。
   - **Networks** ➔ **Tunnels** ➔ **Create a tunnel** を選択（Cloudflared を選択）。
   - トンネル名（例: `tesroid-tunnel`）を入力。
3. **トンネルトークンの取得と Docker 実行**:
   Docker Compose 内で `cloudflared` を同時に起動します。

```yaml
# docker-compose.yml への追加例
services:
  tesroid:
    # (既存の tesroid サービス定義)
    ports:
      - "127.0.0.1:9001:8080" # ローカルホストからのみアクセス許可

  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared-tunnel
    restart: unless-stopped
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=eyJh... # Cloudflareダッシュボードで取得したトークン
```

4. **Public Hostname (公開URL) のルーティング設定**:
   Cloudflare ダッシュボード上で以下のように設定します：
   - **Subdomain**: `tesroid`
   - **Domain**: `your-domain.com`
   - **Service Type**: `HTTP`
   - **URL**: `tesroid:8080` (同一Dockerネットワークの場合) または `host.docker.internal:9001`
   - **Additional application settings**:
     - **HTTP Settings**:
       - `No TLS Verify`: 有効（内部通信がHTTPのため）
     - **WebSockets**: Cloudflare Network 設定で **WebSockets を有効化** (デフォルトでON)

---

### パターン B: 自宅サーバー + リバースプロキシ (Caddy / Nginx)

自宅にグローバルIPがあり、ルーターでポート 80 / 443 のポートフォワーディングが可能な場合の構成です。

#### 1. ルーターのポート開放
- ルーターの管理画面を開き、外部ポート `80` および `443` を、Tesroid またはリバースプロキシが稼働するサーバーのローカル IP（例: `192.168.1.100`）へ転送（ポートフォワーディング）します。

#### 2. Caddy による自動 SSL 構成 (超簡単・推奨)
Caddy は Let's Encrypt / ZeroSSL の証明書取得・自動更新を完全自動化します。設定ファイルは数行で完結します。

`Caddyfile`:
```caddy
tesroid.your-domain.com {
    # 自動的にLet's EncryptでHTTPS証明書を取得・適用します
    
    reverse_proxy 127.0.0.1:9001 {
        # WebSocket UpgradeはCaddyが自動的にハンドリングします
        flush_interval -1
    }
}
```

#### 3. Nginx による構成
既存の Nginx サーバーがある場合は、以下の設定スニペットを `/etc/nginx/conf.d/tesroid.conf` に追加します。

```nginx
# WebSocket コネクション用のマッピング
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name tesroid.your-domain.com;
    # HTTP から HTTPS への自動リダイレクト
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tesroid.your-domain.com;

    # SSL 証明書パス (certbot / Let's Encrypt 等)
    ssl_certificate     /etc/letsencrypt/live/tesroid.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tesroid.your-domain.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:9001;
        proxy_http_version 1.1;

        # WebSocket 接続の必須設定
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;

        # クライアント実IPの透過
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # =========================================================
        # ⚠️ 超低遅延ストリーミングのための必須設定 (極めて重要)
        # =========================================================
        proxy_buffering off;             # プロキシ側のバッファリングを完全停止
        proxy_request_buffering off;
        proxy_read_timeout 86400s;       # 24時間切断防止
        proxy_send_timeout 86400s;
    }
}
```

---

### パターン C: クラウド VM / VPS (ConoHa, さくらのVPS, AWS, Linode等)

クラウド上の Linux インスタンス（VPS）上で動作させる場合です。

#### 1. クラウド側のファイアウォール設定 (セキュリティグループ / UFW)
Tesroid コンテナのポート（`9001`）を直接インターネットに晒さず、**ポート `80` と `443` のみを外部公開** します。

```bash
# Ubuntu UFW の場合
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (Let's Encrypt認証用)
sudo ufw allow 443/tcp   # HTTPS (Tesroid WebUI / WSS)
sudo ufw enable
```

#### 2. ドメインの A レコード設定
お名前.com や Cloudflare で、ドメインの A レコードに VPS のグローバル IP アドレスを登録します。
```
tesroid.your-domain.com.  IN  A  <VPS_GLOBAL_IP>
```

#### 3. Caddy または Nginx の起動
パターン B と同様に Caddy または Nginx を起動すれば、即座に HTTPS 化された環境が完成します。

---

## 3. VPN (Tailscale 等) についての補足ナレッジ

「Tailscale や WireGuard で完全閉域網にしたい」というご要望をいただくことがありますが、**テスラ車載ブラウザ単体では VPN に接続できません**（テスラ OS 上にアプリをインストールできないため）。

どうしてもプライベート VPN 経由で通信したい場合は、以下の車内ルーター構成をとる必要があります：
```
[ Tesla 車載モニター ] 
        │ (Wi-Fi 接続)
        ▼
[ 車内ポータブルルーター (GL.iNet等) ] <-- ルーター内で Tailscale / WireGuard クライアントを常時稼働
        │ (セルラー回線 / スマホテザリング)
        ▼
[ 自宅 / クラウドサーバー (Tailscale サブネットルーター) ]
        ▼
[ Tesroid コンテナ ]
```
この構成をとる場合でも、テスラ車載ブラウザがセキュアコンテキストを要求するため、ローカル IP（`http://192.168.x.x`）直接アクセスでは WebCodecs が動作しません。
Tailscale の **MagicDNS + HTTPS 機能（`*.ts.net`）** を利用して有効な SSL 証明書付きドメインを割り当てる必要があります。

---

## 4. 疎通・動作確認チェックリスト

設定が完了したら、テスラ車からアクセスする前に PC / スマートフォンから以下の順に動作確認を行ってください。

- [ ] **1. HTTPS アクセス**:
  ブラウザで `https://tesroid.your-domain.com/` を開いた際、アドレスバーに鍵マーク（SSL証明書が有効）が表示されるか。
- [ ] **2. 初期セットアップウィザード (PIN 設定)**:
  初回アクセス時に PIN コード（数字4〜8桁）の設定画面が表示され、正常に登録完了できるか。
- [ ] **3. WebSocket (WSS) 接続**:
  ブラウザの DevTools（F12）➔「Network」タブ ➔「WS」フィルタで、WebSocket コネクションが `101 Switching Protocols` で接続継続されているか。
- [ ] **4. 映像・音声ストリーミング**:
  PIN 入力後、X11 仮想画面（Google Chrome）が `<canvas>` 上にスムーズに表示され、YouTube 等の音声が再生されるか。
- [ ] **5. テスラ車載ブラウザでのテスト**:
  テスラ車内のブラウザで URL を開き、動画が再生されること、Dレンジ（ギア投入）で走行しても動画が停止しないことを確認。
