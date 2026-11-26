# Tesroid - 描画最適化 & ストリーミング制御 技術ナレッジベース (docs/OPTIMIZATION_KNOWLEDGE.md)

本ドキュメントは、Tesroid の開発・運用を通じて得られた **「コンテナ内 Chrome の安定描画」「超低遅延・高フレームレート（60 FPS）ストリーミング」「車載向けネイティブタッチ操作」「弱電波・輻輳時の配信制御および A/V 同期」** に関するアーキテクチャ設計と実装上の不変条件をまとめた技術仕様書です。

今後プロジェクトに参加する開発者および AI エージェントが、過去の障害や設計上の落とし穴を再発させることなく、システムの性能と安定性を維持・発展させることを目的とします。

---

## 1. 全体アーキテクチャ & パイプライン

Tesroid は、一般的なリモートデスクトップ（VNC / RDP）や WebRTC とは異なる独自パイプラインを採用しています。

```text
[ Tesla Browser (Client) ]
  │  ▲
  │  ├── 1. WebSocket（単一 WSS 接続・バイナリ多重化）
  │  │      - Server -> Client: 0x01=VIDEO, 0x02=AUDIO, 0x03=CONTROL_RESPONSE
  │  │      - Client -> Server: 0x10=TOUCH, 0x11=RESIZE, 0x12=AUTH, 0x13=COMMAND, 0x14=METRICS, 0x15=TELEMETRY
  │  │      - 映像描画: WebCodecs VideoDecoder -> <canvas desynchronized> ゼロコピー描画（D レンジ動画停止回避）
  │  │      - 音声再生: WebCodecs AudioDecoder -> Web Audio API（20ms Opus 低遅延再生）
  │  │
  ▼  │
[ Docker Host: tesroid-server Container ]
  ├── 2. CDP Touch Bridge (ws://127.0.0.1:9222)
  │      - Input.dispatchTouchEvent（Blink ネイティブタッチ注入：慣性スクロール・フリック・タップ）
  │      - Input.insertText / Input.dispatchKeyEvent（HUD 仮想キーボード経由の文字・キー注入）
  │
  ├── 3. Google Chrome (Standalone App Mode: --app=https://www.youtube.com)
  │      - 動画デコード: VAAPI ハードウェアデコード（Intel iHD/i965, AMD radeonsi via $VAAPI_DEVICE; DRI 不在時は自動 SW）
  │      - 2D DOM 描画: Chrome ネイティブ SIMD 高速 CPU ラスター（Mesa llvmpipe 競合回避）
  │
  ├── 4. Virtual Display & Audio
  │      - Xvfb (:99, 1920x1080x24) + Openbox（ウィンドウ枠なし: decor=no）
  │      - PulseAudio（専用設定 /etc/pulse/tesroid.pa, unix:/tmp/pulse-socket, virtual_sink 48kHz stereo s16le）
  │
  ├── 5. FFmpeg Dual Encoders (ENCODER_MODE=auto|vaapi|nvenc|software)
  │      - Video: x11grab -> h264_vaapi / h264_nvenc / libx264（ultrafast, zerolatency, B-frame 0）
  │      - Audio: pulse -> libopus（128kbps〜320kbps 可変, 20ms frame, lowdelay）
  │
  └── 6. Stream Flow & Backpressure Controller
         - LIVE 背圧: ビットレート連動 高低水位ヒステリシス制御（High: 512KB〜1536KB, Low: High×20% 下限 96KB）
         - 弱電波耐性: 60 秒リングバッファ（PlaybackBuffer）+ 再接続 CATCHUP + Buffer-Hold Pause（生成 0.0x 制御）
```

---

## 2. コンテナ内 Chrome の描画デッドロック対策（ハイブリッド描画）

### 背景・現象
Xvfb 上のコンテナ内 Chrome に対し、一般的な GPU 高速化フラグ（`--enable-gpu-rasterization`, `--enable-zero-copy`, `--disable-gpu-vsync`, `--disable-frame-rate-limit`, `--enable-features=CanvasOopRasterization`）を付与すると、YouTube 再生時に **動画下部（タイトル・関連動画・コメント欄）が黒く描画されなくなり、数秒後に画面更新が完全フリーズする** 事象が発生しました。

### 根本原因
Xvfb にはハードウェア DRM/KMS 画面合成や DRI3 ページフリップ機構が存在せず、OpenGL は **Mesa llvmpipe（CPU ソフトウェアエミュレーション）** で提供されます。この環境下で上記フラグを有効化すると、以下の競合が起こります。

1. `--enable-gpu-rasterization` により Skia 2D 描画が llvmpipe へ送られ、GPU プロセスの CPU 使用率が約 35% まで跳ね上がる。
2. 動画デコードは VAAPI（`$VAAPI_DEVICE`）でハードウェア実行される一方、`--enable-zero-copy` が Xvfb 共有メモリと VAAPI サーフェス間の DMA-BUF 共有を試みて同期ロックでストールする。
3. `--disable-gpu-vsync` により VSync タイマーが失われ、Chrome の Viz コンポジタがデッドロックして X11 への `SwapBuffers` が停止する。

### 解決策：ハイブリッド描画アーキテクチャ
動画デコードと 2D DOM 描画の役割を明確に分離しています。

| 描画対象 | 処理担当 | 使用技術 / フラグ |
| :--- | :--- | :--- |
| **動画デコード** (YouTube VP9 / H.264) | **GPU VAAPI**（DRI 不在時は自動 SW） | `--enable-features=AcceleratedVideoDecodeLinuxGL,VaapiIgnoreDriverChecks` + `--render-node-override=${this.vaapiDevice}` |
| **2D DOM / テキスト / レイアウト** | **Chrome 高速 CPU ラスター** | デフォルト Skia CPU（AVX2 / SIMD 最適化） |
| **AV1 ソフトウェアデコード** | **無効化（HW デコード優先）** | `--disable-features=Av1Decoder,AudioServiceSandbox,Translate` |

