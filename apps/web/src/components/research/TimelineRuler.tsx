import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionBoundary } from '@ats/shared';

/**
 * Master timeline ruler (prompt_retro Stage 4).
 *
 * SVG-based. Renders:
 *   • Two label rows: top = wall clock (HH:MM:SS), bottom = episode-relative
 *     (`+MM:SS` or `+HH:MM:SS`).
 *   • Vertical playhead at `currentMs` (draggable).
 *   • Refresh-gap bands between consecutive sessions.
 *   • Vertical thin lines at each session start.
 *   • Click → seek; wheel → pan; Ctrl/⌘+wheel → zoom (centered on cursor).
 */

type Props = {
  episodeStartedAt: Date;
  episodeDurationMs: number;
  currentMs: number;
  onSeek: (ms: number) => void;
  zoomMs: number;
  onZoomChange: (ms: number) => void;
  panMs: number;
  onPanChange: (ms: number) => void;
  sessionBoundaries: SessionBoundary[];
};

const RULER_HEIGHT = 56;
const MIN_TICK_SPACING_PX = 60;
const MIN_ZOOM_MS = 1_000;

// Tick step ladder, in ms. We pick the smallest step where step/zoom * width >= 60px.
const TICK_STEPS_MS = [
  100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
  900_000, 1_800_000, 3_600_000, 7_200_000,
];

