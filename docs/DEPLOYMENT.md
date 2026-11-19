# Tesroid デプロイメント & 運用ガイド (docs/DEPLOYMENT.md)

本書は、Tesroid システムを一般的な **Docker / Docker Compose 環境（オンプレミス Linux、クラウド VM / VPS）** および **NAS 環境（TrueNAS SCALE 等）** 上でデプロイ・運用するための総合ガイドです。

> [!NOTE]
> 外部公開およびテスラ車載ブラウザからアクセスするためのリバースプロキシ（HTTPS/SSL、Cloudflare Tunnel、Nginx、Caddy等）の設定手順は、[docs/NETWORK.md](NETWORK.md) をご参照ください。

---

## 1. 動作要件 (System Requirements)

Tesroid は、仮想 X11 画面キャプチャとハードウェア支援エンコード（VAAPI）により、極めて低負荷・低遅延なストリーミングを実現します。

### ハードウェア要件
- **CPU アーキテクチャ**: `x86_64` (`amd64`) 専用
- **GPU (VAAPI 必須)**:
  - **Intel Quick Sync Video (VAAPI)**: Intel 第6世代 Core (Skylake) 以降の統合 GPU 推奨。ドライバ `iHD` (`intel-media-va-driver-non-free`) に対応。
  - **AMD GPU (VAAPI)**: Radeon シリーズ等の VAAPI (`radeonsi`) 対応 GPU（`.env` で `LIBVA_DRIVER_NAME=radeonsi` を指定）。
