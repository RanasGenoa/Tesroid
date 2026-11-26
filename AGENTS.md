# AGENTS.md — Tesroid 開発・AI エージェント規約

> 本ファイルは AI コーディングエージェント（`.cursorrules` / `CLAUDE.md` / Antigravity 等）共通の絶対遵守ルールブックである。
> 要件・設計の唯一の正典は [`docs/specs/`](docs/specs/) および [`docs/architecture.md`](docs/architecture.md) とする。

---

## 1. 絶対遵守事項（仕様駆動・根本解決・同時削除）

すべての機能追加・仕様変更・不具合修正において、以下 3 点を例外なく絶対遵守する：

- **機能追加・仕様変更の仕様書先行更新**: 機能追加・仕様変更は必ず [`docs/specs/`](docs/specs/)（必要に応じ [`docs/architecture.md`](docs/architecture.md)）の更新案を先に提示し、合意を得てから実装する。
- **不具合修正の原因分類と根本解決**: 不具合修正は実装前に「仕様違反（実装ミス）」か「仕様漏れ（エッジケース追加）」かを判定し、ワークアラウンドではなく根本原因を直す（「仕様漏れ」に該当する場合は、先に仕様書の更新案を提示し合意を得てから実装する）。
- **仕様変更に伴う旧資産の同時削除**: 仕様変更により不要になった旧コード・旧テスト・修正経緯コメントは必ず同時に削除する。

---

## 2. 実装前ワークフロー（設計確認の義務）

コードを追加・変更する前に、**必ず以下の手順をこの順序で実施すること**：

1. **正典の参照**: 対象機能に関係する [`docs/specs/*.md`](docs/specs/)（要件・エッジケース・受け入れ条件 AC）と [`docs/architecture.md`](docs/architecture.md)（レイヤー・モジュール境界・依存マトリクス）を読む。
2. **設計方針の事前確認**: 実装に着手する前に、以下 4 点を頭の中または作業計画で明示的に確定する。
   - どのレイヤー・ドメインのどのモジュールに置くか
   - 越えるべき Port 境界と依存方向（逆方向依存やドメイン跨ぎ直参照がないか）
   - `shared` へ置くべき単一正典（型・定数・計算・検証）と重複しないか、また状態遷移を伴う場合は既存の単一遷移関数（電源 FSM / ストリーミング状態 FSM 等）へイベントとして集約できているか（**周辺実装より先に状態・イベント・副作用・遷移関数のスタブを切る**）
   - 検証すべき対象 AC はどれか
3. **仕様との矛盾・未定義発見時の停止原則**: 仕様と矛盾する挙動や未定義ケースを発見した場合、コード側の場当たり的なワークアラウンドで回避してはならない。先に [`docs/specs/`](docs/specs/) または [`docs/architecture.md`](docs/architecture.md) の更新案をユーザーへ提示し、合意を得てから実装する。
4. **最小実装とゲート検証**: 設計に沿って最小限かつ自己完結したコード・テストを実装し、品質ゲートをすべて通す。

---

## 3. 厳格なコーディング規約（継ぎ足し・肥大化防止）

### 3.1 構造的解決の原則
- **ワークアラウンド・症状パッチの厳禁**: 不具合に対して「特定 ms だけ弾く特別ゲート」「後付けのストラグラーフラグ」「特定呼び出し箇所だけの迂回分岐」を継ぎ足してはならない。原因を上位の設計機構（`streamEpoch` による世代隔離、単一 `power` 状態機械、単一遷移関数によるストリーミング状態機械、単一音声マスタークロック、`LIVE`/`CATCHUP` キュー分離、Port 境界）で構造的に解決する。
- **ストリーミング状態のカプセル化と単一遷移関数集約（Stub-First & No Boolean Soup）**:
  - `STANDBY` / `INTERACTIVE` / `LIVE` / `CATCHUP` / `BUFFER_HOLD` の状態を複数の独立 boolean フラグ（`isCatchup`, `isStandby`, `isInteractive`, `isHolding` 等）で表現・分散保持してはならない。必ず不正な組み合わせを表現不能にする排他的判別ユニオン（`StreamingState`）でカプセル化する。
  - 状態遷移は **1 つの純粋遷移関数** `transitionStreamingState(state, event) => { nextState, effects }`（`assertNever` による完全網羅チェック付き）に集約し、WS ハンドラ・タイマー・入力注入・UI・エンコーダ連携側へ遷移条件や複合 `if` 分岐を散在させてはならない。
  - 状態遷移を伴う機能・変更に着手する際は、**周辺実装を書く前に必ず「状態型・イベント型・副作用型・単一遷移関数スタブ」と遷移表を先に切り**、テーブル駆動の純粋単体テストで遷移不変条件を固めてから副作用実行シェルを接続する。
  - 状態依存の判定（キュー選択、入力許可、HUD 表示等）は `shared/src/state/` が提供する純粋セレクタまたは `assertNever` 付き `switch (state.kind)` に限定する。
