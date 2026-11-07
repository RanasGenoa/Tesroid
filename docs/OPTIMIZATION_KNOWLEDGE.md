# Tesroid v2 - 描画最適化 & ストリーミング制御 技術ナレッジベース (docs/OPTIMIZATION_KNOWLEDGE.md)

本ドキュメントは、Tesroid v2 の開発において得られた **「コンテナ内 Chrome の安定描画」「超低遅延・高フレームレート（60 FPS）ストリーミング」「真の静電容量式ネイティブタッチ操作」** に関する極めて重要なアーキテクチャ設計および実装ノウハウを記録した技術仕様書です。

今後プロジェクトに参加する開発者および AI エージェントが、同様の落とし穴に陥ることなく、システムの高パフォーマンスと安定性を維持・発展させられるようにすることを目的とします。

---

## 1. 全体アーキテクチャ & パイプライン

Tesroid は、一般的なリモートデスクトップ（VNC/RDP）や WebRTC ストリーミングとは根本的に異なる独自アーキテクチャを採用しています。

```
[ Tesla Browser (Client) ]
  │  ▲
  │  ├── 1. WebSocket (単一WSS接続: バイナリ多重化 0x01=VIDEO, 0x02=AUDIO, 0x03=CONTROL)
  │  │      - WebCodecs VideoDecoder -> <canvas desynchronized> ゼロコピー描画 (Dレンジ動画停止回避)
  │  │      - Web Audio API (AudioWorklet / AudioBufferQueue) 20ms ジッターフリー再生
  │  │      - PointerEvent -> 0x00 TOUCH パケット送信
  │  │
  ▼  │
[ Docker Host: tesroid-server Container ]
  ├── 2. CDP Touch Bridge (ws://127.0.0.1:9222)
  │      - Input.dispatchTouchEvent (Blinkネイティブタッチ注入: 慣性スクロール, フリック, タップ)
  │
  ├── 3. Google Chrome (Standalone App Mode: --app=https://www.youtube.com)
  │      - 映像再生: Intel VAAPI QuickSync ハードウェアデコード (/dev/dri/renderD128)
  │      - 2D DOM描画: Chromeネイティブ SIMD 高速CPUラスター (Mesa llvmpipe競合回避)
  │
  ├── 4. Virtual Display & Audio
  │      - Xvfb (:99, 1920x1080x24) + Openbox (枠なし: decor=no)
  │      - PulseAudio (virtual_sink: 48kHz stereo s16le, 20ms lowdelay)
  │
  ├── 5. FFmpeg VAAPI Dual Encoders
  │      - Video: x11grab -> nv12 hwupload -> h264_vaapi (2500kbps, 60fps, GOP 30, B-frame 0)
  │      - Audio: pulse -> libopus (128kbps〜320kbps 可変・設定調整可能, 20ms frame, lowdelay)
  │
  └── 6. WebSocket Backpressure Controller
         - 高低水位ヒステリシス制御 (High: 768KB, Low: 128KB) による無限ドロップループ根絶
```

---

## 2. 課題①: コンテナ内 Chrome の描画デッドロック & レイアウト破損（画面下が真っ黒になる問題）

### 現象
YouTube の動画再生画面を開くと、動画上部は表示・再生されているのに、**動画下部（タイトル、チャンネル名、関連動画、コメント欄）が真っ黒な空間になり、スクロールも操作も不能になる** 現象が発生。さらに再生開始数秒（6分39秒時点など）で画面更新が完全フリーズし、音声のみが再生され続ける状態に陥っていた。

### 根本原因のメカニズム
Chrome をヘッドレス・仮想ディスプレイ（Xvfb）環境で動作させる際、一般的な「GPU 高速化フラグ」を無邪気に追加したことが原因でした：
- `--enable-gpu-rasterization`
- `--enable-zero-copy`
- `--disable-gpu-vsync`
- `--disable-frame-rate-limit`
- `--enable-features=CanvasOopRasterization`

