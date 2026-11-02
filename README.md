# Tesroid

**Tesla-Optimized Self-Hosted Cloud Browser Streaming System**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

自宅サーバー（Linux / NAS）やクラウド VM 上の単一 Docker コンテナ内で **VAAPI ハードウェア支援 Google Chrome** を稼働させ、**テスラ車載ブラウザから超低遅延で遠隔タッチ操作・動画視聴を行うセルフホスト型クラウドブラウザシステム** です。

コンテナネイティブなブラウザ実行と GPU ハードウェアデコード＆エンコード（Intel Quick Sync / AMD VAAPI）を組み合わせることで、**圧倒的な省リソース・低CPU負荷・高速起動（2〜3秒）** を実現しています。

---

## 🚘 テスラ車載ブラウザ特化の主要機能

1. **Dレンジ走行中のブラックアウト完全回避 (Canvas2D + WebCodecs)**
   - テスラ車載 OS は走行開始（D/Rレンジ投入）時にブラウザ内のすべての `<video>` 要素を強制停止します。
   - Tesroid は `<video>` タグを一切使用せず、単一 WebSocket から受信した H.264 ストリームを **WebCodecs API (`VideoDecoder`)** でハードウェアデコードし、**HTML5 `<canvas>`** に直接ゼロコピー描画します。
2. **VAAPI ハードウェアフルアクセラレーション**
   - **映像デコード**: コンテナ内の Google Chrome が VAAPI 経由で VP9 / H.264 をハードウェアデコード。
   - **映像・音声エンコード**: FFmpeg が X11 仮想画面を直接キャプチャし、`h264_vaapi`（ゼロ遅延）+ `libopus`（20ms 低遅延フレーム）でリアルタイム配信。
3. **CDP ネイティブ静電容量タッチ & 慣性スクロール**
   - Chrome DevTools Protocol (`Input.dispatchTouchEvent`) により Blink エンジンへ直接マルチタッチイベントを注入。スマートフォン同等の滑らかな慣性スクロールと正確なタップ操作を実現。
4. **車載大画面向けフルスクリーン PIN 認証 & 自動ロックアウト**
   - 15/17 インチの車載モニターで片手入力しやすいフルスクリーン PIN パッドを採用。
   - 外部公開時のブルートフォース攻撃を防ぐため、**10回連続で PIN を誤入力した時点でサーバープロセスを即座に緊急停止（`exit 1`）** します。
5. **省電力オートスリープ & 即時レジューム (`SIGSTOP` / `SIGCONT`)**
   - クライアント切断後、設定時間経過でブラウザおよびエンコーダプロセスを自動凍結し CPU/GPU 使用率を 0% に解放。再接続時にミリ秒単位で即座に復帰します。
6. **ブラウザプロファイル永続化**
   - `/data/browser-profile` をボリューム永続化することで、ログインセッションや表示設定をコンテナ再起動後も維持します。

---

## 🏗 アーキテクチャ

```text
[ Tesla In-Car Browser (Client) ]
        │  HTTPS / WSS (Port 443 via Reverse Proxy / Cloudflare Tunnel)
        │  - WebCodecs VideoDecoder -> <canvas> zero-copy rendering
        │  - Web Audio API (Opus low-latency playback & A/V sync)
        ▼
[ Docker Host (Linux / VPS / NAS) ]
  └── [ Container: tesroid-server (Ubuntu 22.04 / Single Container) ]
        ├── GPU Passthrough : /dev/dri (Intel QuickSync iHD / AMD radeonsi VAAPI)
        ├── Virtual Display : Xvfb (:99) + Openbox (undecorated window)
        ├── Virtual Audio   : PulseAudio (unix:/tmp/pulse-socket, virtual_sink)
        ├── Cloud Browser   : Google Chrome Stable + Car Fullscreen Extension
        ├── Media Encoder   : FFmpeg (x11grab -> h264_vaapi + libopus)
        └── Streaming Server: Node.js Fastify (Multiplexed WS + CDP Touch Bridge)
```

---

## 📋 動作要件

- **OS**: Linux (Ubuntu 20.04/22.04/24.04, Debian 11/12 等)、NAS OS (TrueNAS SCALE 等)、またはクラウド VM
- **GPU**: VAAPI 対応 GPU（Intel 第6世代 Skylake 以降の統合 GPU Quick Sync Video、または AMD Radeon VAAPI）
  - ホスト上に `/dev/dri/renderD128` が存在すること
- **メモリ**: 2 GB 以上推奨
- **ソフトウェア**: Docker Engine 24.0+ および Docker Compose v2.0+
- **ネットワーク**: テスラ車載ブラウザから接続する場合は **公的 CA による HTTPS (SSL/TLS) 環境** が必須です（詳細は [docs/NETWORK.md](docs/NETWORK.md) を参照）

---

## 🚀 クイックスタート (Docker Compose)

> [!IMPORTANT]
> 本リポジトリはソースコードおよび `Dockerfile` のみを配布しています。Google Chrome の利用規約に基づき、Docker イメージはご自身のホスト環境でローカルビルドしてご利用ください（ビルド済みイメージのパブリックレジストリへの再配布は行わないでください）。

