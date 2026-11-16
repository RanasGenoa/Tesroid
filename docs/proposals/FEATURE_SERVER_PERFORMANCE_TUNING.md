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
export type PerformancePreset = 'high' | 'balanced' | 'low_power' | 'custom';

export interface StreamConfig {
  bitrate: number; // bps (HUD側で切替、例: 1000000 = 1Mbps)
  maxFps: number; // HUD側で切替、例: 30
  maxSize: number; // 長辺上限 px (例: 960, 1280, 1920)
  audioBitrate?: number; // bps (128000 - 320000)
  performancePreset?: PerformancePreset; // デフォルト: 'balanced'
  vaapiCompressionLevel?: number; // 1(高品質/重) 〜 7(最速/軽)、デフォルト: 7
  vaapiLowPower?: boolean; // -low_power 1 有効化、デフォルト: false
  vaapiGpuColorConversion?: boolean; // scale_vaapi 色空間変換、デフォルト: true
}
```

#### プリセット定義（FPS・ビットレートは HUD 担当として分離）

| プリセット名 | 想定環境 | `maxSize` | `vaapiCompressionLevel` | `vaapiGpuColorConversion` | `vaapiLowPower` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `high` (最高) | UHD 630 等の余裕ある環境 | `1920` | `4` | `true` | `false` |
| `balanced` (標準・既定) | 一般的な VAAPI 環境 | `1280` | `7` | `true` | `false` |
| `low_power` (軽量・省電力) | UHD 600 等の省電力 iGPU / Celeron | `960` | `7` | `true` | `false` |
| `custom` (カスタム) | ユーザー任意指定 | ユーザー指定 | ユーザー指定 | ユーザー指定 | ユーザー指定 |

#### 環境変数による初期値上書き (`docker-compose.yml` / `.env`)
- `VAAPI_COMPRESSION_LEVEL`（`1`〜`7`）
- `VAAPI_LOW_POWER`（`true` / `false`）
- `VAAPI_GPU_CSC`（`true` / `false`、デフォルト `true`）
- `STREAM_MAX_SIZE`（例: `960`, `1280`, `1920`）

---

### 3.2 動的リサイズの上限適用 (`server/src/ws/handler.ts`)

`handleResizeMessage()` 内で `configStore.getConfig().stream.maxSize` を参照し、縦長画面や極端なアスペクト比にも対応できるよう、アスペクト比を維持したまま **長辺（`Math.max(effW, effH)`）** が `maxSize` を超えないようスケーリングおよびクランプを行います。

```text
要求解像度 (effW, effH)
  │
  ▼ maxSize = clamp(config.stream.maxSize, 640, 1920)
  ▼ maxDim = Math.max(effW, effH)
  ├─ maxDim > maxSize の場合:
  │     scale = maxSize / maxDim
  │     effW = Math.round(effW * scale)
  │     effH = Math.round(effH * scale)
  │
  ▼ VAAPI / H.264 マクロブロック整合アライメント
  width  = clamp(effW, 640, maxSize) & ~7               (8の倍数)
  height = clamp(effH, 360, min(1080, maxSize)) & ~1    (2の倍数)
```

---

### 3.3 FFmpeg VAAPI エンコーダの拡張 (`server/src/encoder/ffmpeg.ts`)

1. **`-compression_level` の動的指定**
   - ハードコードされていた `'4'` を設定値（`1`〜`7` の範囲でクランプ、デフォルト `7`）に置き換えます。
   - Intel iHD の `h264_vaapi` では数値を上げる（`6` や `7`）ことで動き探索等の探索範囲を狭め、EU 負荷・遅延を低減できます。

2. **GPU 側色空間変換（デフォルト有効 + 自動フォールバック）**
   - `-vf hwupload,scale_vaapi=format=nv12` をデフォルト有効とし、CPU 側での RGB→NV12 変換負荷を GPU へオフロードします（TrueNAS UHD 630 実測で CPU 負荷約 72% 削減）。
   - 非対応ドライバ等で起動直後（プロセス内出力フレーム数 `framesInCurrentProcess === 0` かつ起動後 3 秒未満）にエラー終了した場合は、自動的に CPU `format=nv12,hwupload` へフォールバックして再起動します。

3. **`-low_power 1` (VDEnc) オプションと安全フォールバック**
   - `vaapiLowPower === true` の場合（`custom` または環境変数指定時）、`-c:v h264_vaapi` の後に `-low_power 1` を付与します。
   - ホストカーネル設定（HuC ファームウェア未ロード等）により CBR/VBR で起動直後に異常終了した場合（`framesInCurrentProcess === 0` かつ 3 秒未満）は、自動的に `lowPower = false` へフォールバックして再起動します。

---

### 3.4 REST API & 設定モーダル UI 拡張

- **`server/src/routes/settings.ts`**
  - `GET /api/settings`: 現在の `stream` 設定（`performancePreset`, `maxSize`, `maxFps`, `bitrate`, `vaapiCompressionLevel`, `vaapiLowPower`, `vaapiGpuColorConversion`）を返却。
  - `PUT /api/settings`: プリセット指定時のサーバー側規定値展開および各値のバリデーションを実施し、`encoder.updateConfig()` 等へ即時反映。
- **`client/src/views/settings-modal.ts`**
  - FPS・ビットレートは HUD 側トグルで変更する設計を維持し、設定モーダルでは **3 段階プリセット (`high` / `balanced` / `low_power`) + `custom`** を提供（`custom` 選択時のみ詳細設定パネルを表示）。

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