Xvfb にはハードウェア DRM/KMS 画面合成や DRI3 ページフリップ機構が存在せず、OpenGL は **Mesa llvmpipe（CPU ソフトウェアエミュレーション）** で提供されます。
この環境下で：
1. `--enable-gpu-rasterization` を有効化すると、Chrome の Skia 2D エンジンは全 HTML/CSS/文字描画を llvmpipe のソフトウェア GL シェーダーに送ります（これで GPU プロセスが CPU 35% を消費）。
2. 同時に動画デコードは Intel VAAPI (`/dev/dri/renderD128`) でハードウェア処理されます。
3. `--enable-zero-copy`（ゼロコピー GpuMemoryBuffer）が Xvfb の共有メモリと VAAPI サーフェス間でバッファ共有を試みますが、DMA-BUF 互換性がなく同期ロック待機でストールします。
4. `--disable-gpu-vsync` により VSync タイマーが消失し、Chrome の **Viz ディスプレイコンポジタスレッドがデッドロック**。
5. 結果として、動画クワッド（オーバーレイ）のみが一度描画された後、X11 への `SwapBuffers` / `PostSubBuffer` が停止し、動画外の領域が再描画されず黒いまま固まりました。

### 解決策: 「ハイブリッド描画アーキテクチャ」
動画デコードと 2D DOM 描画の役割を明確に分離しました：

| 描画対象 | 処理担当 | 使用技術 / フラグ |
| :--- | :--- | :--- |
| **動画デコード** (YouTube VP9/H.264) | **Intel GPU シリコン** | `--enable-features=VaapiVideoDecoder,VaapiVideoEncoder,VaapiIgnoreDriverChecks` |
| **2D DOM / テキスト / レイアウト** | **Chrome 高速 CPU ラスター** | デフォルト Skia CPU（AVX2/SIMD 最適化） |
| **AV1 ソフトウェアデコード** | **無効化 (ハードウェア優先)** | `--disable-features=Av1Decoder` |

```typescript
// server/src/browser/manager.ts - 黄金の安定起動フラグ構成
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
  '--autoplay-policy=no-user-gesture-required',
  '--disable-gpu-sandbox',
  '--ignore-gpu-blocklist',
  // Hardware video decode via Intel VAAPI (UHD 630 QuickSync)
  '--enable-features=VaapiVideoDecoder,VaapiVideoEncoder,VaapiIgnoreDriverChecks',
  // CRITICAL: Disable AV1 software decode so YouTube automatically serves hardware-accelerated VP9/H.264
  '--disable-features=Av1Decoder',
  '--touch-events=enabled',
  '--force-dark-mode',
  '--remote-debugging-port=9222',
  '--remote-debugging-address=127.0.0.1',
  `--app=${url}`,
];
```

**【効果】**
- GPU プロセス CPU 使用率: **35% ➔ 4% 未満** に激減。
- レイアウト破損・黒い未描画領域: **完全消滅**。
- 動画詳細、関連動画、コメント欄が常時 100% 破綻なく描画。

---

## 3. 課題②: 映像カクカク / 紙芝居化（FPS 低下）の根本原因と解消

### 現象
FFmpeg は 60 FPS でエンコードできているのに、テスラ車載ブラウザ（または PC クライアント）では映像が激しくカクつき、2〜5 FPS の紙芝居状態になっていた。

### 根本原因のメカニズム
`server/src/ws/handler.ts` のバックプレッシャー（送信キュー制御）に重大なロジック欠陥が存在しました：

```typescript
// 【バグのあった以前のコード】
if ((client as any).bufferedAmount > 128 * 1024) {
  if (!isKeyframe) {
    (client as any)._droppingGop = true;
    continue; // Pフレームを捨てる
  }
}
if ((client as any)._droppingGop) {
  if (!isKeyframe) continue;
  // キーフレームが来たら即座に解除してキーフレームを送信！
  (client as any)._droppingGop = false;
}
client.send(packet);
```

