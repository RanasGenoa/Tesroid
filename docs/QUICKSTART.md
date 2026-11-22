# かんたん導入ガイド（Docker Compose ＋ Cloudflare Tunnel）

**ビルド不要・ルーターのポート開放不要**で、Tesroid を Linux サーバーまたは Windows PC（Docker Desktop for Windows）で起動し、テスラ車載ブラウザから HTTPS で接続できる状態までセットアップする手順です。

> [!TIP]
> 自前のリバースプロキシ（Caddy / Nginx）、DuckDNS、NAS（TrueNAS SCALE 等）、またはローカルビルドを使いたい場合は、[docs/DEPLOYMENT.md](DEPLOYMENT.md) / [docs/NETWORK.md](NETWORK.md) をご覧ください。

---

## 0. 事前に用意するもの

1. **サーバー PC（Linux / ミニ PC または Windows PC、`x86_64` 専用）**
   - **Linux の場合**: Intel（第5世代 Broadwell 以降の `iHD` およびそれ以前の旧世代向け `i965`）または AMD Radeon（`radeonsi`）搭載の `x86_64` 環境（Raspberry Pi や ARM 機は非対応。GPU なし環境でも `ENCODER_MODE=auto` により `libx264` で動作可能ですが 2〜4 vCPU を推奨）
   - **Windows の場合（第一推奨: Docker Desktop for Windows）**: Windows 10 / 11 (`x86_64`) + **Docker Desktop for Windows**（WSL2 バックエンド有効・既定設定。別途 WSL2 Linux ディストリビューションの導入は不要。`/dev/dxg` + `/usr/lib/wsl` の D3D12 ブリッジ構成で起動し、`d3d12` VAAPI エンコード非対応 GPU 環境では自動的に `libx264` ソフトウェアエンコードへフォールバックして動作します）
   - メモリ 2 GB 以上推奨
   - Docker Engine 24.0+ / Docker Compose v2.0+（Linux で未導入の場合は Step 6 方法 B の導入スクリプトで自動インストールもできます）
2. **Cloudflare アカウント（無料）と独自ドメイン**
   - DuckDNS などの無料 DDNS は Cloudflare Tunnel で使えないため、独自ドメインを 1 つ用意します（Cloudflare 上で年 \$4〜\$5 前後から購入できます）。
   - ドメイン購入用の支払い方法（クレジットカード等）をご用意ください。

---

## Step 1: サーバー側の GPU / Docker 環境を確認する

- **Windows（Docker Desktop for Windows / PowerShell）の場合**:
  - Docker Desktop が起動しており、WSL2 バックエンド（既定設定）が有効であることを PowerShell で確認します（`/dev/dri` や `usermod` は不要で、別途 WSL2 Linux ディストリビューションを入れる必要もありません）：
    ```powershell
    docker info
    ```
- **Linux の場合**:
  - GPU デバイス（`/dev/dri`）が認識されていること、およびユーザーに必要な権限があることを確認します（[方法 B の導入スクリプト](#方法-b-ワンショット導入スクリプトを使う場合linux--副次的な-wsl2-ディストリビューション向け) を使う場合はこの手順をスキップできます）：
    ```bash
    # 1. GPU デバイスの確認（card0 や renderD128 等が表示されれば OK）
    ls -la /dev/dri

    # 2. Docker と GPU へのアクセス権限を付与（未設定の場合）
    sudo usermod -aG render,video,docker "$USER"
    # ※ 反映には一度ログアウト＆再ログインが必要です
    ```

---

## Step 2: Cloudflare 無料アカウントを作成する

1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) にアクセスし、無料アカウントを作成してサインインします。
2. 画面が英語の場合は、右上の言語メニューから **日本語** に切り替えられます。

---

## Step 3: 独自ドメインを購入する（Cloudflare Registrar）

他社で購入済みのドメインも利用できますが、**Cloudflare 上で直接購入するとドメインとトンネルの連携が自動で行われるため最も簡単** です。

1. Cloudflare ダッシュボードの左メニューから **ドメイン登録（Domain Registration）** ➔ **ドメインを登録（Register Domains）** を開きます。
2. 検索欄に希望するドメイン名（任意の英数字）を入力して検索します。
   末尾（`.com` や `.stream` など）ごとに **初年度価格** と **更新価格** が表示されます。

   > [!IMPORTANT]
   > **価格選びの注意点（必ず「更新価格」も確認してください）**:
   > - 初年度だけ安く、2年目以降の更新費用が高いドメインがあります（例: `.fun`、`.online`、`.site` などは更新価格が \$25〜\$30 以上になる場合があります）。
   > - コストを抑えたい場合は、更新価格も安いものを選ぶのがおすすめです（価格は時期により変動します）：
   >   - **最安クラス目安**: `.bid` / `.date` / `.download` / `.loan` / `.men` / `.party` / `.stream` / `.trade` / `.win`（初年度 約 \$4 前後 / 更新 約 \$5 前後）
   >   - **`.top`**: 約 \$5 前後（※ 文字列によっては登録できない場合があります）

