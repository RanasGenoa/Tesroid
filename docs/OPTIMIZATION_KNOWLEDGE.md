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
  │      - 映像再生: VAAPI ハードウェアデコード (Intel iHD/i965, AMD radeonsi via $VAAPI_DEVICE; DRI不在時は自動SWデコード)
  │      - 2D DOM描画: Chromeネイティブ SIMD 高速CPUラスター (Mesa llvmpipe競合回避)
  │
  ├── 4. Virtual Display & Audio
  │      - Xvfb (:99, 1920x1080x24) + Openbox (枠なし: decor=no)
  │      - PulseAudio (virtual_sink: 48kHz stereo s16le, 20ms lowdelay)
  │
  ├── 5. FFmpeg Dual Encoders (ENCODER_MODE=auto|vaapi|software)
  │      - Video: x11grab -> (hwupload,scale_vaapi=format=nv12 / format=nv12,hwupload -> h264_vaapi) or libx264 fallback (ultrafast, zerolatency, B-frame 0)
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
2. 同時に動画デコードは VAAPI (`${VAAPI_DEVICE}`, 例: `/dev/dri/renderD128`) でハードウェア処理されます（DRI デバイスが存在しない環境では Chrome が自動的にソフトウェアデコードへフォールバックします）。
3. `--enable-zero-copy`（ゼロコピー GpuMemoryBuffer）が Xvfb の共有メモリと VAAPI サーフェス間でバッファ共有を試みますが、DMA-BUF 互換性がなく同期ロック待機でストールします。
4. `--disable-gpu-vsync` により VSync タイマーが消失し、Chrome の **Viz ディスプレイコンポジタスレッドがデッドロック**。
5. 結果として、動画クワッド（オーバーレイ）のみが一度描画された後、X11 への `SwapBuffers` / `PostSubBuffer` が停止し、動画外の領域が再描画されず黒いまま固まりました。

### 解決策: 「ハイブリッド描画アーキテクチャ」
動画デコードと 2D DOM 描画の役割を明確に分離しました：

| 描画対象 | 処理担当 | 使用技術 / フラグ |
| :--- | :--- | :--- |
| **動画デコード** (YouTube VP9/H.264) | **GPU VAAPI (Intel/AMD・不可時は自動SW)** | `--enable-features=AcceleratedVideoDecodeLinuxGL,VaapiIgnoreDriverChecks` + `--render-node-override=${this.vaapiDevice}` |
| **2D DOM / テキスト / レイアウト** | **Chrome 高速 CPU ラスター** | デフォルト Skia CPU（AVX2/SIMD 最適化） |
| **AV1 ソフトウェアデコード** | **無効化 (ハードウェア優先)** | `--disable-features=Av1Decoder,AudioServiceSandbox,Translate` |