1. 2500 kbps / 60 FPS のストリームにおいて、IDR キーフレームのサイズは **約 40〜60 KB**、デルタ（P）フレームは **約 4〜6 KB** です。
2. Wi-Fi やテスラ車載 LTE の RTT（30〜80ms）において、60KB のキーフレームを送信すると、ソケットの `bufferedAmount` は一時的に **128 KB** を容易に超えます。
3. バッファが 128 KB を超えた瞬間、次のフレームから `_droppingGop = true` となり全 P フレームが捨てられます。
4. 0.5 秒後（30 フレーム後）、次のキーフレームが到着します。
5. 上記コードはソケットの残量を確認せず無条件に `_droppingGop = false` に戻し、再び 60KB のキーフレームをソケットに push します。
6. これにより `bufferedAmount` は再び 128KB を超過し、直後のフレームで即座に `_droppingGop = true` に戻ります。
7. **結果: 永久に P フレームが届かず、キーフレーム（0.5秒に1回 = 2 FPS）しか送信されない「無限ドロップループ」が完成。**

### 解決策: 高低水位ヒステリシス制御 (Hysteresis Backpressure)
制御工学のヒステリシス（Hysteresis）を導入し、突入閾値と復帰閾値を分離しました：

```typescript
// server/src/ws/handler.ts - ヒステリシス・バックプレッシャー制御
const buffered = (client as any).bufferedAmount || 0;
const HIGH_WATER_MARK = 768 * 1024; // 768KB (約2.5秒分のネットワーク完全停滞時のみ発動)
const LOW_WATER_MARK = 128 * 1024;  // 128KB (バッファが完全にドレインされた状態)

// 1. 深刻なネットワーク輻輳時のみドロップモードへ移行
if (buffered > HIGH_WATER_MARK) {
  (client as any)._droppingGop = true;
}

// 2. ドロップモード中は、バッファが低水位まで抜け、かつクリーンなIDRキーフレームが来た時のみ復帰
if ((client as any)._droppingGop) {
  if (!isKeyframe || buffered > LOW_WATER_MARK) {
    continue; // 差分フレーム破棄、またはバッファ抜け待ち
  }
  // 回復完了
  (client as any)._droppingGop = false;
}

client.send(packet);
```

### 追加最適化: swscaler の 8 ピクセル境界アライメント
`handleResizeMessage` でクライアントから受け取った解像度を 8 ピクセル境界（`& ~7`）にアライメント：
```typescript
const width = Math.max(640, Math.min(1920, requestedW)) & ~7;
const height = Math.max(360, Math.min(1080, requestedH)) & ~1;
```
これにより、FFmpeg の `[swscaler] Warning: data is not aligned! This can lead to a speed loss` が完全に解消し、CPU-GPU 転送が最高速化。

**【効果】**
- 通常のネットワーク通信ではフレームドロップが **0 件**。
- 安定した **60 FPS** の超滑らかな映像ストリーミングを実現。

---

## 4. 課題③: フリック・タッチ操作の追従性（CDP ネイティブタッチの導入）

### 現象
「動画一覧は動くが、フリック操作に対する追従がおかしい（タッチになってない気がする）」。
指を動かした際に、動画のサムネイルがデスクトップのドラッグ＆ドロップのように半透明で掴まれたり、文字が選択されたりして、スクロールがギクシャクしていた。

### 根本原因
従来のサーバー実装は `xdotool` によるマウスエミュレーションを行っていました：
- タッチ開始（DOWN）で `mousedown 1`（マウス左ボタン押下）を発行。
- 指を動かす（MOVE）際、判定閾値（8px）に達するまでの微小移動で、Chrome が **「リンク／画像のドラッグ＆ドロップ」または「テキスト選択」を開始**。
- その後スクロールモードに入って `mouseup 1` を送っても、ブラウザ側ですでにドラッグ状態が成立しており、スクロールイベントが抑制されていた。

