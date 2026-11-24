# Tesroid デプロイメント & 運用ガイド（高度な設定・保守）(docs/DEPLOYMENT.md)

本書は、Tesroid システムを **ローカルビルド構成・NAS 環境（TrueNAS SCALE 等）・日常運用／保守** でデプロイ・管理するための詳細ガイドです。

> [!TIP]
> **初めて導入される方へ（かんたんセットアップ）**:
> 公開済みイメージ（`docker-compose.prebuilt.yml`）と **Cloudflare Tunnel (`TUNNEL_TOKEN`)** を使って、ビルド不要・ポート開放なしで最短構築する手順は **[かんたん導入ガイド (docs/QUICKSTART.md)](QUICKSTART.md)** をご覧ください。

> [!NOTE]
> リバースプロキシ（Caddy / Nginx / VPS）等のネットワーク公開手順は [docs/NETWORK.md](NETWORK.md) をご参照ください。

---

## 1. 動作要件 (System Requirements)

Tesroid は、仮想 X11 画面キャプチャとハードウェア支援エンコード（VAAPI）により、極めて低負荷・低遅延なストリーミングを実現します。

### ハードウェア要件
- **CPU アーキテクチャ**: `x86_64` (`amd64`) 専用
- **GPU / エンコーダ (VAAPI ハードウェア優先・`libx264` 自動フォールバック対応)**:
  - **Intel Quick Sync Video (VAAPI)**: 第5世代 Core (Broadwell) 以降は `iHD` (`intel-media-va-driver-non-free`)、それ以前の旧世代（Haswell 等）は `i965` (`i965-va-driver-shaders`) に対応。起動時に `vainfo` プローブで自動判定します。
  - **AMD Radeon GPU (VAAPI)**: `radeonsi` に対応（コンテナベースを Ubuntu 24.04 / Mesa `25.2.x` へ刷新し、RDNA 4 を含む Radeon 系列の VAAPI に対応。起動時にベンダー ID `0x1002` を自動判定、または `.env` で `LIBVA_DRIVER_NAME=radeonsi` を指定）。
  - **Windows (Docker Desktop / WSL2 D3D12)**: [`docker-compose.windows.yml`](../docker-compose.windows.yml) により `/dev/dxg` + `/usr/lib/wsl` を用いた D3D12 ブリッジ構成に対応。ただし Docker Desktop 既定の VM で `vgem`（`/dev/dri/renderD*`）が露出されない環境や、AMD RX 9070 XT の WSL D3D12 UMD のように `VideoProc` のみで H.264 VAAPI エンコード非対応の環境では、`ENCODER_MODE=auto`（既定値）により自動的に **`libx264` ソフトウェアエンコード** へフォールバックします。
  - **マルチ GPU 環境**: Linux ホストで複数 GPU が存在する場合、`/dev/dri/renderD*` を自動走査し、NVIDIA (`0x10de`) より Intel (`0x8086`) / AMD (`0x1002`) のレンダーノードを優先選択します。
  - **NVIDIA GPU (NVENC)**: NVIDIA Container Toolkit（Linux）または Docker Desktop の GPU サポート（Windows WSL2）で GPU を露出する構成に対応。[`docker-compose.nvidia.yml`](../docker-compose.nvidia.yml)（`deploy.resources.reservations.devices` driver: nvidia、`/dev/dri` 非マウント）を使用します。NVIDIA のみの環境では VAAPI プローブ失敗後、FFmpeg `h264_nvenc` の 1 フレーム実エンコードプローブに成功した場合のみ NVENC（`-preset p1 -tune ll -zerolatency`）を選択し、失敗時は `libx264` へ自動降格します。`.env` で `ENCODER_MODE=nvenc` の明示固定も可能です（Issue #36 Phase 3、実機検証は未了）。
  - **エンコーダ フォールバック連鎖**: 起動時に `vainfo` で `VAProfileH264 + VAEntrypointEncSlice` を厳密検証し、対応ドライバが無い場合は NVIDIA デバイス露出時の `h264_nvenc` 実エンコードプローブを経て、CPU (`libx264`) で起動します。稼働中に FFmpeg が即死した場合のみ `-low_power` 解除 → GPU CSC (`scale_vaapi`) 解除（HW エンコードは維持）→ `libx264` ソフトウェアエンコードの順に段階降格し、発生した降格は `/api/health` の `lastFallback` に記録されます。安定重視で CPU 固定を望む環境では `.env` で `ENCODER_MODE=software` を指定できます。