```typescript
// server/src/browser/manager.ts - 安定起動フラグ構成（Ubuntu 24.04 / Chrome Stable）
const args = [
  '--no-sandbox',
  '--test-type',
  `--user-data-dir=${this.profileDir}`,
  `--window-size=${this.width},${this.height}`,
  '--window-position=0,0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
  '--disable-infobars',
  '--disable-notifications',
  '--password-store=basic',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-gpu-sandbox',
  '--ignore-gpu-blocklist',
  '--enable-features=AcceleratedVideoDecodeLinuxGL,VaapiIgnoreDriverChecks',
  `--render-node-override=${this.vaapiDevice}`,
  '--disable-features=Av1Decoder,AudioServiceSandbox,Translate',
  '--disable-translate',
  '--touch-events=enabled',
  '--force-dark-mode',
  '--remote-debugging-port=9222',
  '--remote-debugging-address=127.0.0.1',
  `--app=${url}`,
];
```

> [!NOTE]
> **マルチ GPU・`/etc/libva.conf`・Windows D3D12 に関する注意点**:
> - `libva` は環境変数 `LIBVA_DRIVER_NAME` より `/etc/libva.conf` を優先するため、`/etc/libva.conf` にドライバ名を直書きせずコメントのみを維持し、実行時に `iHD` / `i965` / `radeonsi` / `d3d12` を切り替えられるようにします。
> - Windows Docker Desktop / WSL2 環境では `GALLIUM_DRIVER=d3d12` を Chrome にグローバル付与せず、FFmpeg の `d3d12` プローブ・サブプロセスのみに限定します（Chrome は Xvfb 上で安定した CPU Skia + `llvmpipe` を維持）。

この構成により、GPU プロセスの CPU 使用率は **35% → 4% 未満** へ低下し、レイアウト破損および描画フリーズは完全に解消しました。

---

## 3. バックプレッシャー制御・解像度アライメント・先読みバッファ設計

### 3.1 高低水位ヒステリシスによるバックプレッシャー制御
単一閾値（例: `bufferedAmount > 128KB`）で P フレームを破棄し、次のキーフレーム到着時にソケット残量を確認せず復帰させる方式では、IDR キーフレーム（40〜60KB）送出のたびに `bufferedAmount` が再超過し、**キーフレームのみが送信され続ける 2 FPS の無限ドロップループ**に陥ります。

そのため `server/src/ws/handler.ts` では、配信ビットレートに連動した **高低水位ヒステリシス制御** を採用しています。

```typescript
// server/src/ws/handler.ts - ビットレート連動ヒステリシス制御
const bps = this.configStore.getConfig().stream?.bitrate || 1000000;
const HIGH_WATER_MARK = Math.max(
  512 * 1024,
  Math.min(1536 * 1024, Math.round((bps / 8) * 3.0)),
);
const LOW_WATER_MARK = Math.max(96 * 1024, Math.round(HIGH_WATER_MARK * 0.2));

// 1. 深刻な輻輳時のみ GOP ドロップへ移行
if (buffered > HIGH_WATER_MARK) {
  (client as any)._droppingGop = true;
}

// 2. 低水位までバッファが抜け、かつ新しい IDR キーフレームが来た場合のみ復帰
if ((client as any)._droppingGop) {
  if (!isKeyframe || buffered > LOW_WATER_MARK) {
    continue;
  }
  (client as any)._droppingGop = false;
}
```

### 3.2 解像度の 8 ピクセル境界アライメント
`handleResizeMessage` では幅を 8 ピクセル境界（`& ~7`）、高さを 2 ピクセル境界（`& ~1`）へ揃えています。これにより FFmpeg の `swscaler` 非アライメント警告と余計なメモリコピーを防ぎ、CPU–GPU 転送効率を維持します。

```typescript
const width = Math.max(640, Math.min(maxSize, effW)) & ~7;
const height = Math.max(360, Math.min(Math.min(1080, maxSize), effH)) & ~1;
```

### 3.3 弱電波向け 30 秒先読みバッファと CATCHUP キュー上限 (Issue #56)
車載 LTE のトンネル・地下駐車場などの一時的な通信断に備え、クライアントの目標バッファ深度 `targetBufferMs` は最大 30 秒（`0〜30000ms`）まで設定できます。

- **サーバー側リングバッファ (`PlaybackBuffer`)**: 60fps / 2Mbps 映像 + 128kbps 音声で 30 秒あたり約 8 MB（60 秒で約 16 MB）、高ビットレート設定時のヘッドルームも含めて **`PLAYBACK_BUFFER_MAX_BYTES` 既定値 48 MB / 保持時間 60 秒** としています。
- **CATCHUP 送出キュー上限 (`MAX_CATCHUP_QUEUE_FRAMES`)**: 60fps 映像 + 50pps（20ms）Opus 音声の混在時は毎秒 110 フレームに達するため、上限を **6,600 フレーム（60 秒相当）** として 30 秒リカバリ時の GOP 途中破棄を防いでいます。
- **スリープ移行時のクリア**: `enterSleepPaused()` 実行時に `PlaybackBuffer` と `lastKnownAckPts` をクリアし、スリープ復帰時に古いフレームが誤送出されないようにしています。

---

## 4. ネイティブタッチ操作の実現（CDP `Input.dispatchTouchEvent`）

