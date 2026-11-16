---
title: "[Feature]: サーバー側パフォーマンス調整機能の追加（Intel UHD 600等の省電力iGPU向け軽量化）"
issue: "#46"
labels: ["enhancement", "server", "encoder"]
---

# サーバー側パフォーマンス調整機能 設計書 (Issue #46)

## 1. 提案の概要

Intel UHD Graphics 600（Gemini Lake 世代 / 12EU・Celeron J4105 / J4125 / N4000 / N4100 等）のような省電力 iGPU・省電力 CPU 環境でも安定して低遅延ストリーミングを行えるよう、サーバー側の解像度上限・VAAPI エンコード負荷・パフォーマンスプリセットを動的に調整できる機能を追加します。

---

## 2. 解決したい課題 / ボトルネック分析

開発基準環境である Intel UHD Graphics 630（24EU）では余裕をもって動作する設定が、UHD Graphics 600 等のエントリー向け iGPU・CPU 環境では以下の理由によりボトルネックとなります。

1. **動的リサイズの上限が `1920x1080` に固定されている（`maxSize` 未適用）**
   - `server/src/config.ts` の `StreamConfig` には `maxSize: 1280` が定義されているが、`server/src/ws/handler.ts` の `handleResizeMessage()` では `Math.min(1920, effW)` / `Math.min(1080, effH)` がハードコードされている。
   - クライアント画面が大きい場合、起動時の `1280x720` から自動的に 1080p 付近まで拡大され、ピクセル数（約 2.25 倍）に比例してキャプチャ・色空間変換・エンコード負荷が急増する。
2. **`h264_vaapi` のエンコード品質パラメータが固定**
   - `server/src/encoder/ffmpeg.ts` で `-compression_level 4` が固定指定されており、EU（Execution Unit）数が少ない iGPU ではシェーダーベースのエンコード負荷が重くなりやすい。
   - Intel iHD ドライバがサポートする固定機能低電力エンコーダ VDEnc（`-low_power 1`）を指定する手段がない。
3. **CPU 側での RGB → NV12 色空間変換負荷**
   - `x11grab` の出力に対して `-vf format=nv12,hwupload` を使用しており、CPU 上で全ピクセルの RGB→NV12 変換を行ってから GPU へ転送している。省電力 Celeron 系 CPU では Chrome の CPU ラスター（Skia SIMD）処理と CPU リソースが競合しやすい。
4. **設定 UI からの映像負荷調整手段の欠如**
   - `client/src/views/settings-modal.ts` には `displayScale` / `bufferDepth` / `audioBitrate` のみが存在し、解像度上限・FPS・ビットレート・軽量モードを UI から変更できない。

---

## 3. 詳細設計

### 3.1 設定スキーマ拡張 (`server/src/config.ts`)

`StreamConfig` を拡張し、パフォーマンスプリセットおよび VAAPI エンコーダ制御パラメータを追加します。

```typescript
export type PerformancePreset = 'balanced' | 'low_power' | 'custom';

export interface StreamConfig {
  bitrate: number; // bps (例: 1000000 = 1Mbps)
  maxFps: number; // 例: 30
  maxSize: number; // 長辺上限 px (例: 1280, 960, 1920)
  audioBitrate?: number; // bps (128000 - 320000)
  performancePreset?: PerformancePreset; // デフォルト: 'balanced'
  vaapiCompressionLevel?: number; // 1(高品質/重) 〜 7(最速/軽)、デフォルト: 4
  vaapiLowPower?: boolean; // -low_power 1 有効化、デフォルト: false
}
```

#### プリセット定義

| プリセット名 | 想定環境 | `maxSize` | `maxFps` | `bitrate` | `vaapiCompressionLevel` | `vaapiLowPower` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `balanced` (標準) | UHD 630 等の標準 iGPU | `1280` | `30` | `1000000` (1Mbps) | `4` | `false` |
| `low_power` (省電力・軽量) | UHD 600 等の省電力 iGPU / Celeron | `960` (または `1280`) | `24`〜`30` | `800000` (800kbps) | `6`〜`7` | `true` (非対応時は自動フォールバック) |
| `custom` (カスタム) | ユーザー任意指定 | ユーザー指定 | ユーザー指定 | ユーザー指定 | ユーザー指定 | ユーザー指定 |

#### 環境変数による初期値上書き (`docker-compose.yml` / `.env`)
- `VAAPI_COMPRESSION_LEVEL`（`1`〜`7`）
- `VAAPI_LOW_POWER`（`true` / `false`）
- `STREAM_MAX_SIZE`（例: `960`, `1280`, `1920`）