```typescript
// server/src/browser/manager.ts - 黄金の安定起動フラグ構成 (Chrome 131+ / Ubuntu 24.04)
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
  // Hardware video decode via VAAPI (Intel iHD/i965, AMD radeonsi) with graceful SW fallback when DRI absent
  '--enable-features=AcceleratedVideoDecodeLinuxGL,VaapiIgnoreDriverChecks',
  `--render-node-override=${this.vaapiDevice}`,
  // CRITICAL: Disable AV1 software decode so YouTube automatically serves hardware-accelerated VP9/H.264
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
> **マルチ GPU / `/etc/libva.conf` / Windows D3D12 (`GALLIUM_DRIVER`) に関する重要事項**:
> - `libva` は環境変数 `LIBVA_DRIVER_NAME` より `/etc/libva.conf` を優先するため、`/etc/libva.conf` には `LIBVA_DRIVER_NAME` を直書きせずコメントのみを維持します（`Ubuntu 24.04` ベースイメージ上で `iHD` / `i965` / `radeonsi` / `d3d12` を動的に切り替え可能にするため）。
> - Windows Docker Desktop / WSL2 環境では `GALLIUM_DRIVER=d3d12` を Chrome プロセスへグローバル付与しません（Chrome は Xvfb 上で安定した CPU Skia + `llvmpipe` を維持し、DRI 不在時は自動的にソフトウェアデコードへフォールバックします）。`GALLIUM_DRIVER=d3d12` は FFmpeg の `d3d12` VAAPI プローブ・起動時のみにスコープし、`VAProfileH264` + `VAEntrypointEncSlice` 非対応時は `ENCODER_MODE=auto` で `libx264`（`-preset ultrafast -tune zerolatency -bf 0`）へ自動フォールバックします。

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

### 追加最適化: 弱電波向け 30秒先読みバッファ & CATCHUP フロー制御 (Issue #56)
車載 LTE のトンネル・地下駐車場などの長時間弱電波環境に備え、クライアント側 `targetBufferMs` の上限を 30 秒（`0〜30000ms`）まで拡張しています。
- **サーバー側リングバッファ (`PlaybackBuffer`)**: UI 最高画質プリセット（60fps / 2Mbps 映像 + 128kbps 音声）で 30 秒分は約 8 MB（60 秒で約 16 MB）、API/環境変数で高ビットレート（最大 10Mbps）を設定した場合のヘッドルームを含め、`PLAYBACK_BUFFER_MAX_BYTES` の既定値を **48 MB**（`bufferSeconds=60s`）に設定しています。
- **CATCHUP 送出キュー上限 (`session.playbackQueue`)**: 60fps 映像 + 50pps（20ms）Opus 音声の混在時は毎秒 **110 フレーム**（30 秒で 3,300 フレーム、60 秒で 6,600 フレーム）に達するため、キュー上限を **6,600 フレーム** に設定し、30 秒リカバリ時の GOP 途中破棄を防いでいます。
- **オートスリープ時のクリア**: `autoSleep` 発動時（`encoder.stop()` + `browserManager.pause()`）に `PlaybackBuffer` をクリアし、復帰時にスリープ前の古いフレームが誤送出されるのを防止しています。

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

### 関連対策 (Issue #44): パスワード保存・自動サインイン・漏洩検知・自動入力 Views Bubble の抑止

#### 現象・原因
Google ログインや各種 Web フォームの送信時に、Chrome ネイティブの **パスワード保存確認バブル（「Save password?」）**、自動サインイン通知、パスワード漏洩警告、住所/クレジットカード自動入力バブルが表示されることがある。
これらはいずれも WebAuthn ダイアログと同様に Chrome ブラウザ側のネイティブ UI（**Views Bubble**）として描画されるため、`CdpTouchBridge` による DOM 向け `Input.dispatchTouchEvent` が一切届かず、車載画面からタップして閉じることができない（画面上部に居座り続け、操作を阻害する）。さらに Linux / Xvfb コンテナ環境では OS キーリングが存在せず、認証ストア初期化時のプロンプト要因にもなる。

#### 解決策: `applyChromePreferences()` と `--password-store=basic`
`BrowserManager`（`server/src/browser/manager.ts`）の起動前プロファイル設定および起動引数で、これらネイティブバブルの出現経路を根本から抑止する：

1. **`BrowserManager.applyChromePreferences()`** (`Default/Preferences` および存在時は `Preferences` の両方に適用、既存の `profile.exit_type` / `profile.exited_cleanly` 等はスプレッド構文で保持):
   - `credentials_enable_service: false`: パスワード保存確認バブル・資格情報保存サービスを無効化。
   - `credentials_enable_autosignin: false`: Credential Management API による自動サインインバブルを無効化。
   - `profile.password_manager_enabled: false`: Chrome パスワードマネージャー自体を無効化。
   - `profile.password_manager_leak_detection: false`: パスワード漏洩検知ダイアログを無効化。
   - `autofill.profile_enabled: false` / `autofill.credit_card_enabled: false`: 住所・クレジットカード情報の保存/自動入力バブルを無効化。
2. **`BrowserManager.buildChromeArgs()`**:
   - `'--password-store=basic'` を付与し、Linux / Xvfb 環境での OS キーリングプロンプトや資格情報ストア由来のネイティブダイアログを抑止する。
   - `--disable-features=Av1Decoder,AudioServiceSandbox,Translate` など既存の VAAPI / 音声 / 翻訳抑止フラグおよびハイブリッド描画方針はそのまま維持する。

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

## 8-B. 課題⑧: NAS・カスタム Linux カーネル環境におけるコンテナパッケージ更新時のシステムコール非互換と防止ガードレール (Issue #93)

### 現象
QNAP TS-453D（QTS 5.2.8 / Container Station / Linux 5.10 系カスタムカーネル）環境において、コンテナベースを Ubuntu 22.04 から Ubuntu 24.04 (Noble) へ刷新した `v0.7.0` 以降、`docker compose up -d --build` の `apt-get install` ステップで `systemd` パッケージの設定（`dpkg --configure systemd`）が以下のエラーで失敗し、ビルドが停止する事象が発生した：

```text
fchmod() of /etc/credstore.encrypted failed: No such file or directory
Creating group 'systemd-journal' with GID 999.
Failed to copy permissions from /etc/group to /etc/.#group...: No such file or directory
dpkg: error processing package systemd (--configure):
  installed systemd package post-installation script subprocess returned error exit status 1