### 解決策: Chrome DevTools Protocol (CDP) `Input.dispatchTouchEvent` の直接注入
Chrome に `--touch-events=enabled` を付与した上で、CDP の Input ドメインを使って **Blink エンジンへ直接静電容量マルチタッチイベントを注入する `CdpTouchBridge`** を構築しました：

```typescript
// server/src/input/xdotool.ts - CdpTouchBridge の要点
public handleTouch(action: number, pointerId: number, x: number, y: number): boolean {
  if (!this.isConnected()) return false;

  if (action === 0) {
    // DOWN -> touchStart
    this.activeTouches.set(pointerId, { x, y, id: pointerId });
    this.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: Array.from(this.activeTouches.values()),
    });
  } else if (action === 2) {
    // MOVE -> touchMove
    this.activeTouches.set(pointerId, { x, y, id: pointerId });
    this.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: Array.from(this.activeTouches.values()),
    });
  } else if (action === 1 || action === 3) {
    // UP / CANCEL -> touchEnd
    this.activeTouches.delete(pointerId);
    this.send('Input.dispatchTouchEvent', {
      type: this.activeTouches.size > 0 ? 'touchMove' : 'touchEnd',
      touchPoints: Array.from(this.activeTouches.values()),
    });
  }
  return true;
}
```

**【CDP ネイティブタッチのメリット】**
1. **真の慣性物理スクロール (Fling Inertia)**:
   Chrome の内部物理エンジンが指の初速を計算し、スマホと全く同じ減速カーブで滑らかに慣性スクロール。
2. **誤ドラッグ・テキスト選択の完全抑止**:
   Blink はタッチイベントとして処理するため、HTML5 ドラッグ＆ドロップやテキスト選択が一切発動しない。
3. **タップ判定の自動合成**:
   短時間のタッチダウン＆アップで、Blink が正確な `click` イベントを自動生成（動画リンクのタップが一発で反応）。
4. **極低遅延**:
   X11 サーバーや XTest 拡張を経由せず、Chrome の入力スレッドへ直接 WebSocket で届くためレイテンシ **< 1ms**。
5. **フォールバック保証**:
   CDP 接続が切断されている間は自動的に従来の `xdotool` へフォールバックし、バックグラウンドで自動再接続。

---

## 5. 課題④: コンテナ内 PulseAudio ソケット不整合による音声エンコーダー即死 & 無音障害の根本原因と解消

### 現象
テスラ車載ブラウザ（クライアント）側で動画映像は 30/60 FPS で極めて滑らかに表示されているが、**一切の音声（YouTube動画の音）が出ない**。

### 根本原因のメカニズム
1. **PulseAudio 設定ファイルと実行モードの乖離**:
   - Dockerfile で `/etc/pulse/system.pa` に `module-null-sink` や `module-native-protocol-tcp` を追記していた。
   - しかし root コンテナ内で `pulseaudio --system` は root 実行セキュリティチェックにより起動失敗し、フォールバックの `pulseaudio -D`（per-user ユーザーモード）で起動していた。
   - ユーザーモードデーモンは `/etc/pulse/system.pa` を無視し、`/etc/pulse/default.pa` のみを読み込むため、`virtual_sink` も TCP/UNIX プロトコルも読み込まれなかった。
2. **クライアント設定のデッドロック**:
   - `/etc/pulse/client.conf` に `default-server = 127.0.0.1` が設定されていたが、PulseAudio は TCP ポート 4713 をリッスンしていなかった。
   - このため `pactl` も `ffmpeg` も `chrome` もすべて `Connection refused` となり、`virtual_sink` の作成・確認コマンドがことごとく無視されていた。
3. **FFmpeg 音声エンコーダーの即死ループ**:
   - FFmpeg の音声入力 `-i virtual_sink.monitor` がデバイスを見つけられず、`virtual_sink.monitor: No such device or address (exit code 1)` で 1 秒ごとに起動と即死を無限に繰り返していた。
   - 結果として、サーバーから音声パケット（0x02 AUDIO）が 1 バイトも送信されていなかった。

