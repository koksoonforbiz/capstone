/**
 * Sets a Canvas element's backing store size to match its CSS pixel size,
 * scaled by devicePixelRatio. Returns the resulting 2D context with the
 * transform pre-applied so subsequent draw calls can use CSS pixel
 * coordinates.
 *
 * Call this at the top of every draw-effect; it's cheap and idempotent.
 */
export function setupCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasRenderingContext2D | null {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const desiredW = Math.max(1, Math.floor(cssWidth * dpr));
  const desiredH = Math.max(1, Math.floor(cssHeight * dpr));
  if (canvas.width !== desiredW) canvas.width = desiredW;
  if (canvas.height !== desiredH) canvas.height = desiredH;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function msToX(ms: number, fromMs: number, toMs: number, width: number): number {
  if (toMs === fromMs) return 0;
  return ((ms - fromMs) / (toMs - fromMs)) * width;
}

export function xToMs(px: number, fromMs: number, toMs: number, width: number): number {
  if (width === 0) return fromMs;
  return fromMs + (px / width) * (toMs - fromMs);
}

/**
 * Bin numeric points to at most `maxBins` buckets across the visible
 * window. Each bucket contains the mean of all points whose tMs falls in
 * it. This is a render-time downsample on top of the server-side one.
 */
export function binMeans<T>(
  rows: readonly T[],
  getMs: (r: T) => number,
  getValue: (r: T) => number,
  fromMs: number,
  toMs: number,
  maxBins: number,
): Array<{ ms: number; value: number }> {
  if (rows.length === 0 || toMs <= fromMs || maxBins <= 0) return [];
  const span = toMs - fromMs;
  const bucketMs = span / maxBins;
  const sums = new Float64Array(maxBins);
  const counts = new Int32Array(maxBins);
  for (const r of rows) {
    const t = getMs(r);
    if (t < fromMs || t > toMs) continue;
    const idx = Math.min(maxBins - 1, Math.floor((t - fromMs) / bucketMs));
    sums[idx]! += getValue(r);
    counts[idx]! += 1;
  }
  const out: Array<{ ms: number; value: number }> = [];
  for (let i = 0; i < maxBins; i++) {
    if (counts[i] === 0) continue;
    out.push({ ms: fromMs + (i + 0.5) * bucketMs, value: sums[i]! / counts[i]! });
  }
  return out;
}