- **単一情報源（SSOT）**: プロトコル定数、設定スキーマ、既定値、許容境界、品質 3 択/プリセット定義、寸法アライメント式は [`shared/`](shared/) に唯一定義する。`server/` や `client/` に同等の定数・計算式を二重定義してはならない。
- **依存方向と疎結合の厳守**: [`docs/architecture.md`](docs/architecture.md) §2 の依存マトリクスを破らない。ドメイン間の連携は必ず `app/` で配線された狭い Port インターフェース経由とし、グローバル可変シングルトンを作らない。
- **TypeScript 規律**: `strict: true` を維持する。`any`・`@ts-ignore`・`@ts-expect-error`・安全でない型アサーションを安易に使わない。純粋計算ロジックと I/O（fs・child_process・DOM・WebSocket）を分離し、1 関数・1 ファイルが肥大化する前に責務単位へ分割する。

### 3.2 コメント規約（コメント肥大化・陳腐化の禁止）
- **「What」は書かない**: コードやシンボル名から自明な処理内容の説明コメントは書かない。
- **書いてよいのは「Why（不変条件）」のみ**: ハードウェア制約、車載ブラウザ仕様、カーネル互換性、非自明なアルゴリズム上の理由に限り、1〜2 行で簡潔に記述する。
- **絶対禁止コメント**:
  - 修正経緯・履歴コメント（例: `以前は〜だった`, `Issue #123 修正`, `PR #45 対応`, `Phase 2 で変更`, `互換性維持のため暫定`）
  - 取り消したコードのコメントアウト残置
  - 所有者・対処方針のない `TODO` / `FIXME` の放置
  - 変更経緯や背景は Git コミットメッセージおよび PR 本文に記録する。

### 3.3 テスト規約（モック乱用・内部結合の禁止）
- **振る舞いベース・最小限**: テストは [`docs/specs/`](docs/specs/) 各仕様書の「セクション 5: 受け入れ条件（AC）」に基づき、外部から観測可能な振る舞い（入力に対する出力・状態遷移・プロトコル/HTTP 応答）のみを検証する。
- **絶対禁止テスト**:
  - **内部実装のモック乱用**: 同一プロセス内のドメインモジュールやヘルパー関数を `vi.mock` 等で差し替えること（差し替えを許すのは外部 OS/I/O 境界の Port Fake と `Clock` のみ）。
  - **内部実装への結合**: private 状態の確認や、`toHaveBeenCalledTimes(n)`・呼び出し順序などの手順テスト。
  - **過剰・重複テスト**: TypeScript の型で既に保証される自明なテスト、同じ仕様を複数レイヤーで重複検証するテスト、エッジケースの無意味な水増し。

---

## 4. 絶対厳禁事項（仕様由来のアーキテクチャ不変条件）

