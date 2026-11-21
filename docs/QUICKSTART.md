# かんたん導入ガイド（Docker Compose ＋ Cloudflare Tunnel）

このガイドでは、**ローカルでのビルド作業なし・ルーターのポート開放なし・SSL 証明書の手動管理なし** で、Tesroid をご自身の Linux サーバー / ミニ PC に構築し、テスラ車載ブラウザから安全に HTTPS 接続するまでの手順を最初から順番に説明します。

> [!NOTE]
> **この導入方法がおすすめの理由**:
> - **Docker ビルド不要**: 公開済みのコンテナイメージ（`ghcr.io/ranasgenoa/tesroid:latest`）をそのまま利用します。
> - **ポート開放不要**: Cloudflare Tunnel をコンテナに内蔵しているため、自宅ルーターの設定変更や CGNAT 回線（マンション回線・NURO光・IPv6 IPoE 等）の制約を気にせず安全に外部公開できます。
> - **SSL 証明書が自動**: テスラ車載ブラウザで必須となる公的 CA の HTTPS/WSS 通信が自動で有効になります。

> [!TIP]
> 自前のリバースプロキシ（Caddy / Nginx）、DuckDNS、VPS、TrueNAS SCALE、またはソースコードからのローカルビルドを行いたい場合は、高度な設定ガイド（[docs/DEPLOYMENT.md](DEPLOYMENT.md) / [docs/NETWORK.md](NETWORK.md)）をご覧ください。

---

## 0. 事前に用意するもの

1. **対応サーバー（Linux ホスト）**
   - **CPU**: `x86_64` (`amd64`) アーキテクチャ（※ Raspberry Pi や ARM NAS は非対応）
   - **GPU**: Intel 第6世代（Skylake）以降の統合 GPU（Quick Sync / VAAPI）または AMD Radeon（VAAPI）、ホスト上に `/dev/dri/renderD128` があること
   - **メモリ**: 2 GB 以上推奨
   - **OS**: Ubuntu 22.04/24.04 LTS、Debian 11/12 等の Linux
   - **ソフトウェア**: Docker Engine 24.0+ および Docker Compose v2.0+（未導入の場合は Step 1 のワンショットスクリプトでも自動導入できます）
2. **Cloudflare アカウント（無料）と独自ドメイン**
   - 無料の DDNS（DuckDNS 等）は Cloudflare Tunnel で利用できないため、独自ドメインを 1 つ用意します（Cloudflare 公式から **年 \$4〜\$5 前後** で取得できます）。
   - ドメイン購入用の支払い方法（クレジットカード等）をご用意ください。

---

## Step 1: サーバー側の準備（Docker・GPU 権限）

Linux サーバー上で、Docker と GPU デバイス（`/dev/dri/renderD128`）が利用可能か確認します。

```bash
# 1. GPU デバイスの存在確認（card0 や renderD128 が表示されれば OK）
ls -la /dev/dri

# 2. Docker を sudo なしで使う＆GPU アクセス権限を付与（未設定の場合）
sudo usermod -aG render,video,docker "$USER"
# ※ 反映には一度ログアウト＆再ログインが必要です
```

> [!TIP]
> Docker のインストールやグループ権限設定もまとめて自動化したい場合は、Step 5 のあとに [ワンショット導入スクリプト (`scripts/install.sh`)](#方法-b-ワンショット導入スクリプトを使う場合ubuntu--debian-等) を使うこともできます。

---

## Step 2: Cloudflare 無料アカウントを作成する

1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) にアクセスします。
2. メールアドレスとパスワードを入力して無料アカウントを作成し、サインインします。
3. 画面が英語の場合は、画面右上の言語切り替えメニューから **日本語** に変更できます。

---

## Step 3: 独自ドメインを購入する（Cloudflare Registrar）

他社で取得済みのドメインを移譲することもできますが、**Cloudflare 内で直接購入するとネームサーバー設定や DNS 連携が自動で行われるため最も簡単** です。

