# 計画 001: V0.8.0 完全パリティ復元（設計・実装計画）

> 対象タグ: `v0.8.0`（2026-11-24、旧アーキテクチャ最終断面）
> 基準 HEAD: `9038205`（restart/v2 DDD 構造）
> 関連仕様: 04 / 05 / 06 / 07 を本計画で先行改訂。02 / 03 は既存要求（セカンダリ同期参加 ≥300ms、RTT 最小値履歴窓 8）で十分であり変更しない（該当実装は ★ 扱い）。

---

## 1. 目的と基本原則

V0.8.0 はコンテナ内ブラウザの安定起動、GPU/CPU どちらでも成立する配信、動的解像度ウィンドウフィット、客户端の音切れ防止と 60FPS 連続描画、および視覚的に完成度の高い UI を実現していた。restart/v2 書き直しに伴い、これらの**観測可能な振る舞いの一部**が失われたり現行仕様が自ら要求しながら未実装の項目が発生した。

本計画の原則（パリティ原則）:

1. **観測可能な挙動の基準 = V0.8.0**: 用户が体感する動作（起動耐性、音切れ防止、描画連続性、同期の滑らかさ、UI の見た目・操作感）は V0.8.0 を正典として復元する。
2. **アーキテクチャ = restart/v2 を保持**: `StreamingState` 単一遷移関数、`streamEpoch` 世代隔離、Port 境界、`shared/` 単一正典、排他ロール、ガードレールは退化させない。V0.8.0 の構造（boolean スープ、PTS のみ世代判定、シングルトン I/O）には戻さない。
3. **現行仕様が既に要求している未実装項は「仕様違反（実装ミス）」として即修復する**（§3 の ★ 印）。
4. **意図的な現行設計への変更（PR #102・#104・#114/#116 由来的なもの）は保持し、V0.8.0 回帰としない**（§4 決定台帳）。

---

## 2. 調査方法

タグ `v0.8.0` の全 158 ファイルを現行ツリー（197 ファイル）と比較するため、5 系統（ブラウザ/コンテナ、エンコーダ/GPU、クライアント再生、WS 配信/観測性、UI/UX）の差分調査を実施し、主要な主張は現行コードの grep/read で機械的に裏取り済みである。以下の特許的構造差を前提とする:

| 領域 | V0.8.0 | 現行 |
| :--- | :--- | :--- |
| 配信状態 | `mode` 文字列 + `isStandby`/`isInteractive`/`isFlowPaused` 等 boolean 群 | 排他的判別ユニオン + 単一純粋遷移関数（維持） |
| 世代管理 | PTS と stale キーフレーム(2s)→エンコーダ restart の組合せ | `streamEpoch` UInt32 単調増加（維持） |
| 入力 | CDP 優先 + xdotool フォールバック | CDP 専用（維持・AGENTS §4-5） |
| 先行蓄積 | クライアント圧縮パケット prdecode バッファ（既定 10s〜30s）+ サーバー ring | サーバー ring + CATCHUP フロー制御 + クライアント `CatchupVideoQueue`（統合して復元） |
| A/V 同期 | PLL マイクロシフト（±0.75ms/frame）| 閾値 WAIT/DROP のみ → **PLL を単一同期モデルへ統合して復元** |

---

## 3. ギャップマトリクスと处置

凡例: **R** = V0.8.0 振る舞いを復元 / **K** = 現行設計を保持 / **★** = 現行仕様が要求しながら未実装（実装のみ修復）

### 3.1 ブラウザ・コンテナ（仕様 06 / 09）