1. **`<video>` タグの完全禁止（[仕様書 04](docs/specs/04-client-playback-avsync.md)）**: クライアントのソース・ビルド成果物に `<video>` 要素を記述・動的生成してはならない。映像描画は常に `<canvas>`（`{ alpha: false, desynchronized: true }`）+ WebCodecs のみとし、デコード済みフレームは `close()` で 100% 解放する。
2. **完全タッチオンリー制約（[仕様書 01](docs/specs/01-auth-security.md), [07](docs/specs/07-ui-hud-settings.md)）**: `client/` に物理キーボード前提 UI（`Escape` キー閉じ、ショートカット、`keydown` 依存）やマウス前提 UI（`hover` 専用露出、右クリック、ポインタドラッグ）、およびネイティブ `window.prompt()` / `window.confirm()` を実装してはならない。文字入力は常に HUD 仮想キーボードの編集可能 `<input>` 経由の CDP 注入のみとする。
3. **車載 `localStorage` 設定保存禁止（[仕様書 01](docs/specs/01-auth-security.md), [07](docs/specs/07-ui-hud-settings.md)）**: 設定・拡大率・バッファ深度・テレメトリ有無・お気に入り等はすべてサーバー保存に一元化する。ブラウザ `sessionStorage` に保持してよいのはタブ内再接続用 `token` と `role` のみとする。
4. **Xvfb Chrome コンポジタ保護（[仕様書 06](docs/specs/06-browser-input-cdp.md)）**: Chrome 起動引数に `--enable-gpu-rasterization`・`--enable-zero-copy`・`--disable-gpu-vsync` を絶対に付与しない。また単一注入元による WebAuthn/パスワード保存/翻訳のネイティブバブル抑止を外さない。
5. **タッチ入力方式（[仕様書 06](docs/specs/06-browser-input-cdp.md)）**: 常設タッチ入力をマウスエミュレーションや X11 フォールバック（`xdotool` 等）へ戻してはならない。入力注入は CDP（`Input.dispatchTouchEvent` 等）専用とし、CDP 未接続時の入力は安全に破棄する。
6. **GPU・ドライバ環境変数の境界（[仕様書 05](docs/specs/05-encoder-gpu.md), [09](docs/specs/09-deploy-infra.md)）**: `/etc/libva.conf` に特定ドライバ名を直書きしない。起動スクリプトで未指定 `LIBVA_DRIVER_NAME` へ勝手な既定値を注入しない。`GALLIUM_DRIVER=d3d12` は FFmpeg / `vainfo` サブプロセスのみに限定し Chrome へ絶対付与しない。
7. **コンテナ基盤・配布規約・秘匿性（[仕様書 09](docs/specs/09-deploy-infra.md)）**: `Dockerfile` の `no-systemd` APT Pinning（`Pin-Priority: -1`）・`dbus-x11`・`--no-install-recommends` を削除してはならない。Google Chrome 同梱イメージをパブリックレジストリへ公開（`INSTALL_CHROME=false` 違反）してはならない。`TUNNEL_TOKEN` をコマンドライン引数へ渡したり子プロセス環境へ残存させてはならない。
8. **電源・配信・セッション不変条件（[仕様書 02](docs/specs/02-session-multidisplay.md), [03](docs/specs/03-streaming-transport.md), [10](docs/specs/10-power-lifecycle.md)）**:
   - `autoSleepTimer` と `holdExpireTimer` を同時稼働させない（`autoSleepMinutes = 0` でも `BUFFER_HOLD` 中のプライマリ切断時は `holdExpireTimer` を再武装する）。
   - `ACTIVE` 復帰時は必ず映像・音声双方のエンコーダ稼働を保証する。
   - LIVE 配信時のソケット輻輳で `CATCHUP` モードへ遷移させない。
   - セカンダリ回線輻輳をプライマリおよびエンコーダへ波及させず、通常セカンダリへ音声パケットを送らない。
   - `STANDBY` / `INTERACTIVE` / `LIVE` / `CATCHUP` / `BUFFER_HOLD` のストリーミング状態を独立 boolean フラグ群で表現したり遷移条件を複数箇所へ散在させたりしない（必ず単一純粋遷移関数と純粋セレクタへ集約する）。
9. **機密情報・環境固有情報の非コミット（[仕様書 01](docs/specs/01-auth-security.md), [09](docs/specs/09-deploy-infra.md)）**: 平文 PIN・トークン・API キー・SSH 鍵・プライベート固定 IP・ローカル絶対パスをリポジトリやログへ出力・コミットしない。

---

## 5. Git・ブランチ・品質ゲート運用

- **保護ブランチ保護**: `main` および `release/*` への直接コミット・直接プッシュを厳禁とする。作業は必ずトピックブランチ（`feat/...`, `fix/...`, `docs/...`, `refactor/...`, `chore/...`）で行い、PR 経由で統合する。
- **リリースタグ運用**: リリースタグ `v<MAJOR>.<MINOR>.<PATCH>`（SemVer 2.0.0）はユーザーの明示指示があるときのみ付与し、付与前にすべての `package.json` / `package-lock.json` のバージョンを一致させる。
- **コミット・PR 前必須ゲート**: パッケージ基盤整備（Phase 0）以降、すべてのコード変更はコミットおよび PR 作成前に `npm run check`（Biome + `tsc --noEmit`）、`npm test`、`npm run build` の全 PASS を必須とする。