- **動作確認済み GPU / 環境リスト**:
  | GPU / 環境 | アーキテクチャ / 方式 | ドライバ / バックエンド | ステータス | 備考 |
  | :--- | :--- | :--- | :--- | :--- |
  | **Intel UHD Graphics 630** | Coffee Lake (第8/9世代 Core) | `iHD` (VAAPI) | ✅ 動作確認済み | 開発基準環境（1280x720@30/60fps 安定動作） |
  | **Intel UHD Graphics 600** | Gemini Lake (Celeron 等) | `iHD` (VAAPI) | ✅ 動作確認済み | 省電力 iGPU 環境（[#46](https://github.com/RanasGenoa/Tesroid/issues/46) のパフォーマンス調整・軽量プリセット等により安定動作） |
  | **旧世代 Intel iGPU** | Haswell 以前 (Core i5-4590 / Intel HD Graphics 4600 等) | `i965` (`i965-va-driver-shaders`) | ✅ 動作確認済み | HD Graphics 4600 実機で H.264 ハードウェアエンコード動作確認。起動時に `vainfo` プローブで `iHD` 非対応時に自動選択（`.env` で `LIBVA_DRIVER_NAME=i965` の明示指定も可） |
  | **Windows 10/11 + Docker Desktop** (AMD Radeon RX 9070 XT) | D3D12 ブリッジ + 自動フォールバック | `libx264` (Software) | ✅ 動作確認済み | `vgem` 不在および RX 9070 XT WSL UMD 制限のため `ENCODER_MODE=auto` により `libx264` で 1280x720@30fps リアルタイム動作を確認 |
  | **AMD Radeon (Linux)** | RDNA 3/4 系等 (Ubuntu 24.04 Mesa 25.2.x) | `radeonsi` (VAAPI) | ✅ 動作確認済み | RX 9070 XT (Navi 48) + Linux amdgpu (VCN v5) 実機で検証済: `radeonsi` / `renderD128` 自動判定、H.264 `EncSlice` プロファイル検出、`scale_vaapi` GPU CSC で VCN エンコード 20 倍超速度、Chrome ハードウェア動画デコード確認（XR 環境では Xvfb 安定性のため 2D ラスタは CPU 維持のまま動画のみ HW） |
  | **NVIDIA GPU (GeForce RTX 等)** | Linux + NVIDIA Container Toolkit / Windows Docker Desktop (WSL2) | `h264_nvenc` (NVENC) | 🧪 実装済み（実機検証未了） | `docker-compose.nvidia.yml` で NVENC パイプライン対応（Issue #36 Phase 3）。コミュニティから RTX 4060 Laptop + WSL2 環境での動作報告あり（未検証・参考情報）。実機での安定性確認は次フェーズ |
- **メモリ**: 2GB 以上推奨（コンテナ内 Google Chrome + FFmpeg + PulseAudio + Node.js が稼働）
- **ストレージ**: コンテナイメージ用（約 2GB）+ ブラウザプロファイル・設定永続化用（1GB〜）

### サポート OS
- **一般的な Linux ディストリビューション**: Ubuntu 20.04 / 22.04 / 24.04 LTS, Debian 11 / 12, Arch Linux 等（`x86_64`）
- **NAS OS**: TrueNAS SCALE (Docker / Custom App), Unraid, CasaOS 等（Intel/AMD `x86_64` CPU 搭載機）
- **Windows**: Windows 10 / 11（Docker Desktop for Windows / WSL2 バックエンド有効環境 — PowerShell / CMD から直接起動可能）

### 必要なソフトウェア
- Docker Engine 24.0 以上 / Docker Compose v2.0 以上（Windows は Docker Desktop for Windows）

### 注意が必要な環境・非推奨の環境

Tesroid は低遅延・省CPU負荷を実現するため、VAAPI ハードウェアエンコードを第一推奨としつつ、非対応環境では `ENCODER_MODE=auto` による `libx264` ソフトウェアフォールバックで動作します。以下の環境は運用面またはコスト面で注意が必要です：

1. **格安 VPS / GPU なしクラウド VM（動作可能・非推奨）**:
   - `ENCODER_MODE=auto` / `software` により `libx264` ソフトウェアエンコードへ自動フォールバックして起動・配信できます。
   - ただし、CPU エンコードでの安定動作には 2〜4 vCPU / 2GB〜4GB RAM 以上（月額 1,500〜3,500 円程度）のスペックと動画ストリーミングに伴う高い CPU 負荷・帯域コストがかかるため、常時利用には VAAPI 対応の自宅環境を推奨します。
2. **Windows PC（Docker Desktop / WSL2 — 対応・常時稼働は運用注意）**:
   - [`docker-compose.windows.yml`](../docker-compose.windows.yml) を使うことで、別途 WSL2 Linux ディストリビューションを用意しなくても PowerShell / CMD から直接導入・稼働できます（WSL2 Linux ディストリ内の `scripts/install.sh` も副次的に対応）。
   - ただし、PC のスリープ移行や Windows Update による自動再起動で車載からの接続が途切れやすいため、24時間常時稼働サーバー用途には Linux / NAS を推奨します。
3. **ARM CPU 搭載 NAS 等（Raspberry Pi / ARM64 NAS — 非対応）**:
   - コンテナイメージ・Google Chrome Stable（`amd64` 版）がすべて `x86_64` (`amd64`) 専用で構築されているため、ARM アーキテクチャでは動作しません。

---

## 2. 一般的な Docker / Docker Compose 環境でのデプロイ

Ubuntu、Debian、ミニ PC、x86_64 NAS、および Windows（Docker Desktop for Windows）環境での導入・運用手順です。初めて構築する場合は、Cloudflare アカウント登録〜ドメイン購入〜起動までをまとめた **[docs/QUICKSTART.md](QUICKSTART.md)** を参照してください。

### 2-A. ビルド不要の Docker Compose コピペ導入（推奨）

公開されているビルド済みベースイメージ（`ghcr.io/ranasgenoa/tesroid:latest`）と [`docker-compose.prebuilt.yml`](../docker-compose.prebuilt.yml)（Linux / NAS 向け）または [`docker-compose.windows.yml`](../docker-compose.windows.yml)（Windows Docker Desktop 向け）を使用することで、`git clone` やローカルでの `docker build` を行わずに起動できます。

> [!TIP]
> Cloudflare のアカウント登録・安価な独自ドメインの購入・Tunnel 作成〜`TUNNEL_TOKEN` 取得までの詳細な手順は **[かんたん導入ガイド (docs/QUICKSTART.md)](QUICKSTART.md)** に記載しています。
>
> - **`ghcr.io/ranasgenoa/tesroid:latest` について**: Google Chrome の再配布規約に配慮し、初回起動時にコンテナ内で Google Chrome 公式パッケージを自動取得します（初回のみ数十秒〜1〜2分かかります）。
> - **DuckDNS 等の無料 DDNS や自前リバースプロキシを使う場合**: `TUNNEL_TOKEN` を空欄にして [docs/NETWORK.md のパターン B（Caddy / Nginx ＋ ルーターの 80/443 開放）](NETWORK.md#パターン-b-自宅サーバー--リバースプロキシ-caddy--nginx) を使用してください。

#### 手順（Windows / Docker Desktop — PowerShell 第一推奨）
別途 WSL2 Linux ディストリビューションを用意せず、Windows PowerShell（または CMD）から直接起動できます：
1. 作業用フォルダを作成し、[`docker-compose.windows.yml`](../docker-compose.windows.yml) を取得します（Windows PowerShell 5.1 の `curl` エイリアスを避けるため `curl.exe` を使用してください）：
   ```powershell
   mkdir tesroid
   cd tesroid
   curl.exe -fsSL https://raw.githubusercontent.com/RanasGenoa/Tesroid/main/docker-compose.windows.yml -o docker-compose.windows.yml
   ```
2. `.env` ファイルを作成します（BOM なし ASCII で保存するため `Set-Content -Encoding Ascii` を使用します）：
   ```powershell
   @"
   TESROID_PORT=9001
   ENCODER_MODE=auto
   LIBVA_DRIVER_NAME=d3d12
   TUNNEL_TOKEN=eyJh...ここにCloudflare Zero Trustで取得したトンネルトークンを貼り付け
   "@ | Set-Content -Encoding Ascii .env
   ```
   > [!NOTE]
   > Docker Desktop 既定 VM に `/dev/dri` (`vgem`) がない場合や、GPU 側の WSL D3D12 UMD が H.264 VAAPI エンコードに対応していない場合は、`ENCODER_MODE=auto` により自動的に `libx264` ソフトウェアエンコードで起動します。
3. コンテナを起動し、ヘルスチェックとログを確認します：
   ```powershell
   docker compose -f docker-compose.windows.yml up -d
   docker compose -f docker-compose.windows.yml logs -f
   curl.exe -s http://127.0.0.1:9001/api/health
   ```

#### 手順（Linux / NAS）
1. 任意の作業ディレクトリを作成し、`docker-compose.prebuilt.yml` を取得（または内容を `docker-compose.yml` として保存）します：
   ```bash
   mkdir -p ~/tesroid && cd ~/tesroid
   curl -fsSL https://raw.githubusercontent.com/RanasGenoa/Tesroid/main/docker-compose.prebuilt.yml -o docker-compose.prebuilt.yml
   ```
2. `.env` ファイルを作成し、Cloudflare Zero Trust で取得した **Cloudflare Tunnel トークン（`TUNNEL_TOKEN`）** と公開ポート番号を設定します（未指定の `VAAPI_DEVICE` / `LIBVA_DRIVER_NAME` はコンテナ起動時に自動検出されます。Cloudflare Tunnel を使用しない場合は `TUNNEL_TOKEN` を空欄または省略し、`chmod 600` での保護を推奨します）：
   ```bash
   cat <<'EOF' > .env
   TESROID_PORT=9001
   ENCODER_MODE=auto
   TUNNEL_TOKEN=eyJh...ここにCloudflare Zero Trustで取得したトンネルトークンを貼り付け
   EOF
   chmod 600 .env
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

### 2-B. ワンショット導入スクリプト（x86_64 Linux 向け・副次 WSL2 ディストリ対応）

Ubuntu / Debian 等の x86_64 Linux 環境（ミニ PC・自宅サーバー等）および副次的に WSL2 Linux ディストリビューション内では、[`scripts/install.sh`](../scripts/install.sh) を使うことで環境チェックから起動までを対話式で一括実行できます（※ Windows 環境では上記 **2-A の PowerShell + `docker-compose.windows.yml`** が第一推奨です）。

**スクリプトが自動で行う処理**:
- OS・CPU アーキテクチャ（`x86_64`）の確認とマルチ GPU 走査（`/sys/class/drm/renderD*/device/vendor` を確認し NVIDIA `0x10de` より Intel/AMD を優先、WSL2 では `/dev/dxg` + `/usr/lib/wsl` を検出、GPU 不在時は `ENCODER_MODE=software` 継続を確認）
- Docker Engine / Docker Compose の確認・未導入時のインストール（Ubuntu / Debian 等）
- 実行ユーザーの `render` / `video` / `docker` グループへの追加（Linux DRI 環境時）
- 対話プロンプトでの設定入力（インストール先ディレクトリ、公開ポート既定 `9001`、任意の `TUNNEL_TOKEN`、`LIBVA_DRIVER_NAME`［`auto`（空欄）/ `iHD` / `i965` / `radeonsi` / `d3d12`］）
- `ghcr.io/ranasgenoa/tesroid:latest` を使った環境別 `docker-compose.yml` と `.env` の生成・コンテナ起動

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

### ステップ 2: ホスト側の GPU / Docker 環境の確認
- **Linux (Intel / AMD) の場合**: ホストで GPU デバイス `/dev/dri` が利用可能であることを確認します：
  ```bash
  # デバイスの存在確認
  ls -la /dev/dri
  # 出力例: card0, renderD128 が表示されれば OK

  # 必要に応じて実行ユーザーを render / video グループに追加
  sudo usermod -aG render,video $USER
  ```
- **Windows (Docker Desktop) の場合**: PowerShell で `docker info` が正常応答することを確認してください（`/dev/dri` やグループ追加は不要です）。

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
- `ENCODER_MODE`: エンコーダモード（`auto`: VAAPI 優先・不可時 `libx264` 自動フォールバック / `vaapi`: VAAPI 強制 / `software`: `libx264` 固定、デフォルト: `auto`）
- `VAAPI_DEVICE`: VAAPI レンダーノード（未指定時はコンテナ起動時に Intel/AMD ノードを自動選択、D3D12/`software` 時は空欄可）
- `LIBVA_DRIVER_NAME`: VAAPI ドライバ（空欄または `auto` で自動判定。手動指定: Intel Broadwell 以降 `iHD` / 旧世代 Intel `i965` / AMD `radeonsi` / Windows D3D12 `d3d12`）
- `TUNNEL_TOKEN`: Cloudflare Tunnel コネクタ用トークン（設定時は内蔵 `cloudflared` を自動起動、未設定時は無効）

### ステップ 4: Docker Compose でコンテナ起動
```bash
# Linux: イメージのローカルビルドとバックグラウンド起動
docker compose up -d --build
```
Windows（PowerShell）でローカルビルド版を起動する場合は、[`docker-compose.windows.yml`](../docker-compose.windows.yml) 内のコメントアウトされた `build:` 設定を有効化する（または `docker build -t ghcr.io/ranasgenoa/tesroid:latest .` 後に `docker compose -f docker-compose.windows.yml up -d` を実行する）ことで起動できます。

### ステップ 5: 動作確認
コンテナが正常に起動し、ヘルスチェックに応答するか確認します：
```bash
# ヘルスチェック
curl -s http://127.0.0.1:9001/api/health
# 応答例: {"status":"ok", ...}

# 起動ログの確認
docker compose logs -f
```

起動後、リバースプロキシ経由（またはローカル検証プロキシ `npm run proxy`）でブラウザからアクセスし、初期 PIN コード（半角数字 4〜8 桁）を登録してください。

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

### ビルド不要イメージ (GHCR) 環境の更新

`docker-compose.prebuilt.yml` または `scripts/install.sh` で導入した環境では、最新イメージを取得してコンテナを再作成します：

```bash
# docker-compose.yml（scripts/install.sh で生成した場合）
docker compose pull
docker compose up -d

# docker-compose.prebuilt.yml を直接利用している場合 (Linux)
docker compose -f docker-compose.prebuilt.yml pull
docker compose -f docker-compose.prebuilt.yml up -d

# docker-compose.windows.yml を利用している場合 (Windows PowerShell)
docker compose -f docker-compose.windows.yml pull
docker compose -f docker-compose.windows.yml up -d
```

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

### 3. VAAPI / エンコーダバックエンドの動作診断
現在アクティブなエンコーダバックエンド（`vaapi` か `software` (`libx264`) か）と自動フォールバック履歴は `/api/health` で確認できます：
```bash
curl -s http://127.0.0.1:9001/api/health
```
コンテナ内部で DRM VAAPI デバイスが正しく認識されているか確認するコマンド（`DISPLAY=:99` の Xvfb を誤ってプローブしないよう `--display drm --device` を明示指定します。マルチ GPU で `renderD129` 等を使う場合は対象デバイスへ置き換えてください）：
```bash
docker exec -it tesroid-server vainfo --display drm --device /dev/dri/renderD128
# 出力に VAProfileH264Main / VAEntrypointEncSlice 等が表示されていれば VAAPI エンコード対応
```
> [!NOTE]
> Windows Docker Desktop 環境では既定で `/dev/dri` (`vgem`) が存在しない（または GPU の WSL D3D12 UMD が `VideoProc` のみで H.264 エンコード非対応）場合、`/api/health` 上で `encoder.backend: "software"` となり `libx264` で正常動作します。

パフォーマンスプリセットと CPU フォールバックの継承挙動（実機検証に基づく仕様）：

- 設定画面で保存したプリセット（`high` / `balanced` / `low_power` / `cpu_balanced` / `cpu_low_power` / `custom`）は `/data/config.json` に永続化され、コンテナ再起動後は保存値がそのまま起動時設定として継承されます（CPUプリセットの libx264 `-preset` 内部既定値も含む。`/api/health` の `encoder.x264Preset` で確認できます）。
- GPU 非対応環境で最初から、または稼働中の段階降格により `software` バックエンドで動作する場合、エンコーダは安全側の既定値（`libx264 -preset ultrafast` + 保存済みの解像度上限）で稼働し、**保存済みのパフォーマンスプリセットが CPUプリセットへ自動的に書き換えられることはありません**。CPU 専環境で明示的な負荷低減を望む場合は、設定画面で `CPU・標準` / `CPU・軽量` を選択してください（CPU 稼働中は詳細設定の VAAPI 依存項目はグレーアウトされ、設定画面の状態パネルに使用中のエンコーダ情報が併記されます）。

### 4. コンテナログのリアルタイム確認
```bash
docker compose logs -f --tail 50
# または
docker logs -f --tail 50 tesroid-server
```