export function TimelineRuler({
  episodeStartedAt,
  episodeDurationMs,
  currentMs,
  onSeek,
  zoomMs,
  onZoomChange,
  panMs,
  onPanChange,
  sessionBoundaries,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);

  // ─── Track container width via ResizeObserver ──────────────────────────
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      setWidth(Math.max(0, w));
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const visibleFromMs = panMs;
  const visibleToMs = Math.min(panMs + zoomMs, episodeDurationMs);

  const msToPx = useCallback(
    (ms: number): number => {
      if (zoomMs <= 0) return 0;
      return ((ms - panMs) / zoomMs) * width;
    },
    [panMs, zoomMs, width],
  );

  const pxToMs = useCallback(
    (px: number): number => {
      if (width <= 0) return panMs;
      return panMs + (px / width) * zoomMs;
    },
    [panMs, zoomMs, width],
  );

  // ─── Tick generation ───────────────────────────────────────────────────
  const tickStepMs = useMemo(() => {
    if (width <= 0 || zoomMs <= 0) return 60_000;
    for (const step of TICK_STEPS_MS) {
      if ((step / zoomMs) * width >= MIN_TICK_SPACING_PX) return step;
    }
    return TICK_STEPS_MS[TICK_STEPS_MS.length - 1] ?? 3_600_000;
  }, [width, zoomMs]);

  const ticks = useMemo(() => {
    const result: { ms: number; major: boolean }[] = [];
    if (zoomMs <= 0 || width <= 0) return result;
    const minorStep = tickStepMs;
    const firstTick = Math.floor(visibleFromMs / minorStep) * minorStep;
    for (let t = firstTick; t <= visibleToMs + minorStep; t += minorStep) {
      if (t < 0 || t > episodeDurationMs) continue;
      result.push({ ms: t, major: t % (minorStep * 5) === 0 });
    }
    return result;
  }, [tickStepMs, visibleFromMs, visibleToMs, zoomMs, width, episodeDurationMs]);

  // ─── Wheel: zoom (Ctrl/⌘) or pan ───────────────────────────────────────
  // Use a ref-based listener with passive: false so we can preventDefault.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const cursorPx = e.clientX - rect.left;
      const cursorMs = panMs + (cursorPx / Math.max(rect.width, 1)) * zoomMs;

      if (e.ctrlKey || e.metaKey) {
        // Zoom — keep cursorMs anchored under the cursor.
        const factor = Math.pow(1.0015, e.deltaY); // smooth log-zoom
        const nextZoom = clamp(zoomMs * factor, MIN_ZOOM_MS, episodeDurationMs);
        const nextPan = clamp(
          cursorMs - (cursorPx / Math.max(rect.width, 1)) * nextZoom,
          0,
          Math.max(0, episodeDurationMs - nextZoom),
        );
        onZoomChange(nextZoom);
        onPanChange(nextPan);
      } else {
        // Pan — ratio of wheel delta to width × visible window.
        const deltaMs = (e.deltaY / Math.max(rect.width, 1)) * zoomMs;
        const nextPan = clamp(panMs + deltaMs, 0, Math.max(0, episodeDurationMs - zoomMs));
        onPanChange(nextPan);
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [panMs, zoomMs, episodeDurationMs, onPanChange, onZoomChange]);

  // ─── Click → seek ──────────────────────────────────────────────────────
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isDraggingPlayhead) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = e.clientX - rect.left;
      const ms = pxToMs(px);
      onSeek(clamp(ms, 0, episodeDurationMs));
    },
    [pxToMs, onSeek, episodeDurationMs, isDraggingPlayhead],
  );

  // ─── Drag the playhead ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isDraggingPlayhead) return;
    function onMove(e: MouseEvent) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = e.clientX - rect.left;
      onSeek(clamp(pxToMs(px), 0, episodeDurationMs));
    }
    function onUp() {
      setIsDraggingPlayhead(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingPlayhead, pxToMs, onSeek, episodeDurationMs]);

  // ─── Keyboard arrow seek on the playhead slider ────────────────────────
  const handlePlayheadKey = useCallback(
    (e: React.KeyboardEvent) => {
      const big = e.shiftKey ? 15_000 : 5_000;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onSeek(clamp(currentMs - big, 0, episodeDurationMs));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onSeek(clamp(currentMs + big, 0, episodeDurationMs));
      } else if (e.key === 'Home') {
        e.preventDefault();
        onSeek(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        onSeek(episodeDurationMs);
      }
    },
    [currentMs, episodeDurationMs, onSeek],
  );

  // ─── Refresh gap bands ─────────────────────────────────────────────────
  const refreshBands = useMemo(() => {
    const out: { fromMs: number; toMs: number; gapMs: number }[] = [];
    const sorted = [...sessionBoundaries].sort((a, b) => a.sessionStartMs - b.sessionStartMs);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (!prev || !cur) continue;
      const prevEnd = prev.sessionEndMs ?? prev.sessionStartMs;
      const curStart = cur.sessionStartMs;
      if (curStart > prevEnd && (cur.refreshGapMsBefore ?? 0) > 0) {
        out.push({ fromMs: prevEnd, toMs: curStart, gapMs: curStart - prevEnd });
      }
    }
    return out;
  }, [sessionBoundaries]);

  const playheadX = msToPx(currentMs);
  const playheadVisible = playheadX >= 0 && playheadX <= width;

  return (
    <div className="w-full select-none">
      <div
        ref={containerRef}
        className="relative w-full bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded cursor-crosshair"
        style={{ height: RULER_HEIGHT }}
        onClick={handleClick}
      >
        {width > 0 && (
          <svg
            width={width}
            height={RULER_HEIGHT}
            className="block"
            role="presentation"
            aria-hidden
          >
            {/* Refresh gap bands */}
            {refreshBands.map((b, i) => {
              const x1 = msToPx(b.fromMs);
              const x2 = msToPx(b.toMs);
              if (x2 < 0 || x1 > width) return null;
              return (
                <g key={`gap-${i}`}>
                  <rect
                    x={Math.max(0, x1)}
                    y={0}
                    width={Math.max(0, Math.min(x2, width) - Math.max(0, x1))}
                    height={RULER_HEIGHT}
                    fill="rgba(146, 124, 90, 0.18)"
                  >
                    <title>{`Refresh — gap of ${formatGap(b.gapMs)} from previous session`}</title>
                  </rect>
                </g>
              );
            })}

            {/* Session-start lines */}
            {sessionBoundaries.map((b) => {
              const x = msToPx(b.sessionStartMs);
              if (x < 0 || x > width) return null;
              return (
                <g key={`sess-${b.sessionId}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={0}
                    y2={RULER_HEIGHT}
                    stroke="rgba(82, 130, 145, 0.6)"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                  />
                  <text
                    x={x + 3}
                    y={11}
                    fontSize={9}
                    fill="rgb(82, 130, 145)"
                    className="font-mono"
                  >
                    {b.sessionId.slice(0, 8)}
                  </text>
                </g>
              );
            })}

            {/* Ticks */}
            {ticks.map((t, i) => {
              const x = msToPx(t.ms);
              if (x < -50 || x > width + 50) return null;
              return (
                <g key={`tick-${i}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={RULER_HEIGHT - (t.major ? 16 : 8)}
                    y2={RULER_HEIGHT}
                    stroke="rgba(120, 113, 108, 0.55)"
                    strokeWidth={1}
                  />
                  {t.major && (
                    <>
                      <text
                        x={x + 3}
                        y={RULER_HEIGHT - 22}
                        fontSize={10}
                        fill="rgb(87, 83, 78)"
                        className="font-mono tabular-nums"
                      >
                        {formatWallClock(episodeStartedAt, t.ms)}
                      </text>
                      <text
                        x={x + 3}
                        y={RULER_HEIGHT - 4}
                        fontSize={9}
                        fill="rgb(120, 113, 108)"
                        className="font-mono tabular-nums"
                      >
                        +{formatRelative(t.ms)}
                      </text>
                    </>
                  )}
                </g>
              );
            })}

            {/* Playhead */}
            {playheadVisible && (
              <line
                x1={playheadX}
                x2={playheadX}
                y1={0}
                y2={RULER_HEIGHT}
                stroke="rgb(220, 38, 38)"
                strokeWidth={2}
              />
            )}
          </svg>
        )}

        {/* Playhead drag handle (focusable for a11y) */}
        {playheadVisible && (
          <div
            role="slider"
            tabIndex={0}
            aria-label="Playhead"
            aria-valuemin={0}
            aria-valuemax={episodeDurationMs}
            aria-valuenow={Math.round(currentMs)}
            aria-valuetext={`+${formatRelative(currentMs)}`}
            className="absolute top-0 -ml-1.5 w-3 h-full cursor-ew-resize focus:outline-none focus:ring-2 focus:ring-red-500/40"
            style={{ left: playheadX }}
            onMouseDown={(e) => {
              e.stopPropagation();
              setIsDraggingPlayhead(true);
            }}
            onKeyDown={handlePlayheadKey}
          />
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function formatWallClock(start: Date, offsetMs: number): string {
  const d = new Date(start.getTime() + offsetMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatRelative(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function formatGap(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
