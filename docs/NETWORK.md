# 外部公開 & ネットワーク設定詳細ガイド（高度な構成リファレンス）(docs/NETWORK.md)

本書は、Tesroid を自宅サーバー（オンプレミス）やクラウド VM（VPS）上に構築し、**テスラ車載ブラウザから安全かつ超低遅延でアクセスするためのネットワーク設計・各種リバースプロキシ構築マニュアル** です。

> [!TIP]
> **初めて導入される方へ（かんたんセットアップ）**:
> Cloudflare アカウント登録から安価なドメイン購入、Tunnel 作成、`docker-compose.prebuilt.yml` を使った起動までを一通り行う場合は、初心者向けに整理された **[かんたん導入ガイド (docs/QUICKSTART.md)](QUICKSTART.md)** をご覧ください。

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

`ghcr.io/ranasgenoa/tesroid:latest` には `cloudflared` が同梱されているため、**`TUNNEL_TOKEN` を設定するだけで単一コンテナのまま自動接続**できます。

```text
[ Tesla Browser ] ──HTTPS/WSS──> [ Cloudflare Edge ] ══暗号化トンネル══> [ Tesroid コンテナ (内蔵 cloudflared ➔ localhost:8080) ]
```

#### セットアップ手順（単一コンテナ同梱構成）

> [!TIP]
> **Cloudflare アカウント作成 〜 ドメイン購入 〜 トンネル作成 〜 Docker Compose 起動** までの初心者向けステップバイステップ手順は、**[かんたん導入ガイド (docs/QUICKSTART.md)](QUICKSTART.md)** に分かりやすくまとめています。

> [!IMPORTANT]
> **無料 DDNS（DuckDNS 等）に関する制限事項と転送先仕様**:
> - **DuckDNS（`*.duckdns.org`）などの無料 DDNS サブドメインは、ネームサーバー（NS）を Cloudflare に移譲できないため Cloudflare Tunnel では利用できません。** 独自ドメイン（Cloudflare Registrar で年 \$4〜\$5 前後から取得可能）をご利用ください。
> - **取得済みの DuckDNS をそのまま使いたい場合** は、[**パターン B（Caddy / Nginx ＋ ルーターの 80/443 開放）**](#パターン-b-自宅サーバー--リバースプロキシ-caddy--nginx) を選択してください。
> - **Public Hostname（ルート）の転送先**: 単一コンテナ構成では `cloudflared` と Tesroid 本体が同一コンテナ内で動作するため、Service Type は **`HTTP`**、URL は **`localhost:8080`**（または `http://localhost:8080`）を指定します。また Cloudflare ダッシュボードの **Network** 設定で **WebSockets** が有効（デフォルト ON）であることを確認してください。
> - ドメイン購入前にまず HTTPS 接続の動作確認だけ試したい場合は、以下の **Quick Tunnels** を利用できます。

1. Cloudflare ダッシュボードで独自ドメインを用意（購入または移譲）し、[Zero Trust ダッシュボード](https://one.dash.cloudflare.com/) の **Networks** ➔ **Tunnels** ➔ **Create a tunnel** からトンネルを作成します。
2. コネクタインストール画面に表示される **`eyJh...` で始まるトークン文字列のみ** をコピーし、`.env` の `TUNNEL_TOKEN` に設定します（秘密情報のため `.env` は `chmod 600` で保護し、リポジトリやスクリーンショットに含めないでください）。
3. トンネルの **Public Hostname（ルート）** で公開ドメイン（サブドメイン空欄ならルートドメイン）を設定し、Service に `HTTP` / `localhost:8080` を指定します。
4. `docker compose -f docker-compose.prebuilt.yml up -d` で起動すると内蔵 `cloudflared` が接続され、トンネル一覧のステータスが「非アクティブ（Inactive）」から **「正常（HEALTHY）」** に変わります。詳しくは [docs/QUICKSTART.md](QUICKSTART.md) を参照してください。

#### （補足）ドメイン購入前の動作確認：Quick Tunnels (`trycloudflare.com`)

独自ドメインを取得する前に、まずテスラ車載ブラウザからの HTTPS / WSS 接続とストリーミング動作だけを確認したい場合は、アカウント登録やドメイン不要の **Cloudflare Quick Tunnels**（`*.trycloudflare.com`）による一時検証が可能です。

`tesroid-server` コンテナが起動している状態で以下のコマンドを実行すると、コンソールに一時的な HTTPS 公開 URL（`https://xxxx-xxxx.trycloudflare.com`）が表示されます：

```bash
docker exec -it tesroid-server cloudflared tunnel --no-autoupdate --url http://localhost:8080
```

> [!NOTE]
> Quick Tunnels はコマンドを終了（`Ctrl+C`）または再起動するたびに URL が変わり、稼働保証（SLA）もないため **一時的な動作確認専用** です。日常運用には上記の `TUNNEL_TOKEN`（独自ドメイン）構成、またはパターン B を使用してください。

<details>
<summary>（参考）別コンテナで cloudflared を起動する構成（ローカルビルド版等で分離したい場合）</summary>

`cloudflared` を Tesroid コンテナと分離してサイドカー起動する場合は、`docker-compose.yml` に以下を追加します。
Public Hostname の **URL** には、同一 Docker Compose ネットワーク内の **`http://tesroid:8080` を第一推奨** として指定してください（`http://host.docker.internal:9001` を使用する場合は、Linux 環境の Docker では `cloudflared` サービス側に `extra_hosts: ["host.docker.internal:host-gateway"]` の指定が必要になる場合があります）。

```yaml
services:
  tesroid:
    # (既存の tesroid サービス定義)
    ports:
      - "127.0.0.1:9001:8080" # ローカルホストからのみアクセス許可

  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared-tunnel
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=eyJh... # Cloudflareダッシュボードで取得したトークン
    # host.docker.internal を使う場合のみ有効化:
    # extra_hosts:
    #   - "host.docker.internal:host-gateway"
```

</details>

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