```

### 根本原因のメカニズム
1. **Ubuntu 24.04 における暗黙的な `systemd` 依存チェーンの変化**:
   - `pulseaudio` の依存ツリー（`pulseaudio` ➔ `libsnapd-glib-2-1` ➔ `libsoup-3.0-0` ➔ `glib-networking` ➔ `gsettings-desktop-schemas` ➔ `dconf-gsettings-backend` ➔ `dconf-service`）において、`dconf-service` は `default-dbus-session-bus | dbus-session-bus` に依存している。
   - APT が第1候補の `default-dbus-session-bus`（実体は `dbus-user-session`）を自動選択したことで、`dbus-user-session` ➔ `libpam-systemd` ➔ `systemd` + `libsystemd-shared` + `systemd-sysv` がコンテナ内に暗黙的に引き込まれた。
2. **新世代ユーザーランド（`systemd` v255 / `glibc` 2.39）とホスト Linux カーネルのシステムコール非互換**:
   - Ubuntu 24.04 の `libsystemd-shared-255.so` 内の `fchmod_opath()`（`systemd-tmpfiles` および `systemd-sysusers` が使用）は、Linux 6.6 で新規導入されたシステムコール **`fchmodat2(fd, "", mode, AT_EMPTY_PATH)`（syscall 452）** を空文字列パス `""` で直接発行する。
   - `fchmod_opath()` の実装は、カーネルが未対応の場合に `ENOSYS` (38) または `EPERM` (1) が返ることを前提として `/proc/self/fd/<fd>` の `chmod()` へフォールバックする分岐しか持っていない。
   - しかし、QNAP QTS のカスタムカーネル / Container Station 環境では空パス引数に対して **`ENOENT` (2: `No such file or directory`)** が返却されるため、フォールバック処理に到達せず即座にエラー終了していた。

### 解決策 & 今後のコンテナパッケージ更新時のガードレール（ホストカーネル非依存・ポータビリティ原則）
Tesroid は **「特定の Linux カーネルバージョンやディストリビューションに極力依存せず、幅広いホスト環境（標準的な Linux、QNAP / Synology / TrueNAS / Unraid 等の NAS OS、旧世代 LTS カーネル、Windows Docker Desktop / WSL2 等）でそのまま動作すること」** を重視している。
単一プロセスツリー（Tini + Node.js）で動作する Tesroid コンテナにはホストカーネルと密結合する `systemd` や `dbus-user-session` は一切不要であり、将来他のパッケージ更新でも同様の「特定カーネル依存のシステムコール非互換」を引き込まないよう、以下の **3重のガードレール** を設ける：

1. **仮想パッケージの非 systemd 代替明示（`dbus-x11`）**:
   - `Dockerfile` の `apt-get install` に `dbus-x11`（`Provides: dbus-session-bus`）を明示指定し、`dconf-service` の `default-dbus-session-bus | dbus-session-bus` 依存を `systemd` 非依存の X11 D-Bus で解決する。これにより `dbus-user-session` / `libpam-systemd` / `systemd` / `libsystemd-shared` は一切インストールされない。
2. **APT Pinning (`/etc/apt/preferences.d/no-systemd`) による混入の強制ブロック**:
   - `systemd`, `systemd-sysv`, `systemd-standalone-sysusers`, `systemd-standalone-tmpfiles`, `libpam-systemd`, `dbus-user-session`, `udev` を `Pin-Priority: -1` に設定し、将来 `Dockerfile` に新規パッケージを追加した際や Ubuntu リポジトリ側の依存関係変更時にも、APT ソルバがこれらを選択することを強制禁止する。
3. **ベースイメージ更新・パッケージ追加時の事前監査ルール**:
   - Docker コンテナは **ホスト OS の Linux カーネルを共有** するため、コンテナ内のディストリビューション（Ubuntu 24.04 等）を新しくすると、ユーザーランド（`glibc`, `systemd`, `util-linux`, `coreutils` 等）が新しい Linux カーネル（6.x+）固有のシステムコール（`fchmodat2`, `openat2`, `clone3`, `mount_setattr`, `close_range`, `epoll_pwait2` 等）を発行し、NAS（QNAP / Synology / TrueNAS 旧版）や LTS カーネル（5.4 / 5.10 / 5.15）のカスタムカーネル・古い seccomp プロファイルで非標準の errno（`ENOENT`, `EINVAL`, `EFAULT`）を返してクラッシュするリスクが常にある。
   - `Dockerfile` のパッケージを変更・追加する際は、必ず以下を確認すること：
     - `apt-get install -s --no-install-recommends ...` のドライラン出力で、意図しないシステム管理デーモン（`systemd*`, `udev`, `polkitd`, `snapd` 等）が引き込まれていないか確認する。
     - 追加パッケージの `/var/lib/dpkg/info/<pkg>.{preinst,postinst}` スクリプトを検査し、`systemd-sysusers` や `systemd-tmpfiles` 等のホストカーネル依存ヘルパーを無条件実行していないか確認する。

---

## 8-C. 課題⑨: モバイル回線での CATCHUP 自己輻輳・LIVE ジャンプ後の A/V 固定オフセット・RTT 計測の意味 (Issues #103〜#107)

2026-11-25 のモバイル回線車載視聴で同時多発した 3 症状（FPS 急落+WAIT、通信回復でも直らない音ズレ、接続待機モーダルの連続表示）の調査に基づく設計知識。詳細な時系列ログは非公開インシデントレポートに記録。

### A/V 固定オフセットの真因: LIVE ジャンプ後の straggler 音声 (Issue #103)
- `JUMP_TO_LIVE` でクライアントは映像・音声キュー・再生済みソースをすべてフラッシュできるが、**ジャンプ前にサーバーが送信済みでソケット/リンク経路上を漂流中の古い音声フレーム（straggler）**が到着後、ゼロギャップスケジューリング（`audio-player.ts` の `nextPlayTime` 連結）でライブ音声の後ろに ~2 秒分そのまま再生予定に載り、**映像に対し音声が約 2 秒遅延する固定オフセット（`videoPts - playingAudioPts > 0`）**が発生する。音声はマスタークロック（`playbackRate=1.0` 固定）のため、映像側 frame-pacer の slew 上限（±2.0ms/frame）では分単位でしか収束せず「通信が回復しても元に戻らない」ように見える。
- 対策: **ライブエッジ PTS バリア**。ジャンプ時に (1) PONG ペイロードの `latestPts` からの実時間外挿（またはフラッシュ前の `lastDecodedPts` / `getLastKnownPtsUs()`）で暫定バリアを設定し、(2) サーバーが `LIVE_JUMPED.dropAudioBeforePts`（ジャンプ時点の `encoder.getCurrentPts()`、Auto-Hybrid / `isInteractive` 切替時も送出）を権威値として送る。`setLiveEdgeBarrier` は TCP FIFO 順序により `LIVE_JUMPED` 到達前にすでに滑り込んでいた straggler キュー/スケジュールも検出して即パージし、`playAudioData` 側でも非同期 `AudioDecoder` 出力に残った straggler を遮断する。TTL 5 秒の自動失効と、バリア以上フレーム到達時の即時解除、ストリーム再構築・停止時の明示クリアで、過剰破棄が恒久化しない。

### CATCHUP バーストのリンク認識 (Issue #104)
- バースト送出は 1x の約 4.5 倍の要求を発生させ、中間バッファ（モバイルの中継機器は BDP が数 KB〜十数 KB 級）へ詰め込むため、**自己輻輳で実効スループットが半分近くに低下**しうる（bufferbloat）。
- 対策 1: ACK / BUFFER_FEEDBACK の再生 PTS 進行度（250ms〜5000ms 窓、単調クロック）から**実効排水レート（EWMA）**を推定し、0.85x 未満のリンクでは in-flight 窓を `targetBufferMs × rate`（下限 2.5 秒）へ縮める。健全な回線・サンプル未収集時は従来窓のまま（非回帰）。
- 対策 2: 連続ソケット詰まり（`catchupCongestionStreak >= 3`）または低排水レート（`< 0.85x`）で輻輳を検知した場合のみ、CATCHUP のソケットガードを 128KB からリンク帯域連動の 32KB〜64KB へ引き下げ、バースト送出間隔を 2ms → 10ms へ緩和する（健全時および LIVE モードの GOP ドロップ・ヒステリシスは不変）。
- 対策 3: CATCHUP キューのスパンが **先行バッファ深度の 2 倍（最低 30 秒）**を超えたら最古 GOP を安全に間引き、無限キャッチアップ（実測: 872 フレーム分が約 2 分未完）を防ぎつつ、Issue #26 / #56 の 25〜30 秒無欠落復旧を破壊しない。
- 効果検証は `/api/metrics/history` の A/B（tc netem または実測回線）で行うこと。

### RTT 計測の意味と限界 (Issue #105)
- RTT は PING/PONG 制御メッセージの往復であり、**映像・音声と同一 WebSocket を共有するためメディアキュー後方滞留を必ず含む**。CATCHUP バースト中は `serverMode`/`catchupQueueMs` による汚染ガード（Issue #24 実装済み）で破棄できるが、PONG 自体が経路上で滞留すると**最後の計測値が凍結**して HUD・METRICS に再現される（実測: 531ms × 4 窓）。また接続直後から CATCHUP だった場合（`minRtt` 未確立時）に汚染 `rawRtt` を採用しないよう `Number.isFinite(minRtt)` ガードを適用し、汚染・凍結中の値を `AdaptiveJitterController` へ流さない。
- ガード: 有効サンプル採用時刻を保持し、5 秒超過で `instantRtt` を鮮度切れとして破棄（HUD は「接続中」、メトリクスは 0 = 未計測を 1 回報告）。再接続（`open`）およびストリームリセット時は鮮度状態も初期化する。**メトリクスの RTT 列は「制御メッセージ往復 = 媒体滞留を含む値」であり純ネットワーク RTT とは限らない**ことを解析時に前提とすること。

### バッファアカウンティングの単一正典 (Issue #106)
- 従来 `BUFFER_FEEDBACK.bufferedMs` は映像経路（デコーダ pending + frame-pacer）のみで、音声キュー滞留がサーバーの in-flight 計算から欠落していた。HUD 遅延表示側には音声を含む集計があり**二重定義**になっていた。
- 現在: クライアントは `getVideoPathBufferedMs()` / `getAudioPathBufferedMs()` の正典関数で HUD 表示・報告を統一し、`audioBufferedMs` を別フィールドで報告（旧サーバーは無視 = 後方互換）。サーバーの `getClientInFlightBufferMs()` は `max(pts in-flight, 映像報告, 音声報告)` を採用。

### 背圧由来 CATCHUP の永久滞留 (Issue #109)
- 旧実装はアイドル視聴中の LIVE 配信で `bufferedAmount > 512KB` を検知するとフレームを破棄せず CATCHUP キューへ蓄積する経路（`transitionLiveSessionToCatchup`）を持っていたが、TrueNAS 実機リグレッション（2026-11-26、PR #108 断面）で**この経路が二度と LIVE へ復帰しない**ことを確定した。移行時点でクライアントのジッターバッファは `targetBufferMs` で満杯のため、送出ゲート `getClientInFlightBufferMs() < effectiveCatchupWindowMs` が閉じたままとなり、送信はライブ等速ぶんだけ再開する定常状態に落ちる（キュー排水速度 ≈ 0）。backlog cap（GOP 3フレーム/2秒）は追いつかず churn 化し、配信遅延 ~1分と A/Vオフセット ~2秒が恒久化する（インシデント 2026-11-25 の「通信回復でも直らない」症状の真因。実測: `queue empty. Transitioning to LIVE` 全期間 0件、Pruned 3,205件）。
- 削除は #104 の導入回帰ではなくそれ以前の構造問題。対照に**再接続/resume 由来の CATCHUP は正常**（クライアントバッファ空から開始するため排水が完了し、cap 内で間引かれながら drift 70ms まで収束。25秒トンネルで Pruned 0件の追随を実証済み）。
- 現在: LIVE 中のソケット詰まりは高低ヒステリシス（HIGH/LOW 水位 GOP スキップ）へ一元化し、通信回復で即時復帰する。CATCHUP キューは「クライアントが後方になった場合」（再接続/resume）専用。リアルタイム配信ではリンクが生成速度を運べずクライアントバッファも満杯なら余剰フレームはどこかで必ず破棄される — 破棄地点をサーバーキュー蓄積に移すと「破らない」ことはできず、遅延として現れるだけになる。

### 極端輻輳後の遅延恒久化と Buffer-Hold Pause (Issue #111)
- Issue #109 の修正後も、TrueNAS f1check ラン（2026-11-26）で**極端輻輳（HTB 500kbit 12分）直後の再接続時に backlog 2,476フレーム ≈ 98秒を抱えた CATCHUP が 14分間横ばい**（`queue empty. Transitioning to LIVE` ゼロ、GOP prune churn のみ）を観測した（F-3）。原因は「生成 1.0x > 送信 1.0x」の均衡で、CATCHUP の送出ゲートだけでは残余を縮められない構造問題だった。
- **Buffer-Hold Pause (Phase 1)**: サーバーがクライアント再生位置より先に保持する時間 `serverHeldMs = playbackBuffer最新映像PTS − lastKnownAckPts` が `holdTriggerMs = clamp(targetBufferMs, 10s, 30s)`（target=0 は無効）以上で**生成側を 0.0x に止める**（Chrome ツリー SIGSTOP + FFmpeg 停止。BROWSER_STATUS は `running` を維持しスリープ `paused` とは独立状態）。消費 1.0x の ack 追い上げで `resumeTriggerServerMs = target ≥ HEADROOM ? 500ms : max(1000, HEADROOM − target)`（HEADROOM: VAAPI 2s / software 3s）以下へ収まると自動再開（SIGCONT + FFmpeg restart、PTS は停止時間分を減算して単調連続、最初の Video IDR まで先行音声をサーバー側で破る A/V 境界ゲート 1500ms）。
- **守るべき不変条件**: `holdTrigger − resume ≥ 7.2s`（ヒステリシス幅。`computeHoldConfig()` が機械的に保証）/ `PLAYBACK_BUFFER(60s) ≥ backlog cap > holdTrigger` / autoSleepTimer と holdExpireTimer（既定10分、満了で SLEEP_PAUSED 共通フローへ合流）の同時稼働ゼロ / Hold 中の背景 CDP ポーリング停止（凍結 renderer へのタイムアウト防止）。
- **再接続 resumeFromPts クランプ**: 高RTT で陳腐化した `lastAckPts` のまま CATCHUP を開始すると backlog が cap に収まらないため、再開位置を `max(lastAckPts, latestBuffered − holdTriggerMs)`（直前 KEYFRAME スナップ）へクランプする。F-3 の ~98 秒 backlog はこの補正で holdTrigger 以下に収まる。
- **割り込み意味**: タッチ/JUMP_TO_LIVE/NAVIGATE 系は `recordInputActivity` 経由で即時解除（LIVE_JUMPED の音声バリアは既存経路）、手動 PAUSE_BROWSER は Hold→スリープの排他変換（SIGCONT + restart のチャーンを経由しない）。HUD は PONG の `holdPaused` と `BUFFER_HOLD` 制御で `HOLD L:…s S:…s` を表示し、タップで即 LIVE 同期。
- **F-4 ガード: 復帰後 A/V 境界は PTS 基準（±1s の音声先行抑止）**: 復帰ゲート (`armResumeGate`) の時間項 (8000ms) は「再起動後に IDR が一度も来ない」場合の安全弁に限定し、本来の境界は**復帰後最初の Video IDR の PTS**（`resumeBoundaryPtsUs`）で決め、その PTS 未満の音声パケットは送出前に破棄する。時間ゲートのみ（旧1500ms）では FFmpeg 再起動後の IDR が期限より遅れて届いた分だけ先行音声が混ざり、Hold サイクル経過後の窓に ±0.4〜1.4s の A/V オフセット残留が実測された（f1check 2026-11-26、F1_D_rec +1.4s×15分横ばい）。IDR 再送を伴わない LIVE ジャンプではライブエッジ PTS を同一境界として即設定（`setResumeBoundary`）し、クライアントの `dropAudioBeforePts` バリアと二重で straggler 音声を抑止する。PTS エポックが切り替わる完全リスタート (`restartAll`) では境界を消去。
- **F-1b（backlog ms 桁異常）の根因修正**: `PlaybackBuffer.addVideo/addAudio` が CONFIG パケット（pts: 0n）をフレーム配列へ混入させ、`getBufferedDurationMs()` と GOP prune の PTS エポックを汚染していた（実測 `2,353,603ms` 表記 vs 実 ~1,570フレーム）。CONFIG はメタキャッシュ（cachedSpsPps/cachedOpusHead）のみ更新し、再接続時は `getFramesToCatchup()` の `configVideo/configAudio` で再送する。クライアント側も同一 OpusHead の再送で音声ジッターバッファを捨てない（冪等スキップ）。

### 診断ログ (Issue #107)
- CATCHUP 開始（再接続/resume 経路）で `targetBufferMs=` と `burst=` をログ出力。実効ウィンドウはクライアント localStorage 由来でサーバーには永続化されないため、**インシデント解析ではこのログが唯一の実効値証拠**になる。

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
11. ❌ **`FramePacer` の空キュー時即時描画パスでリップシンク PLL シフトを破棄すること**
    - `AudioPlayer` は Web Audio API の音途切れ防止のため 160ms のジッターバッファを持っています。`FramePacer` でキューが空の際に到着時刻 `now` に即時描画して `lastScheduledTimeMs = now` で時刻をリセットすると、PLL 補正が一切蓄積されず、映像が音より恒常的に ~160ms 先行する固定音ズレが発生します。キューが空であっても音声再生 PTS との差分から PLL シフトを算出し、`lastScheduledTimeMs = scheduledRenderTime` を維持してスケジュールを累積収束させてください。
12. ❌ **Chrome のパスワード保存・自動入力 Views Bubble 抑止設定 (`applyChromePreferences` / `--password-store=basic`) を削除すること (Issue #44)**
    - パスワード保存確認（「Save password?」）、自動サインイン、漏洩検知、自動入力の各バブルはすべて Chrome ネイティブ UI（Views Bubble）であり、`CdpTouchBridge` による DOM タッチ入力ではタップして閉じられません。`applyChromePreferences()` での `credentials_enable_service` / `credentials_enable_autosignin` / `profile.password_manager_enabled` / `profile.password_manager_leak_detection` / `autofill.profile_enabled` / `autofill.credit_card_enabled` の無効化、および `--password-store=basic` を必ず維持してください（あわせて `cleanProfileLocks()` が設定する `profile.exit_type` / `exited_cleanly` を上書き破壊しないこと）。
13. ❌ **クライアント側 (`client/`) で物理キーボードやマウス操作を前提とした機能・UI を実装すること**
    - テスラ車載ディスプレイは完全タッチオンリー環境であり、物理キーボードやマウスは接続・操作できません。`Escape` キーによるモーダル閉じ、キーボードショートカット、`keydown` リスナーへの依存、`hover` 前提 UI、右クリックメニュー、マウスポインタ前提ドラッグなどを `client/` に実装してはなりません。リモート文字・キー入力はすべてタッチ操作可能な HUD 仮想キーボード `<input>` 経由の CDP 注入で完結させてください。
14. ❌ **`Dockerfile` から `dbus-x11` や `/etc/apt/preferences.d/no-systemd` を外し、コンテナ内に `systemd` / `libsystemd-shared` / `dbus-user-session` を引き込むこと (Issue #93)**
    - QNAP QTS（Linux 5.10 系）等の NAS カスタムカーネルや古い seccomp 環境では、Ubuntu 24.04 の `systemd` v255 (`libsystemd-shared`) が使う Linux 6.6+ システムコール（`fchmodat2(..., AT_EMPTY_PATH)`）に対して `ENOSYS` ではなく `ENOENT` が返り、`systemd.postinst`（`systemd-tmpfiles` / `systemd-sysusers`）が失敗して Docker ビルドが停止します。パッケージ追加時は常にホストカーネル互換性と `postinst` の挙動を監査してください。

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

# 4. VAAPI 診断 & エンコーダバックエンド確認
ssh "${SERVER_USER}@${SERVER_HOST}" \
  "curl -s http://127.0.0.1:9001/api/health && echo '' && docker exec tesroid-server vainfo --display drm --device \${VAAPI_DEVICE:-/dev/dri/renderD128}"
```