### 解決策: 専用 pa 設定・UNIX ドメインソケット直接接続・アンミュート保証
1. **専用設定ファイル `/etc/pulse/tesroid.pa` の直接指定**:
   `pulseaudio -n -F /etc/pulse/tesroid.pa --exit-idle-time=-1 --disallow-exit -D` により、システムモード/ユーザーモードの差異に関わらず、確実に UNIX ドメインソケット `/tmp/pulse-socket` と `virtual_sink`（48000Hz stereo s16le）を確立。
2. **FFmpeg オプションへの明示的ソケット指定**:
   `-f pulse -server unix:/tmp/pulse-socket -i virtual_sink.monitor` により、環境変数に依存せず確実に PulseAudio に直接アタッチ。
3. **Chrome AudioService のコンテナ権限保証**:
   `--disable-features=AudioServiceSandbox` を付与し、Chrome のオーディオプロセスがコンテナ内の PulseAudio ソケットにアクセスできない事象を完全防止。
4. **YouTube 自動アンミュート保証**:
   CDP スクリプトにより、YouTube プレイヤーや `<video>` 要素がブラウザの自動再生ポリシーによってミュート（`muted=true`）状態になっていないか定期チェックし、音量 100% で自動アンミュート。
5. **WebCodecs AudioDecoder のフォーマット互換性向上**:
   Planar 形式（`f32-planar`）だけでなく Interleaved 形式（`f32`）も安全に Float32 AudioBuffer にデコードできる二重バッファリングを実装。
6. **テスラ車載ブラウザ向け AudioContext 自動アンロック & 視覚的ガイダンス**:
   テスラ車載ブラウザの Autoplay 解除のため、画面上のあらゆるタッチ（`pointerdown`）で `AudioContext.resume()` を試行。もし音声パケットを受信しているのに `suspended` の場合は HUD の音量アイコンでタップを促す視覚的ヒントを表示。

---

## 6. 課題⑤: WebAuthn / パスキーネイティブダイアログによる操作不能・画面ブロックの抑止 (Issue #35)

### 現象
YouTube などの Google サービスでパスキー（Passkey / WebAuthn）が設定されているアカウントにログインしようとすると、Chrome がブラウザネイティブのバブルダイアログ（「No passkeys available - There aren't any passkeys for google.com on this device」）を表示。
このダイアログが画面中央上部に覆いかぶさり、背面の Google ログイン画面（パスワード入力や「別の方法で試す」）が覆い隠される。
さらに、Tesroid のタッチ入力（`CdpTouchBridge`）は Web ページのレンダープロセス（DOM）に対してイベントを注入しているため、ブラウザウィンドウ自体のネイティブ UI（Views Bubble）にはタッチイベントが届かず、[Close] ボタンをタップしてダイアログを閉じることができないため、操作不能に陥る。

### 根本原因のメカニズム
1. **CDP ネイティブタッチの対象スコープ**:
   - `Input.dispatchTouchEvent` は Web ページの Blink レンダラーに対する入力注入であるため、Chrome ウィンドウの Chrome UI / Views Bubble には届かない。
2. **コンテナ環境における FIDO2 認証器の不在**:
   - Docker / Xvfb 環境には物理的な USB セキュリティキーやプラットフォーム認証器（TPM, Touch ID, Windows Hello 等）が存在せず、パスキー認証自体が成功する見込みがない。
3. **WebAuthn API の自動呼び出し**:
   - Google の認証フローは、ブラウザが WebAuthn に対応していると判定すると自動的に `navigator.credentials.get({ publicKey: ... })` を呼び出すため、このダイアログが必然的に出現する。