1. Cloudflare ダッシュボードの左メニューから **ドメイン登録（Domain Registration）** ➔ **ドメインを登録（Register Domains）** を開きます。
2. 検索欄に希望するドメイン名（任意の英数字）を入力して検索します。
   末尾（TLD）ごとに **初年度価格** と **更新価格** が表示されます。

   > [!IMPORTANT]
   > **ドメイン選びの注意点（必ず「更新価格」も確認してください）**:
   > - 初年度だけ安く、2年目以降の更新費用が高い TLD があります（例: `.fun`、`.online`、`.site` などは更新価格が \$25〜\$30 以上になる場合があります）。
   > - 価格を抑えて運用したい場合は、更新価格も安い TLD を選ぶのがおすすめです（価格は時期や為替により変動します）：
   >   - **最安クラス目安**: `.bid` / `.date` / `.download` / `.loan` / `.men` / `.party` / `.stream` / `.trade` / `.win`（初年度 約 \$4 前後 / 更新 約 \$5 前後）
   >   - **`.top`**: 約 \$5 前後（※ 文字列によっては登録非対応の場合があります）

3. 気に入ったドメインの **カートに追加** を押し、チェックアウトへ進みます。
4. **登録者連絡先（WHOIS 情報）を入力** します（アカウントに未登録の場合のみ求められます）：
   - **名（First Name）・姓（Last Name）**: **ローマ字表記** で入力します（例: 名 `Taro` / 姓 `Yamada`）。
   - **電話番号**: 国番号 **`+81`**（日本）を選択して入力します。
   - **国・都道府県・市区町村・住所・郵便番号**: 案内に従って入力して保存します。
   - ※ 入力した連絡先は WHOIS プライバシー保護の対象となり、外部には公開されません。
5. 支払い方法を入力して注文を確定します。完了するとドメインのステータスが **「アクティブ」** になります（自動更新の設定は必要に応じて管理画面で確認できます）。

---

## Step 4: Cloudflare Tunnel を作成し `TUNNEL_TOKEN` を取得する

