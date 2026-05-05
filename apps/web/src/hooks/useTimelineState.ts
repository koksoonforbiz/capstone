import { useCallback, useMemo, useState } from 'react';
import type { TimelinePayload } from '@ats/shared';

/**
 * Central state store for the retrospective tracing page (prompt_retro Stage 4).
 *
 * The video's playback position is the single source of truth. Everything
 * else slaves to it via `currentMs`. `EpisodeTracePage` owns one instance
 * of this hook and threads the values down to the player + ruler + lanes.
 *
 * Zoom/pan are pure render concerns — we never re-fetch on zoom changes.
 */

export type TimelineEpisode = TimelinePayload['episode'];

export interface TimelineState {
  // Playhead — episode-relative ms.
  currentMs: number;
  setCurrentMs: (ms: number) => void;

  // Playback.
  playing: boolean;
  setPlaying: (p: boolean) => void;
  playbackRate: number;
  setPlaybackRate: (r: number) => void;

  // Visible window (ruler + lanes).
  zoomMs: number;
  setZoomMs: (ms: number) => void;
  panMs: number;
  setPanMs: (ms: number) => void;

  // Derived helpers.
  visibleRangeMs: { from: number; to: number };
  msToPx: (ms: number, containerWidthPx: number) => number;
  pxToMs: (px: number, containerWidthPx: number) => number;
}

/**
 * Episodes can be open-ended (endedAt null + durationMs null) — fall back to
 * a small non-zero window so the ruler doesn't collapse to a single tick.
 */
const MIN_EPISODE_DURATION_MS = 60_000;
const MIN_ZOOM_MS = 1_000;

export function useTimelineState(episode: TimelineEpisode): TimelineState {
  const totalDurationMs = Math.max(episode.durationMs ?? MIN_EPISODE_DURATION_MS, MIN_ZOOM_MS);

  const [currentMs, _setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [zoomMs, _setZoomMs] = useState(totalDurationMs);
  const [panMs, _setPanMs] = useState(0);

  const setCurrentMs = useCallback(
    (ms: number) => {
      _setCurrentMs(clamp(ms, 0, totalDurationMs));
    },
    [totalDurationMs],
  );

  const setZoomMs = useCallback(
    (ms: number) => {
      _setZoomMs(clamp(ms, MIN_ZOOM_MS, totalDurationMs));
    },
    [totalDurationMs],
  );

  const setPanMs = useCallback(
    (ms: number) => {
      _setPanMs(clamp(ms, 0, Math.max(0, totalDurationMs - zoomMs)));
    },
    [totalDurationMs, zoomMs],
  );

  const visibleRangeMs = useMemo(
    () => ({
      from: panMs,
      to: Math.min(panMs + zoomMs, totalDurationMs),
    }),
    [panMs, zoomMs, totalDurationMs],
  );

  const msToPx = useCallback(
    (ms: number, containerWidthPx: number) => {
      if (zoomMs <= 0) return 0;
      return ((ms - panMs) / zoomMs) * containerWidthPx;
    },
    [panMs, zoomMs],
  );

  const pxToMs = useCallback(
    (px: number, containerWidthPx: number) => {
      if (containerWidthPx <= 0) return panMs;
      return panMs + (px / containerWidthPx) * zoomMs;
    },
    [panMs, zoomMs],
  );

  return {
    currentMs,
    setCurrentMs,
    playing,
    setPlaying,
    playbackRate,
    setPlaybackRate,
    zoomMs,
    setZoomMs,
    panMs,
    setPanMs,
    visibleRangeMs,
    msToPx,
    pxToMs,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