---

## 11. テスラ車載ブラウザのディスプレイ仕様・実測値 & ローカルデバッグ再現手順

Issue #53 の実機ログ調査およびコミュニティの実測知見（Tesla Motors Club / Tesla-Lyrics / iCar 等）から得られた、テスラ車載ブラウザ（MCU / Chromium）の表示・DPR 仕様とローカル PC での再現手順です。

### 車載ブラウザの DPR・解像度仕様

- **DPR の変化点（SW 2026.26 世代）**:
  - テスラ車載ブラウザにはユーザーによるズーム操作が存在せず、**UI 設定やウィンドウ表示状態では DPR は変化しません**（変わるのは CSS キャンバス寸法のみ）。
  - 既知の変化点は **Tesla Software 2026.26（Chromium 140 → 148）** での **`devicePixelRatio` 1.0 → 約 1.53** への変更です。
  - 物理パネル解像度 `1920×1200` に対し、SW 2026.26 以降の CSS 画面全体は `1254×784`（`1920 / 1.53 ≒ 1254.9`）となります。
- **実機実測値（Tesla Model 3 / SW 2026.26 以降）**:
  - **小窓表示（主対象）**: CSS `773×553` / `DPR 1.53` → サーバー実効フレーム `1160×830`
  - **全画面相当（コンテナ）**: CSS `1256×659` / `DPR 1.53` → サーバー実効フレーム `1256×658`（※ HUD 48px 分を差し引いたビューポート）
  - **全画面（画面全体参考値）**: CSS `1254×784` / `DPR 1.53`
  - **SW 2026.26 以前**: CSS `1920×1200` / `DPR 1.0`

