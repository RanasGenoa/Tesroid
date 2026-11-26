# 仕様書 09: コンテナ・配布・デプロイ・CI 基盤

## 1. 概要と目的

Linux・各種 NAS OS（TrueNAS / QNAP 等）・Windows Docker Desktop・NVIDIA GPU 搭載機など多様なセルフホスト環境において、ホストの Linux カーネルバージョンへ過度に依存せず、Google Chrome の再配布規約を遵守したまま、ビルド不要・ルーターポート開放不要で安全に導入・公開・継続検証できるインフラ基盤を提供する。

---

## 2. 機能要件（入力・処理・出力・状態遷移）

### 2.1 単一コンテナ基盤 & ホストカーネル非依存原則
- **対象プラットフォーム**: `linux/amd64` (`x86_64`) 専用（推奨メモリ 2 GB 以上、ARM64 / Raspberry Pi 等は非対応を明示）。
- **マルチステージコンテナ構成 & Node.js 22 LTS 統一**:
  - ビルドステージ・ランタイムステージ・CI 実行環境すべてを **Node.js 22 LTS** へ統一する。
  - Ubuntu 24.04 ランタイム上に Node.js 22、マルチ GPU VAAPI ドライバ群（`libva2`, `libva-drm2`, `intel-media-va-driver-non-free`, `i965-va-driver-shaders`, `mesa-va-drivers`, `libdrm-amdgpu1`, `vainfo`）、仮想ディスプレイ/音声/入力/エンコーダ（Xvfb, Openbox, xdotool, wmctrl, PulseAudio, FFmpeg）、日本語・絵文字フォント（Noto CJK / Color Emoji）を集約する。
- **ホストカーネル非依存（`no-systemd` ガードレール）**:
  - 商用 NAS 等の旧世代・カスタム Linux カーネル（例: Linux 5.10 系）では、新しい `systemd` 系パッケージが発行する Linux 6.6+ 固有システムコール（`fchmodat2(..., AT_EMPTY_PATH)` 等）が `ENOENT` を返しビルド・起動不能となるため、`systemd`, `systemd-sysv`, `systemd-standalone-sysusers`, `systemd-standalone-tmpfiles`, `libpam-systemd`, `dbus-user-session`, `udev` を APT Pinning（`Pin-Priority: -1`）で強制ブロックし、D-Bus セッションバス依存は `dbus-x11` で明示解決する。
  - パッケージ導入は `--no-install-recommends` を徹底し、特定の新しい Linux カーネルシステムコールへ依存しないことを維持する。
- **プロセス管理 & 永続データ**:
  - `init: true`（tini）および `TINI_KILL_PROCESS_GROUP=1` によりコンテナ停止時のゾンビプロセス防止とプロセスグループ一括終了を保証する。
  - Chrome 共有メモリ不足を防ぐため `shm_size: 1g` を確保し、永続ボリューム `/data` に設定・ロックアウト状態・ブラウザプロファイル・テレメトリログを格納する。

### 2.2 Google Chrome ライセンス準拠の配布契約
- 公開レジストリ（GHCR 等）へ配布する事前ビルドイメージはビルド引数 `INSTALL_CHROME=false` とし、Google Chrome パッケージを一切同梱しない。
- コンテナ初回起動時、未導入であれば公式パッケージ（`google-chrome-stable_current_amd64.deb`）を TLS 1.2+ で自動取得し、`dpkg-deb` でパッケージ妥当性を検証した上で導入・キャッシュ削除する（ローカルソースビルド時は `INSTALL_CHROME=true` での事前同梱を許容）。

### 2.3 内蔵 Cloudflare Tunnel & トークン秘匿
- バージョン固定（`2026.11.1`）および SHA256 ハッシュ検証済み `cloudflared` をコンテナへ内蔵する。
- 環境変数 `TUNNEL_TOKEN` が設定されている場合のみバックグラウンド起動し、ポート開放・手動 SSL 証明書管理なしでテスラ車載ブラウザ必須の HTTPS/WSS 公開を実現する。
- **秘匿性**: トークンはコマンドライン引数へ渡さず（`/proc/<pid>/cmdline` 露出防止）環境変数経由で `cloudflared` サブシェルへ渡し、起動直後に親環境から `unset TUNNEL_TOKEN` を実行してアプリケーションおよびクラウドブラウザの子プロセスへ継承させない。