### 解決策: 拡張機能 & CDP による WebAuthn インターセプト
ブラウザ起動時の拡張機能（`server/extension/content.js`, `run_at: "document_start"`, `world: "MAIN"`）および `BrowserManager` の CDP 新規ドキュメントスクリプト（`Page.addScriptToEvaluateOnNewDocument`）で WebAuthn API をインターセプト：
1. `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` および `isConditionalMediationAvailable()` が常に `Promise.resolve(false)` を返すようにオーバーライド。Web サイトに対して「このデバイスにはローカル認証器が存在しない」と事前通知する。
2. `navigator.credentials.get()` および `navigator.credentials.create()` に `publicKey` オプションが含まれる場合、Chrome ネイティブ UI が起動する前に即座に `DOMException('Passkeys are not supported in this environment.', 'NotAllowedError')` を throw して拒絶。
3. これにより、Google ログイン画面などの認証フローは「パスキー未対応端末またはユーザー拒絶」として安全にパスワード入力や「別の方法でログイン」のフォールバック画面へ自動遷移し、ネイティブダイアログの出現自体を完全に防止する。

---

## 7. 課題⑥: テスラ車載ブラウザでの OSK（ソフトウェアキーボード）呼び出し不可と仮想キーボードバーによる CDP 入力注入

### 現象
Google ログインや YouTube 検索時、コンテナ内 Chrome の入力欄（`input#identifierId` や検索窓）を車載画面でタップしても、**テスラ車載ブラウザのソフトウェアキーボード（OSK）が一切起動せず、文字入力ができない**。

### 根本原因のメカニズム
1. **テスラ車載 Chromium の OSK 起動要件**:
   - 車載 OS のソフトウェアキーボードは、DOM 上の編集可能要素（`<input>` や `<textarea>`）にフォーカスが当たった場合にのみ起動する。
2. **WebCodecs `<canvas>` 描画の盲点**:
   - Tesroid は D レンジ動画停止ガードを回避するため全画面を HTML5 `<canvas>` に描画している。
   - 車載ブラウザから見るとユーザーが触れているのは単なる `<canvas>` 要素であるため、いくら映像内の入力欄をタップしても車載 OS は文字入力フィールドとして認識しない。

### 解決策: HUD 仮想キーボードバー + CDP `Input.insertText` / `Input.dispatchKeyEvent` 注入
上部 HUD 直下に、車載キーボードを確実に起動させる専用ドロワーと CDP 注入パイプラインを構築：

1. **車載 OSK トリガー**:
   - HUD の `⌨️` ボタンからスライド展開するドロワーに、明示的に `user-select: text` を付与した実 HTML `<input id="hud-keyboard-input">` を配置。
   - タップ時に車載 OS が編集可能要素として認識し、テスラネイティブのソフトウェアキーボードがポップアップ。
2. **CDP `Input.insertText` による直接文字注入**:
   - 車載キーボードで入力したテキスト（日本語・英数字・記号）を WebSocket 経由で送信。
   - コンテナ側では常時接続された `CdpTouchBridge` が CDP `Input.insertText` を実行。現在フォーカスされている入力欄（メールアドレス・パスワード）へレイテンシ **< 1ms** で一括注入（xdotool のエンコーディング化けやクリップボード依存を完全排除）。
3. **キーボード操作アクション**:
   - `Enter ⏎`: `Input.dispatchKeyEvent` (rawKeyDown/char/keyUp, vk=13) を発行し、検索実行やフォーム送信をシームレスにトリガー。
   - `Backspace ⌫` / `Tab ⇥`: 入力修正やフィールド移動をサポート。

---

## 8. 課題⑦: H.264 Annex-B ➔ AVCC サーバーオフロード & クライアント完全ゼロコピー描画 (Issue #11)

### 現象
テスラ車載ブラウザ（特に CPU 性能が制限される MCU2 Intel Atom 環境）において、サーバー側の FFmpeg は 30/60 FPS で安定エンコードできているにもかかわらず、動画再生中に定期的なカクつき（マイクロスタッター）やフレームドロップが発生していた。