| # | 項目 | V0.8.0 根拠 | 現行状態 | 处置 |
| :--| :--- | :--- | :--- | :--- |
| B-1 | URL/タイトル同期のイベント駆動化（`Page.frameNavigated` / `navigatedWithinDocument` +400ms title 再取得 / `loadEventFired` / `domContentLoaded` で即時、3 秒ポーリングはフォールバック維持） | v0.8.0:manager.ts:1269-1536 | cdp-client.ts:346 は初期化スクリプト再適用のみ。通知なし | **R+★**（仕様 06 §2.4 が既に「CDP イベント…および 3 秒間隔」を要求） |
| B-2 | YouTube フルスクリーン保護（`.ytp-fullscreen-button` の disabled/aria-disabled 除去・pointer-events 強制・capture 位相クリック遮断、`player.toggleFullscreen` 上書き、`yt-navigate-start` で解除、`#guide-wrapper`/`#comments`/`cinematics`/`.player-container-background` 非表示） | v0.8.0:content.js:115-124,226-260,386-448 | page-scripts.ts:114-281 は screen 寸法応答と requestFullscreen 置換のみ | **R**（SPA 遷移残留・装飾残りの原因） |
| B-3 | `--touch-events=enabled` 復活 | v0.8.0:manager.ts:1044-1057 | launch-args.ts に無い | **R**（タッチ能力検出で UI を切り替えるサイトがある。CDP 注入自体は動くが Blink の touch capability フラグが立たない） |
| B-4 | `--force-dark-mode` 復活 | 同上 | Cookie のみ依存 | **R**（ダークテーマの恒久化。車載眩防止） |
| B-5 | `--disable-gpu-sandbox` 復活 | 同上 | 無い | **R**（GPU プロセスの /dev/dri アクセス担保。VAAPI デコード経路の耐性） |
| B-6 | `--hide-crash-restore-bubble` 復活 | 同上 | `--disable-session-crashed-bubble` のみ | **R**（現行 Chrome で有効な二重保証） |
| B-7 | Accept-Language 明示（`--accept-lang=ja-JP,ja,en-US,en` + Preferences `intl.accept_languages`/`selected_languages`） | v0.8.0:manager.ts:961-983,1019 | 無い | **R**（言語ネゴシエーション順序の明示。`LOCALE` から導出） |
| B-8 | Chrome 環境 `PULSE_SINK=virtual_sink` 復活 | v0.8.0:manager.ts:1090 | buildChromeProcessEnv は PULSE_SERVER のみ（launch-args.ts:176） | **R**（シンク明示バインド。default-sink 暗黙依存の排除） |
| B-9 | プロファイル修復の広さ（`Singleton*` ワイルドカード全削除 + トップレベル `Preferences` と `Default/Preferences` 両方の sanitize） | v0.8.0:manager.ts:896-941 | 固定 3 名 + Default のみ（browser-service.ts:41,329-349） | **R** |
| B-10 | Chrome バイナリ実行時検出（`google-chrome-stable`/`google-chrome`/`chromium-browser`/`chromium`） | v0.8.0:manager.ts:1246-1255 | `"google-chrome"` 固定（browser-service.ts:375） | **R**（deb シンボルリンク差分耐性） |
| B-11 | PulseAudio 実行時自己修復（stale socket 削除→`pulseaudio -k`→起動→socket 待機→`pactl` で sink 再 load・既定シンク設定・音量 100%/ミュート解除強制）を試みた後に失敗時のみ起動失敗 | v0.8.0:manager.ts:453-525 | `pactl info` 3 秒 fail-fast（browser-service.ts:301-321） | **R**（自己修復を追加し、その後の fail-fast は維持） |
| B-12 | Xvfb 動的拡張 `max(1920,w)×max(1080,h)` | v0.8.0:manager.ts:543-545 | 固定 1920×1080（launch-args.ts:82） | **K**（`maxSize ≤ 1920`・高さ上限 `min(1080,maxSize)` のため常に収まる。`-nolisten tcp` は維持） |
| B-13 | MV3 拡張三重注入・xdotool フォールバック・wmctrl resize | — | 単一 CDP 登録点・CDP 専用 | **K**（AGENTS §4-5、仕様 06 §2.2/§2.4 の設計決定） |
| B-14 | entrypoint VAAPI 自動検出/d3d12 フォールバック | v0.8.0:entrypoint.sh | アプリ側検出 + windows.yml 明示 env | **K**（仕様 09 §2.4 の責務分離） |

### 3.2 エンコーダ・GPU（仕様 05）

