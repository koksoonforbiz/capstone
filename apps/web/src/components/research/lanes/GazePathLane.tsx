import { memo, useEffect, useMemo, useRef } from 'react';
import { binMeans, msToX, setupCanvas } from './canvas-utils';

/**
 * Specialized gaze lane (Stage 5).
 *
 * Two render modes (toggled in the gutter):
 *   • Trace mode    — x and y plotted as two thin Canvas series.
 *   • Density mode  — a 1D heatmap showing how much movement happened
 *                      per second (variance proxy).
 */

export type GazeRow = {
  tMs: number;
  x: number;
  y: number;
  conf: number | null;
};

type Props = {
  rows: GazeRow[];
  fromMs: number;
  toMs: number;
  width: number;
  height: number;
  mode: 'trace' | 'density';
};

const COLOR_X = 'rgb(82, 130, 145)';
const COLOR_Y = 'rgb(146, 124, 90)';

export const GazePathLane = memo(function GazePathLane({
  rows,
  fromMs,
  toMs,
  width,
  height,
  mode,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maxBins = Math.max(64, Math.floor(width * 2));

  // Pre-bin x and y per visible window.
  const binned = useMemo(() => {
    const xBins = binMeans(
      rows,
      (r) => r.tMs,
      (r) => r.x,
      fromMs,
      toMs,
      maxBins,
    );
    const yBins = binMeans(
      rows,
      (r) => r.tMs,
      (r) => r.y,
      fromMs,
      toMs,
      maxBins,
    );
    return { xBins, yBins };
  }, [rows, fromMs, toMs, maxBins]);

  // Density: variance in x+y over each second-bucket.
  const densityBuckets = useMemo(() => {
    if (mode !== 'density') return [];
    const span = toMs - fromMs;
    if (span <= 0) return [];
    const buckets = Math.min(maxBins, Math.max(8, Math.floor(span / 1000)));
    const bucketMs = span / buckets;
    const sumXSq = new Float64Array(buckets);
    const sumX = new Float64Array(buckets);
    const sumYSq = new Float64Array(buckets);
    const sumY = new Float64Array(buckets);
    const counts = new Int32Array(buckets);
    for (const r of rows) {
      if (r.tMs < fromMs || r.tMs > toMs) continue;
      const i = Math.min(buckets - 1, Math.floor((r.tMs - fromMs) / bucketMs));
      sumX[i]! += r.x;
      sumY[i]! += r.y;
      sumXSq[i]! += r.x * r.x;
      sumYSq[i]! += r.y * r.y;
      counts[i]! += 1;
    }
    const out: Array<{ ms: number; variance: number }> = [];
    let max = 0;
    for (let i = 0; i < buckets; i++) {
      const c = counts[i]!;
      if (c === 0) {
        out.push({ ms: fromMs + (i + 0.5) * bucketMs, variance: 0 });
        continue;
      }
      const mx = sumX[i]! / c;
      const my = sumY[i]! / c;
      const vx = sumXSq[i]! / c - mx * mx;
      const vy = sumYSq[i]! / c - my * my;
      const v = Math.max(0, vx + vy);
      if (v > max) max = v;
      out.push({ ms: fromMs + (i + 0.5) * bucketMs, variance: v });
    }
    // Normalize to 0..1.
    if (max > 0) for (const o of out) o.variance /= max;
    return out;
  }, [rows, fromMs, toMs, mode, maxBins]);

  // Auto-domain for x/y in trace mode.
  const traceDomain = useMemo(() => {
    if (mode !== 'trace') return null;
    let min = Infinity;
    let max = -Infinity;
    for (const b of binned.xBins) {
      if (b.value < min) min = b.value;
      if (b.value > max) max = b.value;
    }
    for (const b of binned.yBins) {
      if (b.value < min) min = b.value;
      if (b.value > max) max = b.value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      return { min: 0, max: 1 };
    }
    return { min, max };
  }, [binned, mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, width, height);
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    if (mode === 'density') {
      // Heatmap row.
      const span = toMs - fromMs;
      if (span <= 0 || densityBuckets.length === 0) return;
      const bw = width / densityBuckets.length;
      for (const b of densityBuckets) {
        const x = msToX(b.ms - span / densityBuckets.length / 2, fromMs, toMs, width);
        const alpha = 0.05 + b.variance * 0.85;
        ctx.fillStyle = `rgba(82, 130, 145, ${alpha})`;
        ctx.fillRect(x, 2, bw + 1, height - 4);
      }
    } else {
      // Trace: two thin lines, x in blue-gray, y in warm.
      if (!traceDomain) return;
      const { min, max } = traceDomain;
      const yToPx = (v: number) => {
        const t = (v - min) / (max - min || 1);
        return height - 4 - t * (height - 8);
      };
      const drawLine = (bins: Array<{ ms: number; value: number }>, color: string) => {
        if (bins.length === 0) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        let first = true;
        for (const b of bins) {
          const x = msToX(b.ms, fromMs, toMs, width);
          const y = yToPx(b.value);
          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      };
      drawLine(binned.xBins, COLOR_X);
      drawLine(binned.yBins, COLOR_Y);
    }
  }, [binned, densityBuckets, mode, fromMs, toMs, width, height, traceDomain]);

  return <canvas ref={canvasRef} className="absolute inset-0 block" />;
});