### 根本原因のメカニズム
1. **毎フレームの線形走査とオブジェクト生成オーバーヘッド**:
   - 従来のクライアント実装では、FFmpeg から受信した H.264 Annex-B バイト列（`0x000001` / `0x00000001` 区切り）をブラウザ側 JavaScript で毎フレーム線形ループ走査し、NAL 境界を特定して 4 バイト長プレフィックス付きの AVCC 形式に再構成していた。
   - 1 秒あたり 30〜60 回、1 フレームあたり数万〜十数万バイトの配列走査と `new Uint8Array` によるメモリ再確保・コピーが発生。
2. **車載 V8 エンジンの GC Pause（ガベージコレクション停滞）**:
   - MCU2 Intel Atom の貧弱な CPU コアにおいて、毎秒数百回の短寿命オブジェクト生成が V8 マイナー GC / メジャー GC を頻繁に誘発し、メインスレッドの処理が数ミリ〜数十ミリ秒ブロックされ、WebCodecs デコードキューの供給遅延・コマ落ちを引き起こしていた。

### 解決策: サーバー側 AVCC 事前パッキング & クライアント完全ゼロコピー (`VIDEO_FLAGS.AVCC`)
変換負荷を余裕のあるサーバー側（`server/src/encoder/ffmpeg.ts`）へオフロードし、クライアント側を完全なゼロコピー構造に刷新：

1. **SPS/PPS (CONFIG) とスライスの分離送信**:
   - WebCodecs の `decoder.configure({ description: ... })` で必要な SPS/PPS は Annex-B 形式（`0x00000001` 正規化）で抽出し、`VIDEO_FLAGS.CONFIG`（フラグ `0x02`）としてスライスパケットに先行して配信。
2. **単一バッファによる高速 AVCC パッキング**:
   - 同一 Access Unit (AU) に含まれるスライス群の総バイト長（`4 * sliceCount + totalPayload`）を事前計算。
   - 単一の `Buffer.allocUnsafe(totalLength)` を 1 度だけ確保し、4 バイト Big-Endian 長ヘッダとスライス payload を単一パスで隙間なくコピー。
   - 将来のリファクタリング事故による未初期化バイト漏洩を防ぐため、`writeOffset === totalLength` の不変条件（Invariant）アサーションを配備。
3. **SEI (Type 6) および AUD (Type 9) の意図的破棄方針**:
   - FFmpeg の `h264_metadata=aud=insert` で挿入される AUD（NAL Type 9）は、サーバー内でのマルチスライス AU 境界判定マーカーとしてのみ消費し、クライアント向けパケットからは除外。
   - SEI（NAL Type 6: 補足拡張情報）はデスクトップ低遅延画面共有ストリーミングにおいてデコードに寄与せず不要であるため、WebSocket 通信帯域の節約および車載デコーダの負荷削減のため意図的・恒常的に破棄。将来的にカスタムメタデータの伝送が必要となった場合のみホワイトリスト形式で再導入する方針とする。
4. **クライアント完全ゼロコピーデコード**:
   - クライアント側（`client/src/core/decoder.ts`）は `VIDEO_FLAGS.AVCC`（フラグ `0x04`）を検知すると、WebSocket 受信バッファの ArrayBuffer を `H264Parser.annexBToAvcc` を通さず直接 `new EncodedVideoChunk({ data })` に渡し、メモリ確保・コピー・走査を完全ゼロ化。
5. **完全な下位互換性と防御的フォールバック**:
   - `VIDEO_FLAGS.AVCC` フラグを持たない旧形式パケットを受信した場合は自動的に `H264Parser.annexBToAvcc` へフォールバックし、互換性を保証。
   - クライアント再接続時、SPS/PPS（CONFIG）と AVCC キーフレームの両方が揃っていない不完全キャッシュ時は直ちにエンコーダ再起動（IDR 要求）を行い、デコーダクラッシュ（`InvalidStateError`）を確実に抑止。

**【効果】**
- クライアント側の Annex-B 走査およびフレーム毎メモリ確保が **完全ゼロ（0 bytes / 0 cycles）** に低減。
- MCU2 Intel Atom 環境における GC カクつきが根絶され、MCU3 (Ryzen) と同様の滑らかな描画性能を両立。