### 2.4 エンコーダ指定・環境変数・GPU 検出の責務分離
- **エントリーポイントでの `ENCODER_MODE=nvenc` 正式受理**:
  - 起動スクリプトは `ENCODER_MODE` として `auto | nvenc | vaapi | software` をすべて正規値として受理し、`nvenc` を `auto` へ上書きしない。
- **ユーザー明示入力変数と自動検出の区別**:
  - 起動スクリプト側で無条件に既定値（例: `iHD`）を環境変数 `LIBVA_DRIVER_NAME` へエクスポートしてアプリケーション側の詳細プローブ（NVIDIA → AMD → Intel → Software）を上書きしてしまう二重判定を廃止する。
  - ユーザーが明示指定した場合のみ明示変数として引き継ぎ、未指定または `auto` の場合は環境変数を空（未指定）のまま維持して、アプリケーション本体の検出ロジックへ一元化する。
- **廃止環境変数と整理対象**:
  - 効いていなかったまたは不要な環境変数 **`FPS`、`VIDEO_BITRATE`、`AUDIO_BITRATE`、`DISPLAY_WIDTH`、`DISPLAY_HEIGHT`、`BROWSER_URL`** は仕様から廃止する（解像度はクライアント接続に連動し、仮想 X11 画面は最小 1920×1080 で起動。配信品質・ホーム URL はサーバー永続設定で管理）。
  - システム表示言語用の `LOCALE`（既定 `ja-JP`）を環境変数としてサポートする。
- **ポート体系 & 環境サンプル整備**:
  - コンテナ内部のサーバー待受・内蔵 `cloudflared` 接続先ポートは **`PORT`（既定 `8080`）**、Docker ホスト側へ公開するポートは **`TESROID_PORT`（既定 `9001`）** として責務を明確に分離し、`.env.example` から存在しないデプロイスクリプト向け変数（`DEPLOY_*`）を削除して実態に整備する。

### 2.5 マルチ環境デプロイ・導入支援・ローカル検証
- **Docker Compose 定義（4 系統）**:
  - 標準ローカルビルド版（`/dev/dri` マウント）
  - 事前ビルド GHCR イメージ版（`/dev/dri` マウント）
  - Windows Docker Desktop 版（`/dev/dxg` および `/usr/lib/wsl` マウント、`LIBVA_DRIVER_NAME=d3d12` 指定）
  - NVIDIA GPU (NVENC) 版（`/dev/dri` なし、NVIDIA Container Toolkit 向け `deploy.resources.reservations.devices` および `NVIDIA_VISIBLE_DEVICES=all` / `NVIDIA_DRIVER_CAPABILITIES=video,compute,utility`、`ENCODER_MODE` 指定）
- **ワンショット対話導入スクリプト（`scripts/install.sh`）**: Linux x86_64 チェック、メモリ 2GB 推奨確認、Docker/Compose 導入確認、NVIDIA NVENC / AMD / Intel GPU 検出とグループ権限設定、トークン形式検証、`.env`（権限 `0600`）・`docker-compose.yml` 生成、起動までを自動実行する。
- **ローカル検証プロキシ（`scripts/pc-proxy.mjs`）**: LAN 内別 PC 等から HTTPS 公開前にテストできるよう、`http://127.0.0.1:<ポート>`（WebCodecs セキュアコンテキスト扱い）として HTTP + WebSocket を転送する。

### 2.6 CI/CD & 品質ガードレール
- **CI ワークフロー（Node.js 22）**: `main` / `release/**` 向け push・PR でリント/フォーマット（Biome）、厳格型チェック（tsc）、全単体/結合テスト（Vitest）、プロダクションビルド、ビルド成果物に対する車載 DOM 制約検証（`<video>` ゼロ・`<canvas>` 存在・HUD 中央揃え）を実行する。権限は `contents: read` のみ（シークレット不使用、`pull_request_target` 不使用）。
- **品質ガードレールテスト**: プロトコル対称性、禁止 Chrome フラグ、PulseAudio/WebAuthn/パスワードバブル抑止、完全タッチオンリー規約、機密情報（プライベート IP・鍵・ローカルパス）の混入ゼロを自動検査する。
- **コンテナ公開ワークフロー**: `main` への push および `v*` タグ時に Chrome 非同梱イメージ（`INSTALL_CHROME=false`）をビルド・公開し、`latest` タグはプレリリースを含まない安定版 `v*` タグ時のみ付与する。
- **AI PR レビュー**: 読み取り専用トークン分離で差分（3MB 上限）を解析し、作業ツリーを汚さずレビューコメントを更新する（Fork PR 時は `pull_request_target` で安全性分離）。

