# Tesroid - Developer & AI Agent Guide (AGENTS.md)

本ドキュメントは、Tesroid の開発・保守・機能拡張を行う **開発者および AI コーディングエージェント** 向けのアーキテクチャ設計・開発規約ガイドラインです。

---

## 1. プロジェクト概要 & アーキテクチャ

Tesroid は、単一 Docker コンテナ内で稼働する **VAAPI ハードウェア支援 Google Chrome** の画面と音声を、**テスラ車載ブラウザへ WebCodecs (`<canvas>`) + Web Audio API + 単一多重化 WebSocket 経由で超低遅延ストリーミング・タッチ操作するシステム** です。

```text
[ Tesla Browser (Client) ]
        │  HTTPS / WSS (Port 9001 / 443)
        │  (WebCodecs VideoDecoder -> <canvas> ゼロコピー描画 + Web Audio API)
        ▼
[ Docker Host (Linux / VPS / NAS) ]
  └── [ Container: tesroid-server (Ubuntu 22.04 / Single Container) ]
        ├── GPU Access    : /dev/dri/card0, /dev/dri/renderD128 (VAAPI)
        ├── Xvfb & Openbox: 仮想ディスプレイ (:99, デフォルト 1280x720)
        ├── PulseAudio    : 仮想シンク (unix:/tmp/pulse-socket, virtual_sink)
        ├── Google Chrome : ハードウェアアクセラレーション (VAAPI VP9/H.264デコード)
        ├── FFmpeg        : VAAPI h264_vaapi (ゼロ遅延ハードウェアエンコード) + libopus
        └── Node.js Fastify: WebSocketストリーミング + CDP/xdotool入力注入 + 電源管理
```

- **クライアント (`client/`)**: Vanilla TypeScript + Vite。`<video>` タグを使わず、WebCodecs の `VideoDecoder` で H.264 を直接 `<canvas>` に描画（テスラのDレンジ走行時動画停止ガードを回避）。
- **サーバー (`server/`)**: Node.js (Fastify) + WebSocket + FFmpeg VAAPI + X11/CDP。

---

## 2. ビルド・テスト・デプロイ手順

### ローカル開発 & テスト
コードを変更した際は、必ず単体テストと TypeScript ビルドが通ることを確認してください：

```bash
# 全テストスイート実行 (client/test & server/test)
npm test

# クライアント & サーバーのプロダクションビルド検証
npm run build
```

### コンテナの起動・確認
```bash
# Docker Compose によるローカルイメージビルド & 起動
npm run docker:up
# または
docker compose up -d --build

# ログ確認
npm run docker:logs
```

### リモートホストへの自動同期デプロイ (`scripts/deploy.sh`)
`.env`（Git管理外）に `DEPLOY_HOST` 等を設定している場合、以下のコマンドでローカルテスト ➔ `rsync` 差分同期 ➔ リモートビルド・再起動 ➔ ヘルスチェックを一括実行できます：

```bash
npm run deploy
# テストをスキップする場合: npm run deploy -- --skip-test
# デプロイ後にログを追跡する場合: npm run deploy -- --logs
```

---

## 3. ディレクトリ構造 & 主要モジュール

