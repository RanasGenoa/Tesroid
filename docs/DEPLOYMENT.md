# Tesroid デプロイメント & 運用ガイド (docs/DEPLOYMENT.md)

本書は、Tesroid システムを一般的な **Docker / Docker Compose 環境（オンプレミス Linux、クラウド VM / VPS）** および **NAS 環境（TrueNAS SCALE 等）** 上でデプロイ・運用するための総合ガイドです。

> [!NOTE]
> 外部公開およびテスラ車載ブラウザからアクセスするためのリバースプロキシ（HTTPS/SSL、Cloudflare Tunnel、Nginx、Caddy等）の設定手順は、[docs/NETWORK.md](NETWORK.md) をご参照ください。

---

## 1. 動作要件 (System Requirements)

Tesroid は、仮想 X11 画面キャプチャとハードウェア支援エンコード（VAAPI）により、極めて低負荷・低遅延なストリーミングを実現します。

### ハードウェア要件
- **CPU / GPU**:
  - **Intel Quick Sync Video (VAAPI)**: Intel 第6世代 Core (Skylake) 以降の統合 GPU 推奨。ドライバ `iHD` (`intel-media-va-driver-non-free`) に対応。
  - **AMD GPU (VAAPI)**: Radeon シリーズ等の VAAPI (`radeonsi`) 対応 GPU（`.env` で `LIBVA_DRIVER_NAME=radeonsi` を指定）。
- **メモリ**: 2GB 以上推奨（コンテナ内 Google Chrome + FFmpeg + PulseAudio + Node.js が稼働）
- **ストレージ**: コンテナイメージ用（約 2GB）+ ブラウザプロファイル・設定永続化用（1GB〜）

### サポート OS
- **一般的な Linux ディストリビューション**: Ubuntu 20.04 / 22.04 / 24.04 LTS, Debian 11 / 12, Arch Linux 等
- **NAS OS**: TrueNAS SCALE (Docker / Custom App), Unraid 等
- **クラウド VM**: AWS EC2, さくらのVPS, ConoHa, Linode, Hetzner 等の Linux インスタンス

### 必要なソフトウェア
- Docker Engine 24.0 以上
- Docker Compose v2.0 以上

---

## 2. 一般的な Docker / Docker Compose 環境でのデプロイ

Ubuntu、Debian、またはクラウド VM 上の標準的な Docker 環境での導入手順です。

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