---

## 3. 非機能要件・制約条件

- **サードパーティ再配布禁止**: Google Chrome 同梱イメージのパブリックレジストリ公開を禁止する。
- **機密非コミット原則**: 平文パスワード・API トークン・SSH 鍵・プライベート固定 IP・開発者ローカルパスをリポジトリへコミットしない。
- **環境変数（整理後主要一覧）**: `PORT` (既定 `8080`), `TESROID_PORT` (既定 `9001`), `DATA_DIR` (`/data`), `DISPLAY` (`:99`), `LOCALE` (`ja-JP`), `TZ` (`Asia/Tokyo`), `ENCODER_MODE` (`auto` / `nvenc` / `vaapi` / `software`), `VAAPI_DEVICE`, `LIBVA_DRIVER_NAME`, `TUNNEL_TOKEN`, `TELEMETRY_LOG_DIR`, `BUFFER_HOLD_EXPIRE_MINUTES` (`10`)。

---

## 4. 判明しているエッジケースとエラー時の振る舞い

1. **初回 Chrome ダウンロード失敗・破損アーカイブ**: `dpkg-deb` 検証でエラー検知し一時ディレクトリをクリーンアップの上で起動失敗終了する（不完全導入のまま稼働させない）。
2. **非対応 OS / ARM64 環境での導入スクリプト実行**: 起動前チェックで理由を明示して即時終了する。
3. **Windows WSL2 で `/dev/dri` 不在時の起動**: `/dev/dri` マウントエラーを避け専用 Compose（`/dev/dxg`）を使用し、非対応時は自動的にソフトウェアエンコードへ降格する。
4. **`cloudflared` の予期せぬ終了**: 終了コード（130/143 以外）をエラーログに出力してトークン確認を促す（メインサーバー自体はローカルアクセス用に継続稼働）。
5. **コンテナ内での `/etc/libva.conf` 干渉**: `libva` が環境変数より設定ファイルを優先するため、設定ファイルはコメントのみに保ち自動検出・明示環境変数の適用を阻害しない。

---

## 5. 受け入れ条件（テスト観点）

- **AC-01 (カーネル非依存パッケージ制約 & Node.js 22 統一)**:
  - **Given** コンテナビルド定義および CI ワークフロー定義
  - **When** パッケージ依存関係・APT ピン設定・Node.js バージョンを検査する
  - **Then** `systemd` 系・`dbus-user-session`・`udev` がすべてブロックされて `dbus-x11` と `--no-install-recommends` が維持され、コンテナと CI の双方が Node.js 22 に統一されている。
- **AC-02 (Chrome 非同梱公開 & 初回取得)**:
  - **Given** `INSTALL_CHROME=false` でビルドされたイメージ
  - **When** イメージ内パッケージ検査および初回起動を行う
  - **Then** 公開イメージ自体に Chrome は含まれず、初回起動時のみ公式パッケージの検証済み導入と一時ファイル清掃が行われる。
- **AC-03 (`ENCODER_MODE=nvenc` 受理・環境変数整理・GPU 検出分離)**:
  - **Given** `ENCODER_MODE=nvenc` または未設定の `LIBVA_DRIVER_NAME` で起動するコンテナ
  - **When** 起動スクリプトを実行する
  - **Then** `nvenc` が `auto` へ書き換えられず維持され、未指定のドライバ環境変数へ勝手な既定値が注入されずアプリ側の NVIDIA→AMD→Intel 自動検出が正常に動作し、廃止済み環境変数・未実装スクリプト変数は存在しない。
- **AC-04 (`TUNNEL_TOKEN` 秘匿性 & CI 品質ゲート)**:
  - **Given** `TUNNEL_TOKEN` を設定して起動したコンテナおよびリポジトリ変更内容
  - **When** プロセス環境検査および CI ゲートを実行する
  - **Then** コマンドライン引数および Node.js / Chrome のプロセス環境にトークンが含まれず、CI 全ゲートと車載 DOM ガードが PASS する。
- **AC-05 (リリース公開タグ規則)**:
  - **Given** コンテナ公開ワークフロー定義
  - **When** プレリリース（`v*-rc.1` 等）と安定版（`vX.Y.Z`）タグの付与条件を評価する
  - **Then** プレリリースタグでは `latest` が更新されず、安定版タグ時のみ `latest` が付与され、常に `INSTALL_CHROME=false` でビルドされる。

---

## 6. 要確認事項

本仕様書に関する未解決の確認事項はありません（すべて方針確定済み）。