```bash
# 1. リポジトリのクローン
git clone https://github.com/<YOUR_ORG_OR_USER>/Tesroid.git
cd Tesroid

# 2. 環境変数ファイルの作成（必要に応じてポートや初期URLを調整）
cp .env.example .env

# 3. コンテナイメージのローカルビルド & バックグラウンド起動
docker compose up -d --build

# 4. ヘルスチェック確認
curl http://localhost:9001/api/health
```

初回アクセス時にブラウザ上で **初期セットアップウィザード** が表示されます。4〜8桁の認証 PIN コードを設定してください。

### 主要な環境変数 (`.env`)

| 変数名 | デフォルト値 | 説明 |
| :--- | :--- | :--- |
| `TESROID_PORT` | `9001` | ホスト側に公開する HTTP / WebSocket ポート |
| `BROWSER_URL` | `https://www.youtube.com` | 起動時に開く初期 URL |
| `DISPLAY_WIDTH` | `1280` | 仮想ディスプレイ横解像度 |
| `DISPLAY_HEIGHT` | `720` | 仮想ディスプレイ縦解像度 |
| `FPS` | `30` | エンコードフレームレート (`30` または `60`) |
| `VIDEO_BITRATE` | `1000k` | 初期映像ビットレート（車載 UI から動的に変更可能） |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | コンテナ内で使用する VAAPI レンダーノード |
| `LIBVA_DRIVER_NAME` | `iHD` | VAAPI ドライバ名（Intel: `iHD` / 旧世代Intel: `i965` / AMD: `radeonsi`） |

---

## 🌐 外部公開 & テスラ車載ブラウザ接続

テスラ車載ブラウザ（Chromium）のセキュリティ仕様により、`WebCodecs API` は **セキュアコンテキスト（HTTPS）** でのみ有効化されます（非暗号化 HTTP や自己署名証明書では動作しません）。

環境に応じた推奨構築手順と設定テンプレートは **[docs/NETWORK.md](docs/NETWORK.md)** を参照してください：

- **Cloudflare Tunnels (推奨・ポート開放不要)**: CGNAT 回線や自宅ルーターのポート開放なしで安全に HTTPS/WSS 公開
- **Caddy / Nginx リバースプロキシ**: 独自ドメイン + Let's Encrypt 自動証明書取得と低遅延設定（`proxy_buffering off`）
- **クラウド VM / VPS**: ファイアウォール（UFW）とリバースプロキシの組み合わせ

### PC ブラウザでのローカル検証
LAN 内の別 PC から HTTPS 構成前に動作テストを行う場合は、付属のローカルプロキシを使用することで `http://localhost:9001`（セキュアコンテキスト扱い）として検証できます：

```bash
TARGET_HOST=<DOCKER_HOST_IP> npm run proxy
```

---

## 🛠 開発・テストコマンド

```bash
# 依存パッケージのインストール
npm --prefix client install
npm --prefix server install

# 単体テスト・結合テストの実行 (Vitest)
npm test

# フロントエンド & バックエンドのビルド確認
npm run build

# リモート Docker ホストへの自動テスト＆同期デプロイ (.env に DEPLOY_HOST 設定時)
npm run deploy
```

---

## 📚 ドキュメント一覧

- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**: デプロイメント・運用・保守ガイド（Docker Compose / NAS / ロックアウト解除 / VAAPI 診断）
- **[docs/NETWORK.md](docs/NETWORK.md)**: 外部公開 & ネットワーク設定完全ガイド（Cloudflare Tunnel / Caddy / Nginx）
- **[docs/OPTIMIZATION_KNOWLEDGE.md](docs/OPTIMIZATION_KNOWLEDGE.md)**: 描画最適化・ヒステリシス制御・CDP ネイティブタッチ技術仕様書
- **[AGENTS.md](AGENTS.md)**: 開発者・コントリビューター・AI エージェント向け設計ガイド
- **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)**: サードパーティライセンス表記および再配布に関する注意事項

---

## 📄 ライセンス & 免責事項

本プロジェクトのソースコードは **[MIT License](LICENSE)** の下で公開されています。サードパーティ製ライブラリおよびビルド時に取得される外部パッケージのライセンスについては [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) をご確認ください。

- **商標に関する免責事項**: "Tesla" は Tesla, Inc. の登録商標です。"Google Chrome" および "YouTube" は Google LLC の商標です。本プロジェクトは独立したオープンソースプロジェクトであり、Tesla, Inc. および Google LLC とは一切関係ありません（非公式・非提携）。
- **安全運転に関する警告**: 走行中のドライバーによる画面注視やタッチ操作は大変危険であり、各国の道路交通法により禁止されています。走行中の操作・視聴は必ず同乗者のみが行い、ドライバーは常に安全運転に専念してください。本ソフトウェアの使用により生じたいかなる損害・事故についても開発者は一切の責任を負いません。