| # | 項目 | 处置 |
| :--| :--- | :--- |
| E-1 | NVENC 実測プローブの引数忠実度（`-preset p1 -tune ll -zerolatency 1` + `256×144:r=1` + `-pix_fmt yuv420p`）を稼働設定と一致させる | **R**（v0.8.0 は稼働と同じ低遅延構成で実測。現行は無オプション 1 枚のみで誤判定余地） |
| E-2 | auto 初期選好 NVENC→AMD→Intel（V0.8.0 は VAAPI 優先） | **K**（仕様 05 AC-01 の確定変更） |
| E-3 | ビットレート上限 2.0M（V0.8.0 API は 10M クランプ） | **K**（HUD 循環は両版とも 0.25M〜2.0M。車載 LTE 実需に合わせ 2.0M を正典維持） |
| E-4 | 音声 `-f pulse -i default`・Ogg 出力・`aud=insert` 廃止→`repeat-headers` | **K**（TrueNAS 実機で確定した現行正典） |
| E-5 | `/api/audio/test` テストビープ | **K**（仕様 07 §2.4 がテスト音声ボタン非配置を明記） |
| E-6 | VAAPI 詳細（圧縮優先度 1〜7・GPU 色変換・VDEnc 低電力）の設定 UI 露出 | **R**（V0.8.0 の custom パネル。仕様 07 タブ 2 に復元、タッチ専用ピッカー/トグルで） |

### 3.3 クライアント再生・A/V 同期（仕様 04 / 03）

| # | 項目 | V0.8.0 根拠 | 現行状態 | 处置 |
| :--| :--- | :--- | :--- | :--- |
| P-1 | **strict 1x PTS ペーシング**（前フレーム描画予定 + 実 PTS 差分。60fps バッチの <5ms マイクロ間隔も名目値へ水増ししない。バースト再生禁止、最小描画間隔 8ms） | v0.8.0:frame-pacer.ts（drainFactor=1.0） | 明示的スケジュール計算なし（WAIT/DROP と 8ms 下限のみ） | **R**（60FPS 連続描画の中核。`playback-controller` の MASTER_CLOCK ポリシーへ統合） |
| P-2 | **PLL マイクロ同期**（デッドバンド 45ms、±0.75ms/frame（Kp=0.005）、>150ms は ±2.0ms/frame slew。音声実再生 PTS 基準） | v0.8.0:frame-pacer.ts / av-sync.ts | 閾値 WAIT/DROP/再アンカーのみ。仕様 04 §2.3 は「追従（PLL）」を要求済み | **R+★**（大ズレの WAIT/DROP/1500ms 再アンカーは残し、小ズレは速度微小補正で無欠落吸着させる） |
| P-3 | 音声マスタークロック外挿の健全性ゲート（外挿有効窓 過去 1.5s 超で idle 化・−10s 未満破棄、再生レート 1.0x 固定） | v0.8.0:av-sync.ts | sync-clock.ts に外挿あり、窓の上下限ゲートは要確認 | **R**（仕様に数値明文化し実装統合） |
| P-4 | CATCHUP 蓄積キューの GOP 単位 trim と LIVE 復帰時の最新キーフレームへの live-jump flush | v0.8.0:decoder.ts（GOP trim・flushPendingForLiveJump） | CatchupVideoQueue はバイト/時間上限 trim のみ | **R**（キーフレーム途中破棄を構造的に起こさない） |
| P-5 | 音声 overflow 保持（映像より 8〜60s 先行時に退避、>1.5s stale のみ ≤60ms 地点へ一括再同期） | v0.8.0:audio-player.ts | pcmQueue 45s trim + 送出順制御のみ | **R**（CATCHUP 中の音声先走り防止をクライアント側でも保証） |
| P-6 | RTT 最小値履歴窓 8・CATCHUP/滞留中サンプル除外 | v0.8.0:streaming.ts | metrics-collector は EWMA + 鮮度のみ。仕様 03 §2.6 が既に要求 | **R+★** |
| P-7 | 音切れ防止数値（初期クッション 160ms / アンダーラン判定 >40ms / 再バッファ 80ms / 先行 25・500ms / ゲイン 0.88 / デクリック 1ms / source 完了イベント音声供給） | v0.8.0:audio-player.ts | AUDIO_PLAYER_CONSTANTS に同一値で継承済み | **K**（実装済み。回帰テストのみ追加） |
| P-8 | 適応ジッタ（90ms 閾値、60〜240ms、20ms/frame 昇・20ms/s 降） | v0.8.0:adaptive-jitter.ts | sync-clock に同一値継承 | **K**（同上） |