```text
Tesroid/
├── AGENTS.md                   # 本ドキュメント (開発・設計ガイドライン)
├── README.md                   # プロジェクト概要・クイックスタート
├── LICENSE                     # MIT ライセンス
├── THIRD_PARTY_NOTICES.md      # サードパーティライセンス表記・再配布注意事項
├── Dockerfile                  # マルチステージビルド (Ubuntu 22.04 + Chrome + VAAPI)
├── docker-compose.yml          # 標準 Docker Compose 定義
├── docs/
│   ├── DEPLOYMENT.md           # デプロイメント・運用ガイド
│   ├── NETWORK.md              # リバースプロキシ・HTTPS・Cloudflare Tunnel 設定ガイド
│   └── OPTIMIZATION_KNOWLEDGE.md # 描画・低遅延ストリーミング・CDPタッチ技術仕様
├── client/                     # フロントエンド (TypeScript + Vite)
│   ├── src/
│   │   ├── core/               # WebCodecs デコーダ、キャンバス描画、A/V同期、ジッターバッファ
│   │   ├── input/              # タッチ座標変換、エッジガード
│   │   ├── transport/          # バイナリプロトコル、WebSocket 自動再接続クライアント
│   │   └── views/              # フルスクリーンPIN入力、ストリーミングHUD、設定モーダル
│   └── test/                   # クライアント Vitest テスト
└── server/                     # バックエンド (Node.js Fastify + FFmpeg VAAPI)
    ├── extension/              # 車載表示ズーム & Webフルスクリーン最適化 Chrome 拡張
    ├── src/
    │   ├── browser/manager.ts  # Xvfb, Openbox, Chrome, PulseAudio プロセス & 省電力管理
    │   ├── encoder/            # FFmpeg VAAPI エンコーダ & 再接続キャッチアップバッファ
    │   ├── input/xdotool.ts    # CDP ネイティブタッチ (`CdpTouchBridge`) & xdotool フォールバック
    │   ├── ws/                 # WebSocket ハンドラー、バイナリ多重化 (0x01: VIDEO, 0x02: AUDIO)
    │   └── routes/             # REST API (setup, settings, browser, health, metrics)
    └── test/                   # サーバー Vitest テスト
```

---

## 4. 開発・修正時の重要ナレッジ

- **テスラ車載ブラウザの `<video>` 制約**:
  クライアント側で `<video>` 要素は絶対に使用しないでください（Dレンジ走行時に OS 側で強制停止されるため）。映像描画は常に `client/src/core/canvas-renderer.ts` の `<canvas>` + WebCodecs API を経由してください。
- **省電力・一時停止 (`SIGSTOP` / `SIGCONT`)**:
  WebSocket クライアント切断後、一定時間経過で Chrome プロセスツリーを `SIGSTOP` して CPU/GPU 使用率を 0% に解放し、再接続・認証時に `SIGCONT` で即座に復帰します。
- **セキュリティロックアウト**:
  PIN 入力を 10 回連続で失敗するとサーバープロセスが `exit 1` で緊急停止し、`lockout.json` に記録されます。
- **詳細な最適化仕様の参照**:
  コンテナ内 Chrome 安定化、ヒステリシス・バックプレッシャー、PulseAudio UNIX ソケット構成、CDP ネイティブタッチの詳細は [docs/OPTIMIZATION_KNOWLEDGE.md](docs/OPTIMIZATION_KNOWLEDGE.md) に網羅されています。コア処理を変更する前に必ず参照してください。

---

## 5. 開発時のアンチパターン（厳禁事項）

1. **Xvfb 環境で `--enable-gpu-rasterization` や `--enable-zero-copy` を追加しない**:
   Mesa llvmpipe と VAAPI デコーダが競合し、コンポジタがデッドロックして画面下部が黒くフリーズします。2D DOM は常に Chrome の高速 CPU ラスター（Skia SIMD）で描画してください。
2. **WebSocket バックプレッシャーで単一閾値のフレームドロップを行わない**:
   IDR キーフレーム送信時に一時的にソケットバッファが跳ね上がるため、必ず高低水位ヒステリシス（High: 768KB, Low: 128KB）を維持してください。
3. **タッチ入力を `mousedown 1` マウスエミュレーションに戻さない**:
   微小移動で画像ドラッグやテキスト選択が誤爆します。必ず `server/src/input/xdotool.ts` の `CdpTouchBridge`（CDP `Input.dispatchTouchEvent`）を優先使用してください。
4. **ビルド済みコンテナイメージ（Google Chrome 同梱）をパブリックレジストリへ公開しない**:
   `Dockerfile` はビルド時に Google Chrome 公式パッケージを取得します。再配布規約を遵守し、ソースコードおよび `Dockerfile` のみを提供してください。