### 背景と課題
`xdotool` によるマウスエミュレーション（`mousedown 1` + `mousemove`）では、指を動かし始めた微小移動で Chrome がリンク・画像のドラッグ＆ドロップやテキスト選択を開始してしまい、モバイル端末のような自然なフリック・慣性スクロールが成立しませんでした。

### 解決策：`CdpTouchBridge`
Chrome に `--touch-events=enabled` を付与した上で、`server/src/input/xdotool.ts` の `CdpTouchBridge` から Chrome DevTools Protocol（CDP）の `Input.dispatchTouchEvent`（`touchStart` / `touchMove` / `touchEnd`）を Blink へ直接注入しています。

- **慣性スクロール（Fling Inertia）**: Chrome 内部の物理エンジンが指の初速から自然な減速スクロールを生成。
- **誤ドラッグ・テキスト選択の抑止**: タッチイベントとして処理されるため、HTML5 ドラッグや範囲選択が誤爆しない。
- **低遅延・フォールバック**: X11 / XTest を経由せずレイテンシ 1ms 未満で到達し、CDP 切断時のみ `xdotool` へ自動フォールバックしつつ再接続する。

---

## 5. コンテナ内 PulseAudio と音声ストリーミングの安定化

### 背景と根本原因
初期構成では `/etc/pulse/system.pa` へ仮想シンク設定を記述していましたが、root コンテナ内では `pulseaudio --system` が失敗してユーザーモードへフォールバックし、`/etc/pulse/default.pa` が読み込まれて `virtual_sink` およびソケットが消失していました。その結果、FFmpeg の音声プロセスが `No such device or address` で即死ループし、無音状態となっていました。

### 解決策
1. **専用設定ファイルの明示指定**: `/etc/pulse/tesroid.pa` を用意し、`pulseaudio -n -F /etc/pulse/tesroid.pa --exit-idle-time=-1 --disallow-exit -D` で UNIX ドメインソケット `/tmp/pulse-socket` と `virtual_sink`（48000Hz / stereo / s16le）を確実に生成します。
2. **FFmpeg への明示的ソケット指定**: `-f pulse -server unix:/tmp/pulse-socket -i virtual_sink.monitor` を指定し、環境変数に依存せずアタッチします。
3. **Chrome 音声サンドボックス無効化**: `--disable-features=AudioServiceSandbox` により、コンテナ内の PulseAudio ソケットへのアクセス失敗を防ぎます。
4. **自動アンミュート・デコード互換・AudioContext アンロック**:
   - CDP スクリプトで YouTube プレイヤー等の自動再生ミュート状態を定期解除します。
   - クライアントの `AudioPlayer` は `f32-planar` / `f32` の双方を安全にデコードし、画面上の任意の `pointerdown` で `AudioContext.resume()` を試行します。

---

## 6. Chrome ネイティブ UI（Views Bubble）の抑止 (Issues #35, #44)

### 背景と根本原因
`CdpTouchBridge` の `Input.dispatchTouchEvent` は Web ページの DOM に対してイベントを注入するため、Chrome ブラウザ自身のネイティブ UI（**Views Bubble**）にはタッチが届きません。そのため以下のバブルが表示されると車載画面から閉じられず、操作が阻害されます。

- パスキー / WebAuthn ダイアログ（"No passkeys available"）
- パスワード保存確認（"Save password?"）・自動サインイン・漏洩検知・住所／カード自動入力バブル