### 3.4 WS 配信・セッション（仕様 03 / 02）

| # | 項目 | 处置 |
| :--| :--- | :--- |
| S-1 | LIVE 輻輳→CATCHUP 降格（V0.8.0 の 512KiB トリガー） | **K**（Issue #104 で「LIVE 輻輳は GOP スキップのみ」を不変条件化。AGENTS §4-8） |
| S-2 | BUFFER_HOLD（85%/10%）・リンク認識 CATCHUP・`streamEpoch`・単一遷移関数 | **K**（V0.8.0 に無い改善。維持） |
| S-3 | **セカンダリ参加時同期 CATCHUP**: プライマリの再生遅延 ≥300ms でプライマリ確認済み PTS 起点の CATCHUP（音声ミュート）を開始 | **★**（仕様 02 §2.2 が既に「プライマリがライブ端から 300 ms 以上後方のバッファ視聴中なら追っかけ開始」を要求。実装のみ修復） |
| S-4 | メトリクス集計（ウィンドウ差分・符号付きドリフト） | **K**（V0.8.0 の絶対値平均は欠陥。現行が正しい） |

### 3.5 UI/UX（仕様 07）— 「見た目は V0.8.0 を丸写し」方針

機能レイアウト（中央揃え HUD・44px・60〜130% 既定 100%・アプリ内ピッカー・2.0M 循環）は PR #102/#101 で確定した現行仕様を維持し、**視覚層と操作フィードバック**を V0.8.0 に復元する:

