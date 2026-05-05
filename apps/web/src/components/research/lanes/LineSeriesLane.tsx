import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { binMeans, msToX, setupCanvas, xToMs } from './canvas-utils';

/**
 * Continuous numeric series lane (Stage 5).
 *
 * Canvas-rendered for perf. Used by pupil diameter, derived engagement,
 * derived cognitive load, scroll position. Multiple series can share a
 * lane (e.g. engagement + cognitive load if we ever stack them).
 */

export type LineSeriesPoint = { tMs: number; value: number };

export type LineSeries = {
  id: string;
  label: string;
  color: string;
  points: LineSeriesPoint[];
  fillOpacity?: number; // 0..1; 0 = no fill, default 0.12
  yMin?: number; // override auto-domain
  yMax?: number;
  unit?: string; // for tooltip display
};

type Props = {
  series: LineSeries[];
  fromMs: number;
  toMs: number;
  width: number;
  height: number;
};

export const LineSeriesLane = memo(function LineSeriesLane({
  series,
  fromMs,
  toMs,
  width,
  height,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoverPx, setHoverPx] = useState<number | null>(null);

  const maxBins = Math.max(64, Math.floor(width * 2));

  // Pre-bin per-series so canvas redraws are cheap.
  const binnedSeries = useMemo(() => {
    return series.map((s) => ({
      ...s,
      bins: binMeans(
        s.points,
        (p) => p.tMs,
        (p) => p.value,
        fromMs,
        toMs,
        maxBins,
      ),
    }));
  }, [series, fromMs, toMs, maxBins]);

  // Domain (y-axis) — union of explicit yMin/yMax or measured.
  const yDomain = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of binnedSeries) {
      if (s.yMin !== undefined) min = Math.min(min, s.yMin);
      if (s.yMax !== undefined) max = Math.max(max, s.yMax);
      for (const b of s.bins) {
        if (b.value < min) min = b.value;
        if (b.value > max) max = b.value;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    return { min, max };
  }, [binnedSeries]);

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, width, height);
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    // Faint horizontal mid-line.
    ctx.strokeStyle = 'rgba(120, 113, 108, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    const yToPx = (v: number) => {
      const t = (v - yDomain.min) / (yDomain.max - yDomain.min || 1);
      // 4px top + 4px bottom padding
      return height - 4 - t * (height - 8);
    };

    for (const s of binnedSeries) {
      if (s.bins.length === 0) continue;

      // Optional fill area below.
      const fillOpacity = s.fillOpacity ?? 0.12;
      if (fillOpacity > 0) {
        ctx.fillStyle = withAlpha(s.color, fillOpacity);
        ctx.beginPath();
        let first = true;
        for (const b of s.bins) {
          const x = msToX(b.ms, fromMs, toMs, width);
          const y = yToPx(b.value);
          if (first) {
            ctx.moveTo(x, height - 4);
            ctx.lineTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }
        const lastBin = s.bins[s.bins.length - 1]!;
        const lastX = msToX(lastBin.ms, fromMs, toMs, width);
        ctx.lineTo(lastX, height - 4);
        ctx.closePath();
        ctx.fill();
      }

      // Line.
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let first = true;
      for (const b of s.bins) {
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
    }
  }, [binnedSeries, fromMs, toMs, width, height, yDomain]);

  // Tooltip values at hover.
  const hoverValues = useMemo(() => {
    if (hoverPx === null) return null;
    const ms = xToMs(hoverPx, fromMs, toMs, width);
    return binnedSeries.map((s) => {
      // Find nearest bin.
      let nearest: { ms: number; value: number } | null = null;
      let minDelta = Infinity;
      for (const b of s.bins) {
        const d = Math.abs(b.ms - ms);
        if (d < minDelta) {
          minDelta = d;
          nearest = b;
        }
      }
      return {
        id: s.id,
        label: s.label,
        color: s.color,
        value: nearest?.value ?? null,
        unit: s.unit,
      };
    });
  }, [hoverPx, binnedSeries, fromMs, toMs, width]);

  return (
    <div
      className="absolute inset-0"
      onMouseMove={(e) => {
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        setHoverPx(e.clientX - rect.left);
      }}
      onMouseLeave={() => setHoverPx(null)}
    >
      <canvas ref={canvasRef} className="block" />
      {hoverPx !== null && (
        <>
          <div
            className="absolute top-0 bottom-0 w-px bg-stone-400/60 pointer-events-none"
            style={{ left: hoverPx }}
          />
          {hoverValues && (
            <div
              className="absolute z-10 bg-stone-900 text-stone-50 text-[10px] rounded px-1.5 py-1 shadow-md pointer-events-none whitespace-nowrap font-mono"
              style={{
                left: Math.min(width - 120, hoverPx + 6),
                top: 2,
              }}
            >
              {hoverValues.map((v) => (
                <div key={v.id}>
                  <span style={{ color: v.color }}>■</span> {v.label}:{' '}
                  {v.value !== null ? formatNumber(v.value) : '—'}
                  {v.unit ? ` ${v.unit}` : ''}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
});

function formatNumber(n: number): string {
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function withAlpha(rgb: string, a: number): string {
  // Accepts `rgb(...)`, `rgba(...)`, or `#rrggbb`. Returns `rgba(...)`.
  if (rgb.startsWith('rgba')) return rgb;
  if (rgb.startsWith('rgb')) return rgb.replace('rgb(', 'rgba(').replace(')', `, ${a})`);
  if (rgb.startsWith('#')) {
    const hex = rgb.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return rgb;
}