### 解決策
1. **WebAuthn インターセプト (Issue #35)**:
   - 拡張機能（`server/extension/content.js`, `run_at: "document_start"`, `world: "MAIN"`）と CDP `Page.addScriptToEvaluateOnNewDocument` の双方で、`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` / `isConditionalMediationAvailable()` が常に `false` を返すよう上書きします。
   - `navigator.credentials.get/create({ publicKey })` をネイティブ UI 起動前に `DOMException(..., 'NotAllowedError')` で即座に拒絶し、パスワード入力等のフォールバック画面へ安全に遷移させます。
2. **パスワードマネージャー・自動入力バブル抑止 (Issue #44)**:
   - `BrowserManager.applyChromePreferences()` で `Default/Preferences`（存在時は `Preferences` も）に `credentials_enable_service: false`、`credentials_enable_autosignin: false`、`profile.password_manager_enabled: false`、`profile.password_manager_leak_detection: false`、`autofill.profile_enabled: false`、`autofill.credit_card_enabled: false` を書き込みます（既存の `profile.exit_type` / `exited_cleanly` は保持）。
   - Chrome 起動引数に `--password-store=basic` を付与し、Linux / Xvfb 環境での OS キーリングプロンプトを抑止します。

---

## 7. 車載ソフトウェアキーボード（OSK）と CDP 文字入力

テスラ車載 Chromium は DOM の編集可能要素（`<input>` / `<textarea>`）へのフォーカス時のみ OS ソフトウェアキーボードを起動します。Tesroid は D レンジ動画停止ガード回避のため映像全体を `<canvas>` で描画しているため、映像内の検索窓を直接タップしても OSK は起動しません。

### 解決策
- 上部 HUD の `⌨️` ボタンから展開するドロワー内に、`user-select: text` を明示した実 HTML `<input id="hud-keyboard-input">` を配置し、タップで車載 OSK を確実に起動させます。
- 入力テキストは WebSocket 経由でサーバーへ送り、`CdpTouchBridge` の CDP `Input.insertText` でフォーカス中の入力欄へ直接注入します（日本語・記号のエンコーディング化けやクリップボード依存なし）。
- `Enter` / `Backspace` / `Tab` は CDP `Input.dispatchKeyEvent` で送信します。

---

## 8. H.264 Annex-B → AVCC サーバーオフロードとゼロコピー描画 (Issue #11)

### 背景と課題
従来のクライアント側 Annex-B 走査・AVCC 変換は毎秒 30〜60 回の線形スキャンと `Uint8Array` 再確保を伴い、CPU 性能の限られるテスラ MCU2（Intel Atom）環境で V8 の GC Pause によるマイクロスタッターを引き起こしていました。

### 解決策
変換処理をサーバー側（`server/src/encoder/ffmpeg.ts`）へ集約し、クライアント側を完全ゼロコピー化しました。

1. **SPS / PPS の分離送信**: SPS / PPS は 4 バイトスタートコード（`0x00000001`）へ正規化し、`VIDEO_FLAGS.CONFIG`（`0x02`）としてスライスに先行送信します。
2. **単一パス AVCC パッキング**: Access Unit 内の全スライス総長を事前算出し、1 回の `Buffer.allocUnsafe(totalLength)` へ 4 バイト長ヘッダとスライス本体を隙間なくコピーします（`writeOffset === totalLength` の不変条件を検証）。
3. **AUD / SEI の意図的破棄**: `h264_metadata=aud=insert` で付与した AUD（NAL Type 9）はサーバー内の AU 境界判定のみに使用して破棄し、デコードに寄与しない SEI（NAL Type 6）も帯域・負荷削減のため破棄します。
4. **クライアント完全ゼロコピー (`VIDEO_FLAGS.AVCC`)**: `client/src/core/decoder.ts` は `VIDEO_FLAGS.AVCC`（`0x04`）を検知すると、受信バッファをコピーせず直接 `new EncodedVideoChunk({ data })` へ渡します（旧形式パケット受信時は `H264Parser.annexBToAvcc` へフォールバック）。

---

## 9. NAS・カスタム Linux カーネル環境におけるシステムコール非互換対策 (Issue #93)

### 背景と根本原因
Docker コンテナはホスト OS の Linux カーネルを共有します。ベースイメージを Ubuntu 24.04（Noble）へ更新した際、`pulseaudio` → `dconf-service` の OR 依存（`default-dbus-session-bus | dbus-session-bus`）を通じて `dbus-user-session` → `libpam-systemd` → `systemd` v255（`libsystemd-shared`）が暗黙的にインストールされました。

`systemd` v255 の `fchmod_opath()` は Linux 6.6+ 固有の `fchmodat2(fd, "", mode, AT_EMPTY_PATH)` を発行し、未対応時に `ENOSYS` または `EPERM` が返ることを前提にフォールバックします。しかし QNAP QTS（Linux 5.10 系カスタムカーネル）等の NAS 環境では空パス引数に対して `ENOENT` が返るためフォールバックに失敗し、`dpkg --configure systemd` が異常終了してビルド不能となりました。

### 3 重の防止ガードレール（ホストカーネル非依存原則）
Tesroid は特定の Linux カーネルバージョンに依存せず、Linux / TrueNAS / QNAP / Synology / Unraid / Windows Docker Desktop 等で広く動作することを設計原則とします。単一プロセスのコンテナに不要なシステムデーモンを入れないため、以下を徹底します。

1. **非 systemd 代替パッケージの明示**: `Dockerfile` の `apt-get install --no-install-recommends` に `dbus-x11` を明示指定し、`dbus-user-session` / `systemd` の引き込みを断つ。
2. **APT Pinning (`/etc/apt/preferences.d/no-systemd`)**: `systemd`, `systemd-sysv`, `systemd-standalone-sysusers`, `systemd-standalone-tmpfiles`, `libpam-systemd`, `dbus-user-session`, `udev` を `Pin-Priority: -1` で強制ブロックする。
3. **パッケージ追加・更新時の事前監査**: `apt-get install -s` で `systemd*` / `udev` / `polkitd` / `snapd` が混入しないこと、および対象パッケージの `postinst` が特定カーネルの最新システムコール（`fchmodat2`, `openat2`, `mount_setattr` 等）に依存しないことを確認する。

---

## 10. 弱電波・モバイル回線におけるストリーミング制御と A/V 同期 (Issues #103〜#112)

モバイル LTE 回線での車載実走および極端な輻輳テスト（HTB 500kbit 帯域制限・3G エミュレーション等）から確立した配信制御・A/V 同期の仕様です。

### 10.1 LIVE ジャンプ後の straggler 音声とライブエッジ PTS バリア (Issue #103)
`JUMP_TO_LIVE` 実行時にクライアント側のキューを全破棄しても、ジャンプ直前にサーバーから送信済みでソケットやネットワーク経路上を漂流している古い音声パケット（straggler）が後から到着すると、`AudioPlayer` のゼロギャップ連結（`nextPlayTime`）によってライブ音声の再生予定が約 2 秒後方へ押し出されます。音声がマスタークロック（`playbackRate = 1.0` 固定）であるため、映像側 PLL（`±2.0ms/frame` 上限）だけでは分単位で音ズレが残留します。

- **二重バリア設計**:
  1. **クライアント暫定バリア**: ジャンプ時に PONG の `latestPts` からの実時間外挿（または退避した最終 PTS）で `audioPlayer.setLiveEdgeBarrier()` を即時設定します。
  2. **サーバー権威バリア**: サーバーは `LIVE_JUMPED`（およびセカンダリ向け `PRIMARY_JUMP_TO_LIVE`）で `dropAudioBeforePts`（`encoder.getCurrentPts()`）を返し、サーバー側でも `encoder.setResumeBoundary()` で同一 PTS 未満の音声送出を抑止します。
  3. **パージと自動失効**: `setLiveEdgeBarrier()` は TCP FIFO 順序で先行滑り込み済みのキュー・スケジュールも検出して即パージし、`playAudioData` 側でも非同期デコード出力を遮断します。バリアは 5 秒 TTL、バリア以上 PTS の到達、またはストリームリセットで自動解除されます。

### 10.2 CATCHUP バーストのリンク適応と背圧経路の分離 (Issues #104, #109)
- **LIVE 背圧のヒステリシス一元化 (Issue #109)**:
  - LIVE 配信中のソケット詰まりでフレームを CATCHUP キューへ退避する方式では、移行時点でクライアントのバッファが `targetBufferMs` まで満杯になっているため送出ゲート（`inFlight < effectiveCatchupWindowMs`）が開かず、キュー排水が進まないまま遅延と音ズレが恒久化します。
  - したがって **LIVE 中のソケット詰まりは高低水位ヒステリシス GOP スキップへ一元化** し、CATCHUP キューは **再接続 / resume でクライアントが後方から追いつく経路専用** としています。
- **CATCHUP リンク認識フロー制御 (Issue #104)**:
  - ACK / `BUFFER_FEEDBACK` の再生 PTS 進捗（250ms〜5000ms 窓）からクライアントの実効排水レート（EWMA）を推定し、`0.85x` 未満の低速リンクでは in-flight 窓を `targetBufferMs × rate`（下限 2.5 秒）へ縮小します。
  - 連続ソケット詰まり（`catchupCongestionStreak >= 3`）または低排水レート検知時のみ、CATCHUP のソケットガードを 128KB から帯域連動の 32KB〜64KB へ下げ、送出間隔を 2ms → 10ms へ緩和します。
  - CATCHUP キューのスパンが先行バッファ深度の 2 倍（最低 30 秒）を超えた場合は最古 GOP を間引き、無限キャッチアップを防ぎます。

### 10.3 RTT 計測の特性とバッファ集計の単一化 (Issues #105, #106, #107)
- **RTT の鮮度管理と限界 (Issue #105)**:
  - PING / PONG は映像・音声と同一の WebSocket を共有するため、測定 RTT にはメディアキューの後方滞留が含まれます。
  - CATCHUP 中やキュー滞留中の汚染サンプルは `AdaptiveJitterController` へ流さず、有効サンプルの採用時刻から 5 秒超過した場合は `instantRtt` を鮮度切れとして破棄します。接続初期で `minRtt` 未確立時も `Number.isFinite(minRtt)` ガードで汚染値の採用を防ぎます。
- **バッファ集計の単一正典 (Issue #106)**:
  - クライアントは `getVideoPathBufferedMs()` / `getAudioPathBufferedMs()` で HUD 表示と `BUFFER_FEEDBACK` 報告（`bufferedMs` / `audioBufferedMs`）を統一します。
  - サーバーの `getClientInFlightBufferMs()` は `max(ptsInFlightMs, bufferedMs, audioBufferedMs)` を採用し、音声滞留の過小評価を防ぎます。
- **診断ログ (Issue #107)**:
  - CATCHUP 開始時にクライアント由来（`localStorage`）の実効 `targetBufferMs` と `burst` 値をサーバーログへ出力し、障害解析時の追跡性を確保します。

### 10.4 Buffer-Hold Pause Phase 1 と状態遷移の不変条件 (Issue #111)
極端な帯域制限後の再接続などでサーバー生成（1.0x）とクライアント消費（1.0x）が均衡すると、CATCHUP のバックログが数十秒規模で横ばいとなり解消しません。これを構造的に解決するため、サーバー側で生成を一時停止する **Buffer-Hold Pause** を導入しています。

#### 動作仕様
- **先行保持量の評価**: `serverHeldMs = playbackBuffer.getLatestVideoPts() - lastKnownAckPts` を生成イベント起点で 1 秒ごとに評価します。
- **発動 (`enterBufferHold`)**: `serverHeldMs >= holdTriggerMs`（`clamp(targetBufferMs, 10s, 30s)`、`targetBufferMs = 0` は無効）または `PlaybackBuffer` メモリ使用量 85% 到達時に発動します。Chrome プロセスツリーを `SIGSTOP` し FFmpeg を停止して生成速度を `0.0x` に落とし、`pipelineHoldState = 'BUFFER_HOLD_PAUSED'` へ遷移します（スリープ `paused` とは独立状態であり、`BROWSER_STATUS` は `running` を維持）。
- **自動再開 (`exitBufferHold`)**: クライアントの消費進捗により `serverHeldMs <= resumeTriggerServerMs`（VAAPI 2 秒 / software 3 秒のヘッドルーム基準）へ低下すると、Chrome を `SIGCONT` し FFmpeg を再開します。
- **PTS 単調連続化**: 壁時計 PTS 算出を `VaapiEncoder.computeWallClockPtsUs()` へ統一し、Hold 停止時間の合計 `totalHoldPausedUs` を差し引くことで、再開後も PTS タイムラインの連続性を維持します。
- **再接続 `resumeFromPts` クランプ**: 高 RTT 下で陳腐化した `lastAckPts` のまま CATCHUP を開始しないよう、再開位置を `max(lastAckPts, latestBuffered - holdTriggerMs)`（直前キーフレームへスナップ）へクランプします。
- **HUD 表示**: PONG の `holdPaused` および `BUFFER_HOLD` 制御メッセージにより、HUD に `HOLD L:…s S:…s` を表示します（タップで即 LIVE 同期、完全タッチオンリー）。

#### 必須の不変条件（Invariants）
1. **ヒステリシス幅**: `computeHoldConfig()` により `holdTriggerMs - resumeTriggerServerMs >= 7.2s` を機械的に保証します。
2. **タイマー排他**: `autoSleepTimer` と `holdExpireTimer`（既定 10 分、`BUFFER_HOLD_EXPIRE_MINUTES`）は同時に稼働させません。`holdExpireTimer` 満了時は共通スリープフロー `enterSleepPaused()` へ合流し、手動 `PAUSE_BROWSER` は再開チャーンを経由せず Hold → スリープへ変換します。
3. **Hold 補償のリセット**: Hold からスリープへ遷移する際（`convertHoldToSleep` / `enterSleepPaused`）および新セッション切替・完全リスタート（`restartStream` / `restartAll`）時は、`encoder.resetHoldCompensation()` で `holdPausedSinceUs` / `totalHoldPausedUs` / `resumeBoundaryPtsUs` をクリアし、次回復帰時の PTS 巻き戻りを防ぎます。
4. **両プロセス稼働の保証（片肺無音防止）**: `VaapiEncoder.isRunning()` は `isVideoRunning || isAudioRunning`（論理 OR）であるため、復帰・再開経路では **`isFullyRunning()`（`isVideoRunning && isAudioRunning`）** と `ensureEncoderRunning()` を使用します。Hold 中に新セッション切替や CATCHUP 不能な `startLive()` 転落が起きた場合も必ず Hold を解除して Video / Audio の両方を起動します。
5. **Hold 中の背景処理と再接続制御**: Hold 中は背景 CDP ポーリングを停止して凍結中レンダラのタイムアウトを防ぎます。セカンダリ接続では `holdExpireTimer` を解除しません。
6. **F-1b (`PlaybackBuffer` の CONFIG 非混入) と音声冪等性**: `PlaybackBuffer.addVideo` / `addAudio` は CONFIG パケット（`pts: 0n`）をフレーム配列へ混入させずメタキャッシュ（`cachedSpsPps` / `cachedOpusHead`）のみ更新します。クライアント側 `AudioPlayer` も同一 `OpusHead` 再送時のデコーダ再初期化とジッターバッファ破棄をスキップします。

### 10.5 復帰時 A/V 境界保護と残留音声先行の映像側吸収 (Issue #111 F-4 / Issue #112 F-4b, F-5)
1. **PTS 基準の復帰ゲート (F-4)**:
   - Hold 復帰時の `armResumeGate(8000)` の時間項（8000ms）は「IDR が一度も到達しない」異常時の安全弁に限定します。
   - 本来の境界は **`this.resumeGateActive === true` の間に到達した最初の Video IDR の PTS**（`resumeBoundaryPtsUs`）であり、その PTS 未満の先行音声パケットをサーバー側で破棄します。
   - **重要**: 定常配信中の通常キーフレーム（`resumeGateActive === false`）では `resumeBoundaryPtsUs` を上書きしてはなりません。
2. **サーバー起因 LIVE 復帰時の映像対称早送り (F-4b)**:
   - `LIVE_JUMPED` 受信時および PONG の `CATCHUP -> LIVE` 遷移エッジでは、音声バリアと対称にクライアント側映像キューを早送りします（`fastForwardVideoToLiveEdge()`）。この際 `framePacer.jumpToLive(true)` で自適応クッションを維持し、直後の微小ジッタによる WAIT 揺動を防ぎます。
3. **残留音声先行の映像側 stale-drop 吸収 (F-5)**:
   - `FramePacer` の A/V PLL 負方向シフトは `maxNegativeShiftAllowed = min(0, earliestHeadTime - currentHeadSchedule)` で制限されるため、1x 到着で先頭フレームが `now` に張り付いた状態では数百 ms の音声先行（映像遅れ）を吸収できません。
   - そのため、**キュー滞留が 8 フレーム超かつ 150ms 超の音声先行時のみ**、スピーカー再生中音声 PTS より 40ms 以上古い映像フレームを 1 tick あたり最大 4 フレームまで破棄します（`frame.close()` で確実に解放）。音声マスター（`playbackRate = 1.0`）および正常な 1x 到着時の PLL 制御には干渉しません。

### 10.6 健康な LIVE 状態での LIVE タップ最適化 (Issue #112 F-6)
すでに遅延なく再生中の健康な LIVE 状態で HUD の LIVE ボタンをタップした際、不要な再起動・リセットによる FPS 急落を防ぐため、サーバー・クライアント双方で以下の一貫した制御を行います。

1. **サーバー側全体再起動スキップ (`canSkipFullRestart` / `POST /api/encoder/restart`)**:
   - 以下のすべてを満たす場合のみ全体再起動をスキップし、`{ success: true, restarted: false, skipped: true }` を返します（`?force=1` クエリまたは明示 WS コマンド `RESTART_ENCODER` / `CLEAN_RESTART_STREAM` は常に全体再起動）。
     - `pipelineHoldState === 'ACTIVE'`
     - `encoder.isFullyRunning() === true`（Video / Audio 両稼働）
     - 全セッションが `CATCHUP` でなく、かつ `_droppingGop` でもない
     - `serverHeldMs() <= 1000` ms
   - **重要**: `PlaybackBuffer` は過去 60 秒の再接続用履歴を常時保持するため、`PlaybackBuffer.getBufferedDurationMs()` は滞留判定条件に含めてはなりません。
2. **クライアント側 `tesroid:stream-reset` 抑止 (`power-actions.ts`)**:
   - `encoderRestart()` はサーバー応答が `skipped === true || restarted === false` の場合、`tesroid:stream-reset`（`decoder.reset()` + `framePacer.reset()` + 再起動中オーバーレイ）を発火しません。サーバーが新 SPS/PPS・IDR を送らない状態でクライアントだけデコーダをリセットすると、次の定期 GOP まで最大 2 秒間フリーズするためです。
3. **健康 LIVE 時の `JUMP_TO_LIVE` 非破壊処理 (`handler.ts`)**:
   - すでに `session.mode === 'LIVE'` かつ `!_droppingGop` かつ Hold 非解除の状態で `JUMP_TO_LIVE` を受けた場合、`abortCatchupAndSwitchToLive()` による過去キーフレーム再送や Video FFmpeg の強制再起動を行わず、`ensureEncoderRunning()` と `LIVE_JUMPED` 応答のみを実行します。また Hold 解除直後は `skipEncoderRestart: true` により起動直後の Video FFmpeg の二重起動を防ぎます。
4. **デコーダ極小滞留の継続保護 (`decoder.ts`)**:
   - `flushPendingForLiveJump()` で `pendingPackets` 内にキーフレームが存在しない場合でも、滞留がごく小さい（10 パケット未満かつ 300ms 未満）なら破棄して `waitingForKeyframe = true`（最大 2 秒待ち）へ遷移せず、そのまま継続デコードします。

---

## 11. アンチパターン集（厳禁事項）

今後このプロジェクトを修正・拡張する際、以下を行ってはなりません。

1. ❌ **Xvfb 環境で `--enable-gpu-rasterization` を追加すること**
   - ソフトウェア llvmpipe による 2D 描画で CPU が浪費され、VAAPI デコードとの競合でコンポジタがデッドロックします。
2. ❌ **`--enable-zero-copy` を追加すること**
   - Xvfb は DMA-BUF GpuMemoryBuffer 非対応のため、スワップ待機で画面更新がフリーズします。
3. ❌ **`--disable-gpu-vsync` を追加すること**
   - Viz コンポジタがフレーム境界を見失い、描画停止やスキップを引き起こします。
4. ❌ **バックプレッシャー制御で単一閾値（ヒステリシスなし）のフレーム破棄を行うこと**
   - キーフレーム送信時の瞬間的なバッファ上昇で P フレームが全破棄され、2 FPS の無限ドロップループに陥ります。
5. ❌ **タッチ操作を `mousedown 1` + `mousemove` のマウスエミュレーションへ戻すこと**
   - ドラッグ選択が誤爆し、フリック・慣性スクロールが破綻します。必ず CDP `Input.dispatchTouchEvent` を使用してください。
6. ❌ **テスラ車載ブラウザ向けに `<video>` タグを使うこと**
   - テスラ OS の安全機能により D レンジ走行時に強制停止されます。描画は必ず WebCodecs `VideoDecoder` → `<canvas desynchronized>` を経由してください。
7. ❌ **コンテナ内 PulseAudio で `--system` や `system.pa` のみに依存すること**
   - ユーザーモードへのフォールバック時に `virtual_sink` が消失して FFmpeg が即死します。必ず `-F /etc/pulse/tesroid.pa` を使用してください。
8. ❌ **WebAuthn インターセプトを外すこと**
   - パスキー設定済みアカウントで Chrome ネイティブダイアログ（Views Bubble）が表示され、車載 DOM タッチでは閉じられず操作不能になります。
9. ❌ **車載文字入力を `<canvas>` への直接タッチに依存させること**
   - 車載 Chromium は `<canvas>` タップで OS ソフトウェアキーボードを起動しません。必ず編集可能 `<input>`（`user-select: text`）を備えた HUD 仮想キーボードバー経由で CDP 注入してください。
10. ❌ **クライアント側で毎フレーム H.264 Annex-B 走査および `Uint8Array` 再確保を行うこと**
    - MCU2（Intel Atom）等で頻繁な GC Pause が発生し、定期的なカクつきを招きます。サーバー側 AVCC パッキングとクライアント側ゼロコピーを維持してください。
11. ❌ **`FramePacer` の空キュー時即時描画パスでリップシンク PLL シフトを破棄すること**
    - `lastScheduledTimeMs = now` で時刻をリセットすると PLL 補正が蓄積せず、`AudioPlayer` のジッターバッファ分だけ映像が恒常的に先行します。
12. ❌ **Chrome のパスワード保存・自動入力 Views Bubble 抑止設定（`applyChromePreferences` / `--password-store=basic`）を削除すること (Issue #44)**
    - これらネイティブバブルは DOM タッチでは閉じられません。既存の `profile.exit_type` / `exited_cleanly` を保持しつつ抑止設定を維持してください。
13. ❌ **クライアント側 (`client/`) で物理キーボードやマウス操作を前提とした機能・UI を実装すること**
    - テスラ車載ディスプレイは完全タッチオンリー環境です。`Escape` キーによるモーダル閉じ、キーボードショートカット、`keydown` 依存、`hover` 専用 UI、右クリックメニュー、マウスポインタ前提ドラッグを実装してはなりません。
14. ❌ **`Dockerfile` から `dbus-x11` や `/etc/apt/preferences.d/no-systemd` を外して `systemd` / `libsystemd-shared` / `dbus-user-session` を引き込むこと (Issue #93)**
    - NAS カスタムカーネル（Linux 5.10 系等）で `fchmodat2` が `ENOENT` を返し、`dpkg --configure` が失敗してビルド不能になります。
15. ❌ **`PlaybackBuffer.getBufferedDurationMs()` を未消費滞留と誤認すること、および `encoder.isRunning()`（OR）を両プロセス稼働保証に使うこと (Issue #112)**
    - `PlaybackBuffer` は過去 60 秒の履歴リングバッファであり、配信開始 2 秒後には常に `> 2000ms` になります。未消費滞留には `serverHeldMs()` を使用してください。また、Video と Audio の両方稼働を保証すべき復帰経路では必ず `isFullyRunning()`（AND）を使用してください。
16. ❌ **サーバーが再起動をスキップした応答でクライアント側 `decoder.reset()` を発火すること、および定常キーフレームで `resumeBoundaryPtsUs` を上書きすること (Issues #111, #112)**
    - サーバーが新 SPS/PPS・IDR を送らない状態でクライアントだけ `decoder.reset()` すると最大 2 秒フリーズします。また `resumeBoundaryPtsUs` の更新は `resumeGateActive` 武装中の最初の IDR のみに限定してください。

---

## 12. 実機デバッグ & 診断コマンド集

トラブルシューティング時にコンテナ内の状態を確認するためのコマンド一覧です。

```bash
# 接続先ホストの設定
SERVER_HOST="${DEPLOY_HOST:-<SERVER_IP>}"
SERVER_USER="${DEPLOY_USER:-root}"

# 1. コンテナ内 Chrome の GPU 機能・CDP バージョン確認
ssh "${SERVER_USER}@${SERVER_HOST}" \
  "docker exec tesroid-server curl -s http://127.0.0.1:9222/json/version"

# 2. X11 仮想画面 (:99.0) のリアルタイム画面キャプチャ
ssh "${SERVER_USER}@${SERVER_HOST}" \
  "docker exec tesroid-server ffmpeg -y -f x11grab -draw_mouse 0 -i :99.0 -vframes 1 /tmp/debug_screen.png && docker cp tesroid-server:/tmp/debug_screen.png /tmp/debug_screen.png"
scp "${SERVER_USER}@${SERVER_HOST}:/tmp/debug_screen.png" ./debug_screen.png

# 3. 再生中動画のドロップフレーム数・品質メトリクス測定
ssh "${SERVER_USER}@${SERVER_HOST}" \
  "docker exec tesroid-server node -e \"
    const WebSocket = require('/app/server/node_modules/ws');
    (async () => {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise(r => ws.on('open', r));
      ws.on('message', d => {
        const msg = JSON.parse(d);
        if (msg.id === 1) {
          console.log('Quality:', msg.result.result.value);
          process.exit(0);
        }
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(document.querySelector(\\\"video\\\").getVideoPlaybackQuality())' } }));
    })();
  \""

# 4. ヘルスチェック & VAAPI デバイス診断
ssh "${SERVER_USER}@${SERVER_HOST}" \
  "curl -s http://127.0.0.1:9001/api/health && echo '' && docker exec tesroid-server vainfo --display drm --device \${VAAPI_DEVICE:-/dev/dri/renderD128}"
```

---

## 13. テスラ車載ブラウザのディスプレイ仕様・実測値 & ローカル再現手順

Issue #53 の実機ログ調査およびコミュニティ知見から整理した、テスラ車載ブラウザ（MCU / Chromium）の表示・DPR 仕様とローカル PC での再現手順です。

### 車載ブラウザの DPR・解像度仕様
- **DPR の変化点（SW 2026.26 世代）**:
  - テスラ車載ブラウザにはユーザーズーム操作がなく、UI 設定やウィンドウ状態では DPR は変化しません（変わるのは CSS キャンバス寸法のみ）。
  - **Tesla Software 2026.26（Chromium 140 → 148）** で `devicePixelRatio` が `1.0 → 約 1.53` へ変更されました。
  - 物理パネル解像度 `1920×1200` に対し、SW 2026.26 以降の CSS 画面全体は `1254×784`（`1920 / 1.53 ≒ 1254.9`）です。
- **実機実測値（Tesla Model 3 / SW 2026.26 以降）**:
  - **小窓表示（主対象）**: CSS `773×553` / `DPR 1.53` → サーバー実効フレーム `1160×830`
  - **全画面相当（コンテナ）**: CSS `1256×659` / `DPR 1.53` → サーバー実効フレーム `1256×658`（HUD 48px を除いたビューポート）
  - **全画面（画面全体参考値）**: CSS `1254×784` / `DPR 1.53`
  - **SW 2026.26 以前**: CSS `1920×1200` / `DPR 1.0`

### 設計上の留意点
- **小窓表示を主対象とする**: 実車利用ではナビ等と並べる小窓表示が中心となるため、UI 視認性・エンコード解像度は小窓（`773×553` CSS / `DPR 1.53`）を基準に最適化します。
- **DPR 値の非ハードコード**: 将来のファームウェア更新で DPR が変化し得るため、`1.53` を固定値として直書きせず、物理ピクセルおよびサーバー側リサイズ計算で吸収します。
- **複数クライアント混線への注意**: デバッグ用 PC ブラウザを接続したままスリープ・放置すると、自動再接続により別解像度のリサイズ要求が飛び、車載側のエンコーダ再起動や表示乱れを起こすことがあります。実車検証時はデバッグ用タブを閉じてください。

### ローカル PC（Chrome）での実車環境再現手順
1. Chrome で Tesroid クライアントを開き、`F12`（macOS は `Cmd+Opt+I`）で DevTools を開く。
2. デバイスツールバー（`Cmd+Shift+M`）を有効化し、上部プルダウンから **Edit... → Add custom device...** を選択する。
3. 以下のプロファイルを追加して切り替える。

| 再現対象 | Width × Height (CSS px) | Device pixel ratio | 備考 |
| :--- | :--- | :--- | :--- |
| **小窓（主対象）** | `773 × 553` | `1.53` | サーバー実効 `1160×830` |
| **全画面（コンテナ）** | `1256 × 659` | `1.53` | サーバー実効 `1256×658` |
| **全画面（画面全体）** | `1254 × 784` | `1.53` | SW 2026.26 以降参考値 |
| **旧世代（2026.26 以前）** | `1920 × 1200` | `1.0` | レガシー互換確認用 |

DevTools コンソールで `devicePixelRatio` / `innerWidth` / `innerHeight` / `screen.width` を評価し、意図した値になっていることを確認して検証を行ってください。
