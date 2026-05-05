import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { msToX, setupCanvas, xToMs } from './canvas-utils';

/**
 * Multi-component proportions over time (Stage 5).
 *
 * Canvas-rendered stacked areas summing to 1.0 — used by emotion timeline
 * (8 emotions) and AU intensities (collapsed view).
 *
 * Each `StackedSample` is one snapshot (e.g. an EmotionRow), bucketed
 * server-side. The component normalizes within each sample so missing
 * components don't break the stack.
 */

export type StackedSample = {
  tMs: number;
  components: Record<string, number>;
};

export type StackedSeriesDef = {
  key: string;
  label: string;
  color: string;
};

type Props = {
  samples: StackedSample[];
  series: StackedSeriesDef[];
  fromMs: number;
  toMs: number;
  width: number;
  height: number;
};

export const StackedAreaLane = memo(function StackedAreaLane({
  samples,
  series,
  fromMs,
  toMs,
  width,
  height,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoverPx, setHoverPx] = useState<number | null>(null);

  const visible = useMemo(
    () => samples.filter((s) => s.tMs >= fromMs && s.tMs <= toMs),
    [samples, fromMs, toMs],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, width, height);
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (visible.length === 0) return;

    // Pre-normalize each sample to a stack [0..1].
    const stacks: { x: number; cum: number[] }[] = visible.map((s) => {
      const x = msToX(s.tMs, fromMs, toMs, width);
      let total = 0;
      for (const def of series) total += sanitize(s.components[def.key]);
      const cum: number[] = [];
      let acc = 0;
      for (const def of series) {
        const v = sanitize(s.components[def.key]);
        const norm = total > 0 ? v / total : 0;
        acc += norm;
        cum.push(acc);
      }
      return { x, cum };
    });

    // Draw each band top-down by accumulating from each component's lower
    // edge to its upper edge for every sample.
    for (let i = 0; i < series.length; i++) {
      const def = series[i]!;
      ctx.fillStyle = def.color;
      ctx.beginPath();
      // Top edge (cum[i]) left → right
      let first = true;
      for (const st of stacks) {
        const yTop = (1 - st.cum[i]!) * height;
        if (first) {
          ctx.moveTo(st.x, yTop);
          first = false;
        } else {
          ctx.lineTo(st.x, yTop);
        }
      }
      // Bottom edge (cum[i-1] or 0) right → left
      for (let j = stacks.length - 1; j >= 0; j--) {
        const st = stacks[j]!;
        const lower = i === 0 ? 0 : st.cum[i - 1]!;
        const yBot = (1 - lower) * height;
        ctx.lineTo(st.x, yBot);
      }
      ctx.closePath();
      ctx.fill();
    }
  }, [visible, series, fromMs, toMs, width, height]);

  // Hover tooltip — find nearest sample.
  const hoverInfo = useMemo(() => {
    if (hoverPx === null || visible.length === 0) return null;
    const ms = xToMs(hoverPx, fromMs, toMs, width);
    let nearest = visible[0]!;
    let minDelta = Math.abs(nearest.tMs - ms);
    for (const s of visible) {
      const d = Math.abs(s.tMs - ms);
      if (d < minDelta) {
        minDelta = d;
        nearest = s;
      }
    }
    return nearest;
  }, [hoverPx, visible, fromMs, toMs, width]);

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
      {hoverPx !== null && hoverInfo && (
        <>
          <div
            className="absolute top-0 bottom-0 w-px bg-stone-400/60 pointer-events-none"
            style={{ left: hoverPx }}
          />
          <div
            className="absolute z-10 bg-stone-900 text-stone-50 text-[10px] rounded px-1.5 py-1 shadow-md pointer-events-none font-mono"
            style={{
              left: Math.min(width - 160, hoverPx + 6),
              top: 2,
            }}
          >
            {series.map((def) => {
              const v = sanitize(hoverInfo.components[def.key]);
              return (
                <div key={def.key} className="whitespace-nowrap">
                  <span style={{ color: def.color }}>■</span> {def.label}: {v.toFixed(2)}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
});

function sanitize(n: number | null | undefined): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return 0;
  return Math.max(0, n);
}