### 設計上の留意点

- **主対象は小窓（`773×553` CSS / `DPR 1.53`）**: 車載実用時は全画面ではなくマップ等と並べる小窓表示が主となるため、UI・文字視認性・エンコード解像度は小窓を基準に最適化します。
- **DPR 値の非ハードコード**: 将来のファームウェア更新で DPR が再び変化する可能性があるため、`1.53` を固定値として直書きせず、物理ピクセル（`screen.width × devicePixelRatio`）やサーバー側リサイズ計算で吸収します。
- **複数クライアント混線への注意**: デバッグ用 PC（macOS Chrome 等）を接続したままスリープ・放置すると、バックグラウンドの自動再接続により別解像度（例: `774×690 / DPR 2.50`）のリサイズ要求が飛び、車載側のエンコーダ再起動や表示乱れを引き起こします（Issue #53 / #54 / #58）。実車検証時はデバッグ用ブラウザタブを閉じておくこと。

### ローカル PC（Chrome）での実車環境再現手順

ローカル開発時にテスラ車載ブラウザの解像度・DPR を再現するには、Chrome DevTools のデバイスエミュレーションを使用します（起動フラグ `--force-device-scale-factor=1.53` でも近似可能ですが、DevTools 方式の方が CSS 寸法を正確に再現できます）。

1. Chrome で Tesroid クライアントを開き、`F12`（または `Cmd+Opt+I`）で DevTools を開く
2. デバイスツールバー（`Cmd+Shift+M`）を有効化し、上部プルダウンから **Edit... → Add custom device...** を選択
3. 以下のプロファイルを追加して切り替える：

| 再現対象 | Width × Height (CSS px) | Device pixel ratio | 備考 |
|---|---|---|---|
| **小窓（主対象）** | `773 × 553` | `1.53` | サーバー実効 `1160×830` |
| **全画面（コンテナ）** | `1256 × 659` | `1.53` | サーバー実効 `1256×658` |
| **全画面（画面全体）** | `1254 × 784` | `1.53` | SW 2026.26 以降参考値 |
| **旧世代（2026.26 以前）** | `1920 × 1200` | `1.0` | レガシー互換確認用 |

DevTools コンソールで `devicePixelRatio` / `innerWidth` / `innerHeight` / `screen.width` を評価し、意図した値になっていることを確認してデバッグを行ってください。