| # | 項目 | 处置 |
| :--| :--- | :--- |
| U-1 | トースト通知システム（色分け・アイコン・スライドイン・2.8s 自動消滅。設定反映・追加・入力操作のフィードバック） | **R** |
| U-2 | アニメーション体系（spin / pulse ドット / signal-blink / ドロワーのスライドイン + backdrop-blur / `:active` scale(.96) / transition） | **R** |
| U-3 | PIN 画面のフルスクリーン演出（radial-gradient 背景、緑 #00ff88 発光 PIN・接続ボタン、大型テンキー、ブランドヘッダー、試行回数表示）+ PIN 画面から「設定・管理コンソール」（入力中 PIN プリフィル）入口 | **R** |
| U-4 | HUD アイコン式（SVG アイコン + monospace tabular-nums telemetry + 状態別バッジ配色: LIVE 緑 / `BUFFER_HOLD` 水 / `CATCHUP` 橙 / 正常 FPS 緑・低下橙） | **R**（V0.8.0 の「かっこよさ」の本体。ラベル文言は現行セレクタ出力を維持） |
| U-5 | お気に入りドロワーのカードグリッド（タイトル+ホスト、ホーム青枠、空状態案内） | **R** |
| U-6 | 起動中/スリープオーバーレイのリアルタイム health バッジ（Browser: 稼働中/準備中、配信: 送信中/待機中）+ スピナー | **R**（`/api/health` 実データで表示） |
| U-7 | 品質統計タブの monospace グリッド化 | **R** |
| U-8 | 先行バッファ深度選択肢へのメモリ目安・機種推奨ガイダンス文案、VAAPI 詳細編集（E-6） | **R** |
| U-9 | オンボーディングガイドの充実（機能カード 4 種・操作解説・callout） | **R** |
| U-10 | HUD 自動減光 opacity .72（現行 .45） | **R**（視認性の実測済み値） |
| U-11 | HUD 高さ 48px・左寄せ、拡大率 120% 既定、`<select>` ネイティブ、言語/タイムゾーン設定露出 | **K**(PR #102/#101 の確定仕様。中央揃え・60〜130%・ピッカー統一を維持） |

---

## 4. 決定台帳（V0.8.0 から意図的に変えたまま維持するもの）

1. `StreamingState` 単一遷移関数・`streamEpoch`・BUFFER_HOLD・リンク認識 CATCHUP・LIVE 輻輳 GOP のみ（Issue #104）。
2. CDP 専用入力（xdotool/wmctrl 廃止は AGENTS §4-5 の絶対制約）。
3. NVENC 最優先の auto 選好、`-f pulse -i default`、`repeat-headers`、ビットレート上限 2.0M。
4. PulseAudio fail-fast（ただし B-11 の自己修復を前置）、Xvfb 固定 1920×1080。
5. HUD レイアウト・拡大率範囲・アプリ内ピッカー統一（PR #102/#101）。
6. メトリクス集計の符号付き・ウィンドウ差分方式。

---

## 5. 実装フェーズ（PR 単位）

各 PR は対応仕様書の AC を持ち、AC ベース TDD（状態遷移は Stub-First）で進める。docs 先行本 PR のマージ後着手。

| PR | 範囲 | 対応仕様・AC |
| :--- | :--- | :--- |
| **PR-B** ブラウザ復元 | B-1〜B-11（起動引数、Preferences、PA 自己修復、バイナリ検出、Singleton、イベント駆動 URL 同期、フルスクリーン保護） | 仕様 06 §2.1/2.3/2.4 改訂分の AC-01・AC-03〜05 拡張 |
| **PR-C** 再生連続性 | P-1 strict 1x ペーシング + P-2 PLL（`transitionStreamingState` は変更せず `selectSyncPolicy` の MASTER_CLOCK 実行シェル内）、P-3 外挿ゲート、P-4 GOP trim/live-jump、P-5 音声 overflow、P-6 min-RTT 窓 | 仕様 04 §2.1/2.3 改訂分 AC-06〜AC-08、仕様 03 AC-05 拡張。pll_stutter / av_sync_hunting / pacer の振る舞いを現行アーキテクチャの純粋関数テストへ再対応付け |
| **PR-D** セッション同期参加 | S-3（サーバー: 参加時 CATCHUP、クライアント: 音声ミュート追従） | 仕様 02 §2.2 の既存要求の実装のみ（仕様変更なし）、AC は 02 AC-03 系に統合 |
| **PR-E** UI 視覚復元 | U-1〜U-10 + E-6（トースト、アニメ、PIN 演出、アイコン HUD、カードグリッド、health バッジ、統計グリッド、ガイダンス、VAAPI 詳細） | 仕様 07 §2.4 改訂分 AC-07〜AC-09 |
| **PR-F** エンコーダプローブ忠実度 | E-1（NVENC プローブ引数） | 仕様 05 §2.2 改訂分 AC-01 微修正 |

依存順: PR-B → PR-C →（PR-D ∥ PR-E ∥ PR-F）。PR-C が最リスク（実機 A/B 比較で V0.8.0 との体感一致を確認するまで release としない）。

### 検証計画

- 各 PR: `npm run check && npm test && npm build` + ガードレールテスト。
- PR-B/PR-C 統合後: TrueNAS 実機（iHD 基準機）で `midclt call app.stop/start tesroid` → `/api/health`、`vainfo`、コンテナログ確認。`/api/metrics/history` で FPS・drift・underrun を V0.8.0 断面（snapshot-prawip-b78f90bd 以前）と比較。
- PR-C: 車載相当長時間リグレッション（tesroid-browser-regression-lab の定期実行）で音切れ 0 件・描画 FPS ≥ target×0.8・|drift| ≤ 60ms 収束を機械確認。

---

## 6. DDD トラック判定

本変更は既存コンテキスト内の振る舞い復元が中心で、新規コンテキスト・集約再設計は含まない（`StreamingState` の状態・イベントは変更せず、同期ポリシーの連続制御層とパラメータを追加する）。したがって AGENTS.md §6.1 の**軽量トラック**の手続（原因分類 → 仕様先行更新 → AC TDD）で進め、`docs/domain/` は新規作成しない。ただし複数ドメインに跨るため本計画文書を統合計画として `docs/plans/` に置く。