1. [Cloudflare Zero Trust ダッシュボード](https://one.dash.cloudflare.com/) を開きます。
   - ※ 初めて開く場合は、任意のチーム名（英数字）を入力し、プラン選択画面で **Free プラン（\$0）** を選んで初期設定を完了してください（\$0 でも支払い方法の確認が求められる場合があります）。
2. 左メニューから **Networks** ➔ **Tunnels** ➔ **Create a tunnel** をクリックします。
3. 任意のトンネル名（例: `tesroid`）を入力して作成します。
   - ※ 現行の画面ではそのまま `cloudflared` トンネルとして作成されます。もしトンネル種別の選択画面が表示された場合は **Cloudflared** を選択してください。
4. 作成直後に **「コネクタのインストール（Install connector）」** 画面が表示されます。
   画面に表示されているコマンド（例: `cloudflared service install eyJh...`）の中から、**`eyJh...` で始まる長い英数字の文字列だけ** をコピーして控えます。これが次のステップで使う **`TUNNEL_TOKEN`** です。

   > [!CAUTION]
   > - コマンド全体ではなく、**`eyJh...` 以降のトークン文字列のみ** をコピーしてください。
   > - **`TUNNEL_TOKEN` は秘密情報（合鍵）です。** GitHub などの公開場所やスクリーンショットに絶対に含めないでください。
   > - コピーし忘れた場合は、後から **Networks** ➔ **Tunnels** で作成したトンネルを開き、設定画面（コネクタのインストール手順）からいつでも再表示できます。

---

## Step 5: 公開 URL（Public Hostname / ルート）を設定する

トンネルの作成画面に続いて、どの URL で Tesroid を公開するかを設定します（後からトンネル詳細画面のタブでも設定・変更できます）。

1. トンネルの **ルート / Public Hostname**（または **Published application routes**）の追加画面を開きます。
2. 以下のように入力して保存します：
   - **Subdomain**: `tesroid` などの任意のサブドメイン（例: `https://tesroid.example.stream`）。購入したドメインそのもの（例: `https://example.stream`）で公開したい場合は **空欄** のままにします。
   - **Domain**: Step 3 で購入したドメイン（例: `example.stream`）を選択します。
   - **Service Type**: **`HTTP`**
   - **URL**: **`localhost:8080`**（または `http://localhost:8080`）
     > [!IMPORTANT]
     > Tesroid コンテナの内部で `cloudflared` と Tesroid 本体が一緒に動く構成のため、転送先 URL には必ず **`localhost:8080`**（`http://localhost:8080`）を指定してください。
   - **Additional application settings** ➔ **HTTP Settings**: 必要に応じて `No TLS Verify` を有効にします。
3. Cloudflare ダッシュボード（通常サイトの **Network** メニュー）で **WebSockets** が有効（デフォルト ON）になっていることを確認します。
4. 保存すると「ルートが正常に追加されました」と表示され、DNS の CNAME レコードが自動で作成されます。

> [!NOTE]
> この時点ではまだサーバー側を起動していないため、トンネル一覧のステータスが **「非アクティブ（Inactive）」** と表示されますが正常です。次の Step 6 でコンテナを起動すると自動で接続され、**「正常（HEALTHY）」** になります。

---

## Step 6: Docker Compose で Tesroid を起動する

### 方法 A: `docker-compose.prebuilt.yml` を使う場合（推奨・コピペ導入）

1. サーバー上で作業用フォルダを作成し、[`docker-compose.prebuilt.yml`](../docker-compose.prebuilt.yml) をダウンロードします：
   ```bash
   mkdir -p ~/tesroid && cd ~/tesroid
   curl -fsSL https://raw.githubusercontent.com/RanasGenoa/Tesroid/main/docker-compose.prebuilt.yml -o docker-compose.prebuilt.yml
   ```
2. 同じフォルダに `.env` ファイルを作成し、Step 4 で控えた **`TUNNEL_TOKEN`** を貼り付けます：
   ```bash
   cat <<'EOF' > .env
   TESROID_PORT=9001
   TUNNEL_TOKEN=eyJh...ここにコピーしたトークンを貼り付け
   EOF
   chmod 600 .env
   ```
3. コンテナを起動します：
   ```bash
   docker compose -f docker-compose.prebuilt.yml up -d
   ```
4. 起動ログを確認します（初回起動時のみコンテナ内で Google Chrome を自動取得するため、数十秒〜1〜2分ほどかかります）：
   ```bash
   docker compose -f docker-compose.prebuilt.yml logs -f
   ```
   `Tesroid v2 Browser Server running at http://0.0.0.0:8080` などのログが流れ、別のターミナル等でヘルスチェックが応答すれば準備完了です：
   ```bash
   curl -s http://127.0.0.1:9001/api/health
   ```

### 方法 B: ワンショット導入スクリプトを使う場合（Ubuntu / Debian 等）

Docker 未導入の環境や、対話形式でフォルダ作成〜起動まで自動化したい場合は以下を実行し、プロンプトで `TUNNEL_TOKEN` を貼り付けてください：

```bash
curl -fsSL https://raw.githubusercontent.com/RanasGenoa/Tesroid/main/scripts/install.sh -o install.sh
bash install.sh
```

---

## Step 7: 初回 PIN 設定とテスラ車載ブラウザでの接続

1. Cloudflare Zero Trust ダッシュボードの **Tunnels** 一覧で、トンネルのステータスが **「正常（HEALTHY）」** になったことを確認します。
2. ブラウザ（PC・スマホ・テスラ車載ブラウザのいずれでも可）で、Step 5 で設定した URL（例: `https://example.stream` または `https://tesroid.example.stream`）にアクセスします。
3. 初回セットアップ画面が表示されるので、**4〜8 桁の認証 PIN コード** を設定します。
4. テスラ車載ブラウザから同じ URL を開き、設定した PIN でログインして操作・視聴できることを確認してください！

---

## バージョンアップ（更新方法）

`docker-compose.prebuilt.yml` や `scripts/install.sh` で導入した場合、新しいイメージが公開されたら以下を実行するだけで最新化できます（ブラウザのログイン状態や PIN 設定は保持されます）：

```bash
cd ~/tesroid

# docker-compose.prebuilt.yml を使っている場合
docker compose -f docker-compose.prebuilt.yml pull
docker compose -f docker-compose.prebuilt.yml up -d

# scripts/install.sh で生成した docker-compose.yml を使っている場合
docker compose pull
docker compose up -d
```

---

## 困ったとき・高度な構成を行いたい場合

- **PIN を 10 回間違えてロックされた / VAAPI の動作を確認したい / ローカルビルドや NAS 設定を行いたい**:
  ➔ [docs/DEPLOYMENT.md](DEPLOYMENT.md)
- **Cloudflare Tunnel 以外の公開方法（Caddy / Nginx / DuckDNS / VPS / Quick Tunnels）を使いたい**:
  ➔ [docs/NETWORK.md](NETWORK.md)