- **動作確認済み iGPU リスト**:
  | GPU / iGPU | アーキテクチャ (世代) | VAAPI ドライバ | ステータス | 備考 |
  | :--- | :--- | :--- | :--- | :--- |
  | **Intel UHD Graphics 630** | Coffee Lake (第8/9世代 Core) | `iHD` | ✅ 動作確認済み | 開発基準環境（1280x720@30/60fps 安定動作） |
  | **Intel UHD Graphics 600** | Gemini Lake (Celeron 等) | `iHD` | ✅ 動作確認済み | 省電力 iGPU 環境（[#46](https://github.com/RanasGenoa/Tesroid/issues/46) のパフォーマンス調整・軽量プリセット等により安定動作） |
- **メモリ**: 2GB 以上推奨（コンテナ内 Google Chrome + FFmpeg + PulseAudio + Node.js が稼働）
- **ストレージ**: コンテナイメージ用（約 2GB）+ ブラウザプロファイル・設定永続化用（1GB〜）

### サポート OS
- **一般的な Linux ディストリビューション**: Ubuntu 20.04 / 22.04 / 24.04 LTS, Debian 11 / 12, Arch Linux 等（`x86_64`）
- **NAS OS**: TrueNAS SCALE (Docker / Custom App), Unraid, CasaOS 等（Intel/AMD `x86_64` CPU 搭載機）

### 必要なソフトウェア
- Docker Engine 24.0 以上
- Docker Compose v2.0 以上

### 対応が難しい・非推奨の環境

Tesroid は低遅延・省CPU負荷を実現するため、VAAPI ハードウェアエンコードと `x86_64` 環境を前提に設計されています。以下の環境は技術的な理由により非対応または非推奨です：

1. **格安 VPS / GPU なしクラウド VM**:
   - 映像エンコードに `h264_vaapi`（ホストの `/dev/dri/renderD128`）を必須としており、`libx264` 等による CPU ソフトウェアエンコードへのフォールバックを持ちません。そのため GPU なしの一般的な VPS では起動・配信できません。
   - 仮に CPU エンコードを行う構成にした場合でも、安定動作には 2〜4 vCPU / 4GB RAM 以上（月額 1,500〜3,500 円程度）のスペックと動画ストリーミングに伴うネットワーク帯域がかかります。GPU パススルー付きクラウド VM はコストが高額になるため非推奨です。
2. **Windows PC (Docker Desktop / WSL2)**:
   - WSL2 上の Docker 環境には Linux の `/dev/dri`（VAAPI レンダーノード）を直接パススルーできないため、現行構成では動作しません。
   - また、PC のスリープ移行や Windows Update による自動再起動で車載からの接続が途切れやすく、常時稼働サーバー用途には不向きです。
3. **ARM CPU 搭載 NAS 等（Raspberry Pi / ARM64 NAS）**:
   - コンテナイメージ・FFmpeg `h264_vaapi`・Google Chrome Stable（`amd64` 版）がすべて `x86_64` (`amd64`) 専用で構築されているため、ARM アーキテクチャでは動作しません。

---

## 2. 一般的な Docker / Docker Compose 環境でのデプロイ

Ubuntu、Debian、ミニ PC、または x86_64 NAS の Docker 環境での導入手順です。通常はビルド不要の **2-A** または **2-B** をおすすめします。

### 2-A. ビルド不要の Docker Compose コピペ導入（推奨）

公開されているビルド済みベースイメージ（`ghcr.io/ranasgenoa/tesroid:latest`）と [`docker-compose.prebuilt.yml`](../docker-compose.prebuilt.yml) を使用することで、`git clone` やローカルでの `docker build` を行わずに起動できます。

テスラ車載ブラウザは **有効な公的 SSL 証明書による HTTPS/WSS 接続** が必須であるため、このセットアップでは **Cloudflare Tunnel** を利用して自宅サーバー等をポート開放なしで安全に HTTPS 公開する構成を前提としています（Caddy / Nginx 等の自前リバースプロキシを使う場合は `TUNNEL_TOKEN` を空欄にして別途設定してください）。

> [!NOTE]
> **Google Chrome の自動取得について**:
> `ghcr.io/ranasgenoa/tesroid:latest` には Google Chrome 本体は同梱されていません（Google Chrome の再配布規約に配慮した構成です）。**初回コンテナ起動時にコンテナ自身が Google Chrome 公式パッケージを自動ダウンロード・導入**するため、初回のみ起動に数十秒ほど時間がかかります。
>
> **Cloudflare Tunnel と `TUNNEL_TOKEN` について**:
> 環境変数 `TUNNEL_TOKEN` を設定して起動すると、コンテナに同梱された `cloudflared` が自動的にバックグラウンドで起動し、ポート開放なしで HTTPS 公開できます。
> - **必要なトークン (`TUNNEL_TOKEN`)**: Cloudflare の一般的な API トークンではなく、**Cloudflare Zero Trust のトンネル作成画面で発行される `cloudflared` コネクタ用トークン**（インストールコマンドの `--token` に続く `eyJh...` で始まる長い文字列）です。
> - **Cloudflare Tunnel 側で必要な設定**:
>   1. **ドメインの登録**: お持ちの独自ドメインを Cloudflare に登録し、ネームサーバーを Cloudflare に切り替えておきます。
>      - ※ **DuckDNS（`*.duckdns.org`）などの無料 DDNS サブドメインは、ネームサーバー（NS）を Cloudflare に移譲できないため Cloudflare Tunnel では利用不可** です。独自ドメインを取得するか（Cloudflare Registrar なら年 \$4〜\$5 程度の最安 TLD もあり、DNS 設定が自動連携されます）、取得済みの DuckDNS をそのまま使いたい場合は `TUNNEL_TOKEN` を空欄にして [docs/NETWORK.md のパターン B（Caddy / Nginx ＋ ルーターの 80/443 開放）](NETWORK.md#パターン-b-自宅サーバー--リバースプロキシ-caddy--nginx) を選択してください。
>      - ※ ドメイン購入前にまず HTTPS 接続の動作確認だけ試したい場合は、[Quick Tunnels（`trycloudflare.com`）](NETWORK.md#補足ドメイン購入前の動作確認quick-tunnels-trycloudflarecom) による一時検証も利用できます。
>   2. **トンネル作成とトークン取得**: [Cloudflare Zero Trust ダッシュボード](https://one.dash.cloudflare.com/) の **Networks** ➔ **Tunnels** ➔ **Create a tunnel** でコネクタに **Cloudflared** を選択してトンネルを作成し、表示される `--token` 以降の文字列（`eyJh...`）をコピーします。
>   3. **Public Hostname（公開 URL）の転送先設定**: 同トンネルの **Public Hostname**（または **Published application routes**）で公開したいサブドメイン・ドメインを設定し、Service には **Type: `HTTP`** / **URL: `http://localhost:8080`** を指定します（`cloudflared` と Tesroid 本体が同一コンテナ内で稼働するため `localhost:8080` を指定します）。あわせて **Additional application settings** ➔ **HTTP Settings** で `No TLS Verify` を有効化し、Cloudflare ダッシュボード側の **Network** 設定で **WebSockets** が有効（デフォルト ON）であることを確認してください。
>
> 詳細手順や別構成（Caddy / Nginx / VPS）は [docs/NETWORK.md](NETWORK.md#パターン-a-cloudflare-tunnels-ポート開放不要最も推奨) を参照してください。

#### 手順
1. 任意の作業ディレクトリを作成し、`docker-compose.prebuilt.yml` を取得（または内容を `docker-compose.yml` として保存）します：
   ```bash
   mkdir -p ~/tesroid && cd ~/tesroid
   curl -fsSL https://raw.githubusercontent.com/RanasGenoa/Tesroid/main/docker-compose.prebuilt.yml -o docker-compose.prebuilt.yml
   ```
2. `.env` ファイルを作成し、Cloudflare Zero Trust で取得した **Cloudflare Tunnel トークン（`TUNNEL_TOKEN`）** と公開ポート番号を設定します（Cloudflare Tunnel を使用しない場合は `TUNNEL_TOKEN` を空欄または省略してください）：
   ```bash
   cat <<'EOF' > .env
   TESROID_PORT=9001
   TUNNEL_TOKEN=eyJh...ここにCloudflare Zero Trustで取得したトンネルトークンを貼り付け
   EOF
   ```
3. コンテナを起動します：
   ```bash
   docker compose -f docker-compose.prebuilt.yml up -d
   ```
4. 起動ログおよびヘルスチェックを確認します（初回は Chrome の取得ログが流れます）：
   ```bash
   docker compose -f docker-compose.prebuilt.yml logs -f
   curl -s http://127.0.0.1:9001/api/health
   ```

### 2-B. ワンショット導入スクリプト（Intel x86_64 Linux 向け）

Ubuntu / Debian 等の Intel x86_64 Linux 環境（ミニ PC・自宅サーバー等）では、[`scripts/install.sh`](../scripts/install.sh) を使うことで環境チェックから起動までを対話式で一括実行できます。

**スクリプトが自動で行う処理**:
- OS・CPU アーキテクチャ（`x86_64`）および `/dev/dri` デバイスの確認
- Docker Engine / Docker Compose の確認・未導入時のインストール（Ubuntu / Debian 等）
- 実行ユーザーの `render` / `video` グループへの追加（GPU アクセス権限付与）
- 対話プロンプトでの設定入力（インストール先ディレクトリ、公開ポート既定 `9001`、任意の `TUNNEL_TOKEN`）
- `ghcr.io/ranasgenoa/tesroid:latest` を使った `docker-compose.yml` と `.env` の生成・コンテナ起動

```bash
curl -fsSL https://raw.githubusercontent.com/RanasGenoa/Tesroid/main/scripts/install.sh -o install.sh
bash install.sh
```
（リポジトリを既にクローンしている場合は `bash scripts/install.sh` を実行してください）

### 2-C. ソースコードからローカルビルドする場合（開発者・カスタム向け）

### ステップ 1: リポジトリのクローン
```bash
git clone https://github.com/<YOUR_ORG_OR_USER>/Tesroid.git
cd Tesroid
```

### ステップ 2: ホスト側の GPU 権限の確認 (Intel / AMD)
ホストの Linux で GPU デバイス `/dev/dri` が利用可能であることを確認します：
```bash
# デバイスの存在確認
ls -la /dev/dri
# 出力例: card0, renderD128 が表示されれば OK

# 必要に応じて実行ユーザーを render / video グループに追加
sudo usermod -aG render,video $USER
```

### ステップ 3: 環境変数の準備 (`.env`)
テンプレートから設定ファイルをコピーし、必要に応じてポート番号や初期 URL を変更します：
```bash
cp .env.example .env
```

主要な環境変数：
- `TESROID_PORT`: ホスト上で公開するポート番号（デフォルト: `9001`）
- `BROWSER_URL`: コンテナ起動時に開く初期 URL（デフォルト: `https://www.youtube.com`）
- `DISPLAY_WIDTH` / `DISPLAY_HEIGHT`: 仮想ディスプレイ解像度（デフォルト: `1280` / `720`）
- `FPS`: フレームレート（デフォルト: `30`）
- `VIDEO_BITRATE`: ビデオビットレート（デフォルト: `1000k`）
- `LIBVA_DRIVER_NAME`: VAAPI ドライバ（Intel: `iHD`, AMD: `radeonsi`）
- `TUNNEL_TOKEN`: Cloudflare Tunnel コネクタ用トークン（設定時は内蔵 `cloudflared` を自動起動、未設定時は無効）

### ステップ 4: Docker Compose でコンテナ起動
```bash
# イメージのローカルビルドとバックグラウンド起動
docker compose up -d --build
```

### ステップ 5: 動作確認
コンテナが正常に起動し、ヘルスチェックに応答するか確認します：
```bash
# ヘルスチェック
curl -s http://127.0.0.1:9001/api/health
# 応答例: {"status":"ok", ...}

# 起動ログの確認
docker compose logs -f
```

起動後、リバースプロキシ経由（またはローカル検証プロキシ `npm run proxy`）でブラウザからアクセスし、初期 PIN コードを登録してください。

---

## 3. NAS 環境 (TrueNAS SCALE Custom App 等) でのデプロイ

TrueNAS SCALE などの GUI コンテナ管理環境でカスタムアプリとして運用する場合の手順です。

### 1. イメージのローカルビルド
SSH 等で NAS ホスト上でイメージをビルドします（Google Chrome の再配布規約により、ホスト上で直接ビルドします）：
```bash
git clone https://github.com/<YOUR_ORG_OR_USER>/Tesroid.git /opt/tesroid
cd /opt/tesroid
docker build -t tesroid-tesroid:latest .
```

### 2. TrueNAS SCALE WebUI での Custom App 登録例
1. TrueNAS WebUI ➔ **Apps** ➔ **Discover Apps** ➔ **Custom App** を選択。
2. **Application Name**: `tesroid`
3. **Image Repository**: `tesroid-tesroid` / **Tag**: `latest`
4. **Port Forwarding**: Host Port `9001` ➔ Container Port `8080` (TCP)
5. **Storage (Host Path Volume)**: ホスト上の任意のデータセットパス（例: `/mnt/<POOL>/tesroid-data`）➔ Container Path `/data`
6. **GPU Passthrough**: `/dev/dri` デバイスパススルーを有効化。

---

## 4. リモートホスト・NAS 上での更新 & 再デプロイ手順

コードの更新や機能拡張を本番環境へ反映させる手順です。

### 標準 Docker Compose 環境の更新
```bash
# 1. リモートホスト上のソースコードを最新化
cd /opt/tesroid
git pull origin main

# 2. コンテナイメージの再ビルド & バックグラウンド再起動
docker compose up -d --build

# 3. 動作ログの確認
docker compose logs -f --tail 30
```

### TrueNAS SCALE (Custom App) 環境の更新
```bash
# 1. NAS 上の作業ディレクトリで最新ソースを取得
cd /opt/tesroid
git pull origin main

# 2. ローカルイメージを再ビルド
docker build -t tesroid-tesroid:latest .

# 3. TrueNAS CLI / WebUI で App を再起動
midclt call app.stop 'tesroid'
midclt call app.start 'tesroid'

# 4. ヘルスチェック確認
curl -s http://127.0.0.1:9001/api/health
```

### 初期セットアップの再検証（永続化データの初期化）
未設定状態からの初期 PIN 設定やオンボーディングウィザードを再検証したい場合は、コンテナ停止中に永続データディレクトリ（ホストパス `/mnt/<POOL>/tesroid-data` 等）内の設定ファイル・プロファイルを退避または消去してください：

```bash
# コンテナまたは App を停止した状態で実行
# （マウントポイントを維持するため内部のファイルのみ削除）
find /mnt/<POOL>/tesroid-data -mindepth 1 -maxdepth 1 -exec rm -rf {} +

# 再起動後、/api/status で isSetupCompleted: false になっていることを確認
```

---

## 5. ネットワーク公開 & テスラ車載ブラウザ連携

テスラ車載ブラウザは **公的 CA による有効な HTTPS (SSL/TLS)** が必須要件です。HTTP や自己署名証明書では動作しません。

ネットワーク構成パターン別の詳細設定手順については、**[docs/NETWORK.md](NETWORK.md)** をご確認ください：
- **パターン A (推奨)**: [Cloudflare Tunnels によるポート開放不要の安全な公開](NETWORK.md#パターン-a-cloudflare-tunnels-ポート開放不要最も推奨)
- **パターン B**: [Caddy / Nginx による独自ドメイン + Let's Encrypt 自動SSL](NETWORK.md#パターン-b-自宅サーバー--リバースプロキシ-caddy--nginx)
- **パターン C**: [クラウド VM / VPS での構成とファイアウォール設定](NETWORK.md#パターン-c-クラウド-vm--vps-conoha-さくらのvps-aws-linode等)

---

## 6. 日常運用・保守・トラブルシューティング

### 1. セキュリティロックアウトの解除 (10回連続PIN失敗時)
ブルートフォース攻撃から保護するため、PIN を連続 10 回誤入力するとサーバープロセスが緊急停止（`exit 1`）し、永続ボリューム内に `lockout.json` が作成されます。
解除するには `lockout.json` を削除してコンテナを再起動してください：

```bash
# Docker Compose でホストパス (./data:/data) をマウントしている場合
docker compose stop
rm -f ./data/lockout.json
docker compose start

# 名前付き Docker Volume (tesroid-data) を使用している場合
docker run --rm -v tesroid_tesroid-data:/data alpine rm -f /data/lockout.json
docker compose restart
```

### 2. ブラウザプロファイルの永続化と初期化
コンテナ内の `/data/browser-profile` が永続化されているため、ログイン状態や Cookie は再起動後も保持されます。ブラウザ状態を完全に初期化したい場合は、コンテナ停止中にプロファイルディレクトリを削除してください。

### 3. VAAPI ハードウェアアクセラレーションの動作診断
コンテナ内部で GPU が正しく認識されているか確認するコマンド：
```bash
docker exec -it tesroid-server vainfo
# 出力に VAProfileH264Main / VAEntrypointEncSlice 等が表示されていれば正常動作
```

### 4. コンテナログのリアルタイム確認
```bash
docker compose logs -f --tail 50
# または
docker logs -f --tail 50 tesroid-server
```