---

### 3.2 動的リサイズの上限適用 (`server/src/ws/handler.ts`)

`handleResizeMessage()` 内で `configStore.getConfig().stream.maxSize` を参照し、アスペクト比を維持したまま長辺（`width`）が `maxSize` を超えないようスケーリングおよびクランプを行います。

```text
要求解像度 (effW, effH)
  │
  ▼ maxSize = config.stream.maxSize (例: 1280, 範囲: 640..1920)
  ├─ effW > maxSize の場合:
  │     scale = maxSize / effW
  │     effW = maxSize
  │     effH = Math.round(effH * scale)
  │
  ▼ VAAPI / H.264 マクロブロック整合アライメント
  width  = clamp(effW, 640, maxSize) & ~7  (8の倍数)
  height = clamp(effH, 360, 1080)    & ~1  (2の倍数)
```

- 設定画面から `maxSize` が変更された場合は、現在接続中のクライアントの直近要求サイズ（または現在の `width/height`）に対して即座に再計算し、`browserManager.resize()` および `encoder.updateConfig()` をトリガーします。

---

### 3.3 FFmpeg VAAPI エンコーダの拡張 (`server/src/encoder/ffmpeg.ts`)

1. **`-compression_level` の動的指定**
   - ハードコードされていた `'4'` を設定値（`1`〜`7` の範囲でクランプ）に置き換えます。
   - Intel iHD の `h264_vaapi` では数値を上げる（`6` や `7`）ことで動き探索等の探索範囲を狭め、EU 負荷・遅延を低減できます。

2. **`-low_power 1` (VDEnc) オプションと安全フォールバック**
   - `vaapiLowPower === true` の場合、`-c:v h264_vaapi` の後に `-low_power 1` を付与します。
   - **フォールバック機構**: ホストカーネル設定（例: `i915.enable_guc=2` / HuC ファームウェア未ロード）や非対応 GPU で `-low_power 1` 起動に失敗し FFmpeg が起動直後（例: 2 秒以内・出力フレーム 0）に異常終了した場合、自動的に `vaapiLowPower = false` へフォールバックして再起動し、ログへ警告を出力する安全装置を設けます。

3. **GPU 側色空間変換（調査・検証タスク）**
   - `-vf hwupload,scale_vaapi=format=nv12` による CPU→GPU 変換オフロードの可否（`x11grab` が出力する `bgr0` フォーマットの `hwupload` 互換性と、UHD 600 / iHD 環境での実測負荷比較）を検証し、効果があればオプションとして組み込みます。

---

### 3.4 REST API & 設定モーダル UI 拡張

- **`server/src/routes/settings.ts`**
  - `GET /api/settings`: 現在の `stream` 設定（`performancePreset`, `maxSize`, `maxFps`, `bitrate`, `vaapiCompressionLevel`, `vaapiLowPower`）を返却。
  - `POST /api/settings`: バリデーション（`maxSize`: `640`〜`1920`, `maxFps`: `15`〜`60`, `bitrate`: `300000`〜`10000000`, `vaapiCompressionLevel`: `1`〜`7`）を実施し、`encoder.updateConfig()` 等へ即時反映。
- **`client/src/views/settings-modal.ts`**
  - 「映像パフォーマンス」セクションを追加：
    - パフォーマンスプリセット選択（標準 / 省電力・軽量 / カスタム）
    - 最大解像度（`960px` / `1280px` / `1920px`）
    - 最大 FPS（`15` / `24` / `30` / `60`）
    - 映像ビットレート（`500kbps` / `800kbps` / `1Mbps` / `2Mbps` / `4Mbps`）
    - （詳細設定）エンコード負荷優先度（`compression_level`）、VDEnc 低電力モード（`low_power`）

---

## 4. テスト計画・検証方法

1. **自動テスト・静的チェック**
   - `VaapiEncoder` の引数生成ユニットテスト（`compressionLevel`, `lowPower` 反映、および範囲外値のクランプ検証）
   - `handleResizeMessage()` の `maxSize` キャップロジックのユニットテスト
   - `POST /api/settings` のバリデーションテスト
   - `npm run check`, `npm test`, `npm run build` の全件 PASS
2. **実機パフォーマンス検証（UHD 600 vs UHD 630）**
   - 確認指標：
     - コンテナ内 `ffmpeg` / `chrome` の CPU 使用率
     - ホスト側 `intel_gpu_top` による Render / Video / VideoEnhance 使用率
     - `/api/metrics` および HUD の実測 FPS・エンコード遅延・ドロップフレーム率
