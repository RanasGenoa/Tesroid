# AGENTS.md — Tesroid 開発・AI エージェント規約

> 本ファイルは AI コーディングエージェント（`.cursorrules` / `CLAUDE.md` / Antigravity 等）共通の絶対遵守ルールブックである。
> 要件・設計の唯一の正典は [`docs/specs/`](docs/specs/) および [`docs/architecture.md`](docs/architecture.md) とする。

---

## 1. 絶対遵守事項（仕様駆動・根本解決・同時削除）

すべての機能追加・仕様変更・不具合修正において、以下 4 点を例外なく絶対遵守する：

- **機能追加・仕様変更の仕様書先行更新**: 機能追加・仕様変更は必ず [`docs/specs/`](docs/specs/)（必要に応じ [`docs/architecture.md`](docs/architecture.md)）の更新案を先に提示し、合意を得てから実装する。
- **不具合修正の原因分類と根本解決**: 不具合修正は実装前に「仕様違反（実装ミス）」か「仕様漏れ（エッジケース追加）」かを判定し、ワークアラウンドではなく根本原因を直す（「仕様漏れ」に該当する場合は、先に仕様書の更新案を提示し合意を得てから実装する）。
- **緊急修正も仕様先行を迂回しない**: 本番緊急対応でも「仕様漏れの判定 → 仕様書更新案の提示」を省略できない。実装を先に先行させる場合は、同一 PR 内に対象仕様書の「要確認事項」へ暫定記録を追加することを必須とし、仕様書に触れない hotfix のマージを禁止する。
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
- **AC 追跡可能性**: 新規・変更されたテストの最上位 `describe` 名には対応仕様書の AC 番号を含める（例: `describe("仕様 03 AC-04 ...")`）。PR 本文には「AC ↔ テストファイル」対応表を必須とし、対応 AC のない変更はスコープクリープとして §6.4 のレビューゲートで FAIL とする。
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

---

## 6. DDD × SDD 運用規約（フェーズワークフロー・用語集・コンテキスト境界）

> 本節は §1〜§5 の方針を AI エージェントで運用するための手続定義であり、要件・設計の正典（[`docs/specs/`](docs/specs/) と [`docs/architecture.md`](docs/architecture.md)）および §1〜§5 の絶対規則に優先するものではない。正典と矛盾する場合は常に正典が勝つ。

### 6.1 フェーズ別ワークフローとスキル割り当て（1フェーズ1オーナー）

| Phase | 活動・成果物 | 主担当（オーナー） | 従属ゲート |
| :--- | :--- | :--- | :--- |
| 1. 要件・境界の精査 | `docs/domain/<context>.md` 作成・更新 | DDD モデリング（`ddd-modeling`。逆質問は `grill-me` 併用可） | — |
| 2. 技術・モデル検証 | 使い捨て実験の結論（コードは本流に接続しない） | `spike` | — |
| 3. 仕様・実装計画 | `docs/specs/` 先行更新（§1 のフロー）＋ 実装計画 `docs/plans/<NNN>-<topic>.md` | `writing-plans` | 仕様合意が計画より常に先行 |
| 4. 実装・2段階レビュー | コード＋テスト（TDD: §6.4） | `subagent-driven-development` ＋ `test-driven-development` | `ddd-architecture-review` と `tesroid-architecture-guard` の**両方**が必須 |
| 5. 最終仕上げ・PR | リンククリーンな diff・PR・CI | `requesting-code-review` / `simplify-code` | §5 の品質ゲート＋PR 運用 |

### 6.2 ユビキタス言語用語集

新規用語は DDD モデリング手続での合意後に本表へ追加する（コード実在識別子を検証して記載）。**禁止別名**はコード・コメント・ドキュメント・PR 本文のいずれにも使用しない。

| 業務用語 | コード上の英語名（正典） | 定義 | 禁止別名 |
| :--- | :--- | :--- | :--- |
| ストリーム世代 ID | `streamEpoch` | エンコーダ再起動・電源復帰・配信リセット・寸法変更のたびに単調増加する `UInt32BE` の世代識別子 | `generationId`, `epochId` |
| ストリーミング状態 | `StreamingState`（`STANDBY` / `INTERACTIVE` / `LIVE` / `CATCHUP` / `BUFFER_HOLD`） | 排他的判別ユニオン。遷移契約は [`architecture.md` §3.5](docs/architecture.md) | `isLive` 等の bool 群, `buffering`（CATCHUP の別称として） |
| セッションロール | `PRIMARY` / `ACTING_PRIMARY` / `SECONDARY_STREAMING` / `SECONDARY_STANDBY` | 配信権威の排他と後席待機の役割（[仕様書 02](docs/specs/02-session-multidisplay.md)） | `main`, `sub`, `master` |
| 配信リセット | stream reset（`POST /api/stream/reset`） | V/A 両エンコーダとクライアント両デコーダをリセットする単一経路 | `restart`（ブラウザ再起動は browser restart と呼ぶ） |
| 生成一時停止 | `BUFFER_HOLD` | 未消費占有率 85% 以上で発動する生成停止状態（降格解除は 10% 排水） | `pause`, `stall` |