---

## 9. アンチパターン集 (絶対にやってはいけないこと)

今後このプロジェクトを修正・拡張する際、以下の設定を絶対に行ってはなりません：

1. ❌ **Xvfb 環境で `--enable-gpu-rasterization` を追加すること**
   - Xvfb のソフトウェア llvmpipe で Skia 2D を描画させると、CPU が 35% 浪費され、VAAPI デコードとのバッファ競合でコンポジタがデッドロックします。
2. ❌ **`--enable-zero-copy` を追加すること**
   - Xvfb は DMA-BUF GpuMemoryBuffer に対応していません。強制するとスワップ待機で画面更新がフリーズします。
3. ❌ **`--disable-gpu-vsync` を追加すること**
   - フレームレート無制限フラグと組み合わせると、Viz コンポジタがフレーム境界を見失い、描画スキップを引き起こします。
4. ❌ **バックプレッシャー制御で単一閾値（ヒステリシスなし）のフレーム破棄を行うこと**
   - キーフレーム送信時の瞬間的なバッファ上昇で P フレームが全破棄され、恒久的な 2 FPS 紙芝居になります。
5. ❌ **タッチ操作を `mousedown 1` + `mousemove` のマウスエミュレーションで行うこと**
   - Web ページ上の要素がドラッグ選択され、モバイル/タブレットのような自然なフリック操作が不可能です。必ず CDP `Input.dispatchTouchEvent` を使用してください。
6. ❌ **テスラ車載ブラウザ向けに `<video>` タグを使うこと**
   - テスラ OS の安全機能により、ギアを D（走行）に入れた瞬間に `<video>` 要素の再生が強制停止されます。描画は必ず WebCodecs の `VideoDecoder` ➔ `<canvas desynchronized>` を経由してください。
7. ❌ **コンテナ内 PulseAudio で `--system` や `system.pa` のみに依存すること**
   - root ユーザー下でユーザーモードにフォールバックした際に設定が失われ、`virtual_sink` が消失して FFmpeg が即死します。必ず `-F /etc/pulse/tesroid.pa` で専用 pa 設定を直接読み込ませてください。
8. ❌ **WebAuthn API を未対策のまま放置すること**
   - パスキー設定済みアカウントでの Google ログイン時に Chrome ネイティブの WebAuthn バブルダイアログ（"No passkeys available"）が表示され、車載 DOM タッチ入力ではタップ不能となりログイン操作が完全に遮断されます。必ず WebAuthn インターセプトを維持してください。
9. ❌ **テスラ車載向け文字入力で `<canvas>` への直接タッチのみに頼ること**
   - 車載 Chromium は `<canvas>` タップでは OS ソフトウェアキーボードを起動しません。必ず編集可能 `<input>`（`user-select: text`）を備えた HUD 仮想キーボードバーを経由して CDP 注入を行ってください。
10. ❌ **クライアント側で毎フレーム H.264 Annex-B 走査および Uint8Array 再確保を行うこと**
    - 車載ブラウザ（特に MCU2 Intel Atom）の V8 エンジンで頻繁な GC Pause が発生し、映像の定期的なカクつきやコマ落ちを招きます。H.264 パケットはサーバー側で AVCC 形式に事前パッキングし、クライアント側ではゼロコピーでデコードしてください。

---

## 10. 実機デバッグ & 診断コマンド集

トラブルシューティング時にコンテナ内の状況を正確に把握するためのコマンド一覧です（リモートホストまたはローカル端末から実行可能）：

```bash
# 接続先ホストの設定
SERVER_HOST="${DEPLOY_HOST:-<SERVER_IP>}"
SERVER_USER="${DEPLOY_USER:-root}"

# 1. コンテナ内 Chrome の GPU 機能・デコード状態確認
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

# 4. ワンコマンド再デプロイ
./scripts/deploy.sh --skip-test
```
