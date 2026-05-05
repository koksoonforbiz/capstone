import { memo, useEffect, useMemo, useRef } from 'react';
import { msToX, setupCanvas } from './canvas-utils';

/**
 * Horizontal density heatmap (Stage 5).
 *
 * Used by click density (clicks per 5s) and cursor density. Darker = more
 * events. Bucket width matches `bucketMs` (default 5_000 = 5s) but never
 * smaller than 2px on screen.
 */

type Props = {
  events: { tMs: number }[];
  fromMs: number;
  toMs: number;
  width: number;
  height: number;
  bucketMs?: number;
  color?: string;
};

export const HeatmapLane = memo(function HeatmapLane({
  events,
  fromMs,
  toMs,
  width,
  height,
  bucketMs = 5_000,
  color = '82, 130, 145',
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const buckets = useMemo(() => {
    const span = toMs - fromMs;
    if (span <= 0) return [];
    // Choose bucket size so each bucket is at least 2px wide on screen.
    const minMsPer2px = (2 / Math.max(width, 1)) * span;
    const bw = Math.max(bucketMs, minMsPer2px);
    const count = Math.max(1, Math.ceil(span / bw));
    const counts = new Int32Array(count);
    for (const ev of events) {
      if (ev.tMs < fromMs || ev.tMs > toMs) continue;
      const i = Math.min(count - 1, Math.floor((ev.tMs - fromMs) / bw));
      counts[i]! += 1;
    }
    let max = 0;
    for (let i = 0; i < count; i++) if (counts[i]! > max) max = counts[i]!;
    const out: Array<{ ms: number; norm: number; count: number }> = [];
    for (let i = 0; i < count; i++) {
      out.push({
        ms: fromMs + i * bw,
        norm: max > 0 ? counts[i]! / max : 0,
        count: counts[i]!,
      });
    }
    return out;
  }, [events, fromMs, toMs, width, bucketMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, width, height);
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    if (buckets.length === 0) return;
    const span = toMs - fromMs;
    const bw = (span / buckets.length / span) * width;

    for (const b of buckets) {
      if (b.count === 0) continue;
      const x = msToX(b.ms, fromMs, toMs, width);
      const alpha = 0.08 + b.norm * 0.85;
      ctx.fillStyle = `rgba(${color}, ${alpha})`;
      ctx.fillRect(x, 2, Math.max(2, bw + 1), height - 4);
    }
  }, [buckets, fromMs, toMs, width, height, color]);

  return <canvas ref={canvasRef} className="absolute inset-0 block" />;
});