### 6.3 境界づけられたコンテキスト一覧と責務

各コンテキストの責務・配置・内部構造の正典は [`docs/architecture.md`](docs/architecture.md) §1.2〜§2.3 とする（本节は重複せず、コンテキストと公開契約の対応のみ列挙する）。コンテキスト内部モデルの詳細は `docs/domain/<context>.md` に置く。

| コンテキスト | ディレクトリ | 他コンテキストへ見える公開契約のみ |
| :--- | :--- | :--- |
| 共有正典 | `shared/src/` | protocol / settings / geometry / state の純型・純関数（ランタイム依存ゼロ） |
| 認証 | `server/src/domains/auth` | 認証 REST、トークン検証契約、ロックアウト状態 |
| 設定 | `server/src/domains/settings` | `SettingsRepository` Port |
| セッション | `server/src/domains/session` | `PowerSessionPort`、ロール状態の制御 JSON DTO |
| 電源ライフサイクル | `server/src/domains/power` | `/api/power/*`、`PowerBrowserPort` 等消費側契約、電源状態ブロードキャスト |
| 仮想ブラウザ | `server/src/domains/browser` | `PowerBrowserPort`、CDP 入力 Port、単一ページスクリプト注入 |
| エンコーディング | `server/src/domains/encoder` | `PowerEncoderPort`、AVCC / OggOpus 媒体フレーム出力 |
| ストリーミング配信 | `server/src/domains/streaming` | WS 多重化フレーム仕様、`PowerStreamingPort`、バッファ状態セレクタ |
| 観測性 | `server/src/domains/observability` | `/api/metrics/*`・`/api/telemetry/*` 契約、純粋集計型 |
| クライアント再生エンジン | `client/src/media`, `client/src/input` | 内部完結。UI へは `client/state`（AppStore）制御面経由のみ |
| クライアント UI | `client/src/ui`, `client/src/state` | 内部完結。設定はサーバー DTO のみで永続化しない |

### 6.4 DDD アーキテクチャ制約（§3・§4 の補足。本文の再掲はしない）

- **層間依存**: 新規 import は [`architecture.md` §2.1](docs/architecture.md) 依存マトリクスで照合可能なもののみ許可する。
- **集約操作**: 状態変更は集約ルートおよび単一遷移関数へのイベント投入経由のみ（§3.1 より。bool 状態フラグの新設はレビューで即 FAIL）。
- **テスト先行**: 新しい外部観測可能挙動は、仕様 AC に基づく失敗テストを先に書いてから実装する。状態遷移を伴う設計は §3.1 の Stub-First 順序が優先する。
- **PR 前レビューゲート 2 種必須**: `ddd-architecture-review`（用語集準拠・貧血モデル・集約境界・依存方向・スコープクリープ）と `tesroid-architecture-guard`（車載制約・品質ゲート）の両方を PASS させてから PR を作成する。

### 6.5 サブエージェント委譲ルール（`delegate_task` 運用）

サブエージェントへ渡すのは (1) 対象コンテキストのディレクトリ、(2) 他コンテキストとの公開契約（`shared/` の型・Port インターフェースと [`architecture.md` §2.3](docs/architecture.md) の契約表）、(3) 対応仕様書の AC セクションのみとする。**他コンテキストの内部実装を読み込ませず**、その報告も要求しない。委譲成果は §6.4 のレビューゲート通過後にのみ本流へ統合する。

### 6.6 セッション管理ルール

フェーズの切れ目 — 設計完了（`docs/domain/<context>.md` への書き出し完了）および計画完了（`docs/plans/<NNN>-<topic>.md` への書き出し完了）— では、成果物を必ずファイルへ永理化してから、セッション分割（`/new`）を推奨する。新しいセッションでは、書き出された成果物と本規約のみを参照して再開できる状態を保つ（会話文脈に依存した設計判断を残さない）。
