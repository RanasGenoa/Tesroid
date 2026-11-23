// クライアント負荷プロファイル (Issue #11): レイアウト解像度とエンコード解像度の分離計算。
// リモート Chrome のビューポート (レイアウト) は変更せず、キャプチャ→エンコード段でのみ
// scale_vaapi / scale フィルタで縮小するため、その寸法算出を純粋関数として分離する。

export interface EncodeDimensions {
  width: number;
  height: number;
}

/**
 * レイアウト (キャプチャ) 寸法と resolutionScale からエンコード出力寸法を計算する。
 * scale >= 1 または元寸法と同等になる場合は null (= 現行と同一パス、フィルタ追加なし)。
 * H.264 マクロブロック整合のため幅は 8 の倍数・高さは 2 の倍数へ切り下げ、
 * 実用下限 (320x240) を下限とする。
 */
export function computeEncodeDimensions(
  layoutWidth: number,
  layoutHeight: number,
  resolutionScale: number,
): EncodeDimensions | null {
  if (!Number.isFinite(resolutionScale) || resolutionScale >= 1.0) {
    return null;
  }
  const width = Math.max(320, Math.round(layoutWidth * resolutionScale)) & ~7;
  const height = Math.max(240, Math.round(layoutHeight * resolutionScale)) & ~1;
  if (width >= layoutWidth && height >= layoutHeight) {
    return null;
  }
  return { width, height };
}