3. 購入したいドメインを **カートに追加** し、チェックアウトへ進みます。
4. 連絡先の入力画面が表示された場合は、案内に従って入力します（アカウントに未登録の場合のみ）：
   - **名（First Name）・姓（Last Name）**: ローマ字で入力（例: `Taro` / `Yamada`）
   - **電話番号**: 国番号 **`+81`**（日本）を選択して入力
   - **国・都道府県・市区町村・住所・郵便番号**: 案内に従って入力して保存（※ 登録情報は非公開設定で保護されます）
5. 支払いを確定すると登録完了となり、ドメインのステータスが **「アクティブ」** になります。

---

## Step 4: トンネルを作成して `TUNNEL_TOKEN` を取得する

1. [Cloudflare Zero Trust ダッシュボード](https://one.dash.cloudflare.com/) を開きます。
   - ※ 初めて開く場合は、任意のチーム名（英数字）を入力し、プラン選択画面で **Free プラン（\$0）** を選んで初期設定を完了してください（\$0 でも支払い方法の確認が求められる場合があります）。
2. 左メニューの **Networks** ➔ **Tunnels** ➔ **Create a tunnel** をクリックします。
3. 任意のトンネル名（例: `tesroid`）を入力して作成します。
   - ※ 種別選択の画面が出た場合は **Cloudflared** を選択してください。
4. 作成直後に **「コネクタのインストール（Install connector）」** 画面が表示されます。
   画面内のコマンド（例: `cloudflared service install eyJh...`）の中から、**`eyJh...` で始まる長い文字列だけ** をコピーして控えます。これが **`TUNNEL_TOKEN`** です。

   > [!CAUTION]
   > - コマンド全体ではなく、**`eyJh...` 以降のトークン文字列のみ** をコピーしてください。
   > - **`TUNNEL_TOKEN` は外部に公開しないでください。** GitHub やスクリーンショットに含めないようご注意ください。
   > - コピーし忘れた場合は、後から **Networks** ➔ **Tunnels** で対象トンネルを開き、設定画面（コネクタのインストール手順）からいつでも再表示できます。

---

## Step 5: 公開 URL を設定する

トンネル作成画面に続いて、Tesroid にアクセスするための URL を設定します（後からトンネル詳細画面でも変更できます）。

1. **ルート / Public Hostname**（または **Published application routes**）の追加画面を開きます。
2. 以下のように入力して保存します：
   - **Subdomain**: `tesroid` など任意の文字（例: `https://tesroid.example.stream`）。購入したドメインそのもの（例: `https://example.stream`）で公開したい場合は **空欄** のままにします。
   - **Domain**: Step 3 で購入したドメイン（例: `example.stream`）を選択
   - **Service Type**: **`HTTP`**
   - **URL**: **`localhost:8080`**（または `http://localhost:8080`）
     > [!NOTE]
     > HTTP を指定するため、追加の TLS 検証設定（`No TLS Verify` 等）は不要です。
3. 保存すると「ルートが正常に追加されました」と表示され、公開用のアドレス設定が完了します。
4. （念のため）Cloudflare ダッシュボード側の **Network** 設定で **WebSockets** がオン（デフォルトでオン）になっていることを確認します。

> [!NOTE]
> この時点ではまだ Tesroid を起動していないため、トンネル一覧のステータスは **「非アクティブ（Inactive）」** と表示されますが正常です。次の Step 6 でコンテナを起動すると **「正常（HEALTHY）」** に変わります。

---

## Step 6: Docker Compose で Tesroid を起動する

### 方法 A-1: Windows (Docker Desktop / PowerShell — 第一推奨)

Windows では WSL2 Linux ディストリビューションを手動構築せず、PowerShell（または CMD）から直接 [`docker-compose.windows.yml`](../docker-compose.windows.yml) を起動します。

> [!NOTE]
> - Windows PowerShell 5.1 では `curl` が `Invoke-WebRequest` のエイリアスのため、必ず **`curl.exe`** を使用してください。
> - Docker Desktop 既定の VM では `/dev/dri` (`vgem`) が露出されない場合や、一部 GPU の WSL D3D12 UMD 制限（例: AMD Radeon RX 9070 XT 等）により `d3d12` VAAPI エンコードが利用できない場合がありますが、`ENCODER_MODE=auto` により自動的に **`libx264` ソフトウェアエンコード** へ切り替わりそのまま動作します。

1. PowerShell で作業用フォルダを作成し、[`docker-compose.windows.yml`](../docker-compose.windows.yml) をダウンロードします：
   ```powershell
   mkdir tesroid
   cd tesroid
   curl.exe -fsSL https://raw.githubusercontent.com/RanasGenoa/Tesroid/main/docker-compose.windows.yml -o docker-compose.windows.yml
   ```
2. 同じフォルダに `.env` ファイルを作成し、Step 4 でコピーした **`TUNNEL_TOKEN`** を貼り付けます（BOM なし ASCII で作成するため `Set-Content -Encoding Ascii` を使用します）：
   ```powershell
   @"
   TESROID_PORT=9001
   ENCODER_MODE=auto
   LIBVA_DRIVER_NAME=d3d12
   TUNNEL_TOKEN=eyJh...ここにコピーしたトークンを貼り付け
   "@ | Set-Content -Encoding Ascii .env
   ```
3. コンテナを起動します：
   ```powershell
   docker compose -f docker-compose.windows.yml up -d
   ```
4. 起動ログおよび動作モードを確認します（初回起動時のみ Google Chrome を自動取得するため、数十秒〜1〜2分かかります）：
   ```powershell
   docker compose -f docker-compose.windows.yml logs -f
   curl.exe -s http://127.0.0.1:9001/api/health
   ```
   `Tesroid v2 Browser Server running at http://0.0.0.0:8080` が表示されたら起動完了です（`/api/health` の `encoder.backend` で `vaapi` / `software` のどちらが動作中か確認できます）。

### 方法 A-2: Linux / NAS (`docker-compose.prebuilt.yml` を使う場合)

1. サーバー上で作業用フォルダを作成し、[`docker-compose.prebuilt.yml`](../docker-compose.prebuilt.yml) をダウンロードします：
   ```bash
   mkdir -p ~/tesroid && cd ~/tesroid
   curl -fsSL https://raw.githubusercontent.com/RanasGenoa/Tesroid/main/docker-compose.prebuilt.yml -o docker-compose.prebuilt.yml
   ```
2. 同じフォルダに `.env` ファイルを作成し、Step 4 でコピーした **`TUNNEL_TOKEN`** を貼り付けます：
   ```bash
   cat <<'EOF' > .env
   TESROID_PORT=9001
   ENCODER_MODE=auto
   TUNNEL_TOKEN=eyJh...ここにコピーしたトークンを貼り付け
   EOF
   chmod 600 .env
   ```
   > [!TIP]
   > `LIBVA_DRIVER_NAME` と `VAAPI_DEVICE` は未指定のままでコンテナ起動時に自動判定されます（Intel Broadwell 以降: `iHD`、旧世代 Intel: `i965`、AMD Radeon: `radeonsi`、NVIDIA のみの環境等は `libx264` へフォールバック）。手動固定したい場合のみ `.env` に `LIBVA_DRIVER_NAME=radeonsi` 等を追記してください。
3. コンテナを起動します：
   ```bash
   docker compose -f docker-compose.prebuilt.yml up -d
   ```
4. 起動ログを確認します（初回起動時のみ Google Chrome を自動取得するため、数十秒〜1〜2分かかります）：
   ```bash
   docker compose -f docker-compose.prebuilt.yml logs -f
   ```
   `Tesroid v2 Browser Server running at http://0.0.0.0:8080` が表示されたら起動完了です（ヘルスチェック例: `curl -s http://127.0.0.1:9001/api/health`）。

### 方法 B: ワンショット導入スクリプトを使う場合（Linux / 副次的な WSL2 ディストリビューション向け）

Ubuntu / Debian 等の Linux 環境で Docker 導入から設定ファイル生成まで対話形式で自動化したい場合（および副次的に WSL2 Linux ディストリビューション内で構築したい場合）は以下を実行し、プロンプトで `TUNNEL_TOKEN` を貼り付けてください（※ Windows 環境の第一推奨は上記の **方法 A-1: PowerShell + `docker-compose.windows.yml`** です）：

```bash
curl -fsSL https://raw.githubusercontent.com/RanasGenoa/Tesroid/main/scripts/install.sh -o install.sh
bash install.sh
```

---

## Step 7: 初回 PIN 設定とテスラ車載ブラウザでの接続

1. Cloudflare Zero Trust の **Tunnels** 一覧で、トンネルのステータスが **「正常（HEALTHY）」** になったことを確認します。
2. Step 5 で設定した URL（例: `https://example.stream` または `https://tesroid.example.stream`）をブラウザで開きます。
3. 初回セットアップ画面が表示されるので、**半角数字 4〜8 桁の PIN コード（0〜9 の数字のみ）** を設定します。
4. テスラ車載ブラウザで同じ URL を開き、PIN を入力すれば完了です。

---

## 更新方法（新しいバージョンが出たとき）

以下を実行すると、ログイン状態や PIN 設定を保持したまま最新イメージに更新できます：

```bash
# Windows (PowerShell / docker-compose.windows.yml を使っている場合)
cd tesroid
docker compose -f docker-compose.windows.yml pull
docker compose -f docker-compose.windows.yml up -d

# Linux (docker-compose.prebuilt.yml を使っている場合)
cd ~/tesroid
docker compose -f docker-compose.prebuilt.yml pull
docker compose -f docker-compose.prebuilt.yml up -d

# scripts/install.sh で生成した docker-compose.yml を使っている場合
cd ~/tesroid
docker compose pull
docker compose up -d
```

---

## 関連ドキュメント

- **ローカルビルド・NAS 運用・PIN ロックアウト解除・VAAPI 診断**: [docs/DEPLOYMENT.md](DEPLOYMENT.md)
- **その他の公開方法（Caddy / Nginx / DuckDNS / VPS）**: [docs/NETWORK.md](NETWORK.md)
