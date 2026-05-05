import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { VideoSegment } from '@ats/shared';

/**
 * Stitched video player for retrospective tracing (prompt_retro Stage 4).
 *
 * Plays a sequence of `RecordingSegment`s as if they were one continuous
 * video. The episode-relative `currentMs` is the source of truth — the
 * `<video>` element is slaved to it.
 *
 * Gaps between segments (refresh windows) are not played; we pause and
 * show an overlay. The user can still scrub through them via the ruler.
 */

type Props = {
  segments: VideoSegment[];
  episodeDurationMs: number;
  currentMs: number;
  onTimeUpdate: (ms: number) => void;
  onSeek: (ms: number) => void;
  playing: boolean;
  onPlayingChange: (p: boolean) => void;
  playbackRate: number;
  onPlaybackRateChange: (r: number) => void;
};

const SEEK_SMALL_MS = 5_000;
const SEEK_LARGE_MS = 15_000;
const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const;

export function StitchedVideoPlayer({
  segments,
  episodeDurationMs,
  currentMs,
  onTimeUpdate,
  onSeek,
  playing,
  onPlayingChange,
  playbackRate,
  onPlaybackRateChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastEmittedMsRef = useRef(0);

  // Find the segment that contains `currentMs`. Snap to startMs <= ms < endMs.
  // Segments are pre-sorted by startMs server-side.
  const activeSegment = useMemo(() => {
    return findSegmentForMs(segments, currentMs);
  }, [segments, currentMs]);

  const inGap = activeSegment === null && segments.length > 0;
  const noVideo = segments.length === 0;

  // Track which segment src is currently loaded on the <video> element.
  const [loadedSegmentId, setLoadedSegmentId] = useState<string | null>(null);

  // ─── 1. Swap <video>.src when active segment changes ────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!activeSegment) return;

    if (loadedSegmentId !== activeSegment.id) {
      video.src = activeSegment.signedUrl;
      // Don't autoplay — wait for loadedmetadata then sync time.
      video.load();
      setLoadedSegmentId(activeSegment.id);
    }
  }, [activeSegment, loadedSegmentId]);

  // ─── 2. Sync video.currentTime to currentMs (when in segment) ───────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeSegment) return;

    const targetSec = (currentMs - activeSegment.startMs) / 1000;
    // Avoid feedback loops with the timeupdate handler — only re-seek if
    // we're meaningfully out of sync.
    if (Math.abs(video.currentTime - targetSec) > 0.25) {
      // readyState >= 1 (HAVE_METADATA) means duration is known.
      if (video.readyState >= 1) {
        try {
          video.currentTime = clamp(targetSec, 0, video.duration || targetSec);
        } catch {
          // Some browsers throw if seeking before metadata; safe to ignore.
        }
      }
    }
  }, [currentMs, activeSegment]);

  // ─── 3. Slave play/pause + rate to props ────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (inGap || noVideo) {
      video.pause();
      return;
    }
    if (playing) {
      void video.play().catch(() => {
        // Autoplay blocked or src not ready. Surface as paused.
        onPlayingChange(false);
      });
    } else {
      video.pause();
    }
  }, [playing, inGap, noVideo, onPlayingChange]);

  // ─── 4. Translate <video> events back to episode-relative ms ────────────
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !activeSegment) return;
    const newMs = activeSegment.startMs + video.currentTime * 1000;
    // Throttle: only emit if changed by >50ms.
    if (Math.abs(newMs - lastEmittedMsRef.current) < 50) return;
    lastEmittedMsRef.current = newMs;
    onTimeUpdate(newMs);
  }, [activeSegment, onTimeUpdate]);

  const handleEnded = useCallback(() => {
    if (!activeSegment) return;
    // Jump to the start of the next segment (or just past the end of this
    // one, which lands us in a gap if applicable).
    const idx = segments.findIndex((s) => s.id === activeSegment.id);
    const nextSeg = idx >= 0 ? segments[idx + 1] : undefined;
    if (nextSeg) {
      onSeek(nextSeg.startMs);
    } else {
      onPlayingChange(false);
    }
  }, [activeSegment, segments, onSeek, onPlayingChange]);

  // ─── 5. Keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Only handle if the focus is inside this player or on body.
      const target = e.target as HTMLElement | null;
      const isInteractive =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (isInteractive) return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        onPlayingChange(!playing);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const delta = e.shiftKey ? -SEEK_LARGE_MS : -SEEK_SMALL_MS;
        onSeek(clamp(currentMs + delta, 0, episodeDurationMs));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = e.shiftKey ? SEEK_LARGE_MS : SEEK_SMALL_MS;
        onSeek(clamp(currentMs + delta, 0, episodeDurationMs));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, currentMs, episodeDurationMs, onPlayingChange, onSeek]);

  // ─── 6. Fullscreen toggle ───────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      void el.requestFullscreen?.().catch(() => {});
    } else {
      void document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative aspect-video w-full max-w-[1280px] bg-black rounded-lg overflow-hidden"
      data-testid="stitched-video-player"
    >
      {/* The <video> element. Always present so we can keep it warm even when
          we're temporarily in a refresh gap. */}
      {!noVideo && (
        <video
          ref={videoRef}
          className="w-full h-full"
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
          onPlay={() => onPlayingChange(true)}
          onPause={() => onPlayingChange(false)}
          playsInline
          preload="metadata"
        />
      )}

      {/* No-video placeholder */}
      {noVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 text-sm">
          <svg
            className="w-10 h-10 mb-2 opacity-50"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
          No video recorded for this episode
        </div>
      )}

      {/* Refresh-gap overlay */}
      {inGap && !noVideo && (
        <RefreshGapOverlay
          currentMs={currentMs}
          segments={segments}
          episodeDurationMs={episodeDurationMs}
          onJumpToNext={(ms) => onSeek(ms)}
        />
      )}

      {/* Controls */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2 flex items-center gap-2 text-white text-xs">
        <button
          type="button"
          onClick={() => onPlayingChange(!playing)}
          disabled={noVideo}
          className="p-1.5 rounded hover:bg-white/20 disabled:opacity-30"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={() => onSeek(clamp(currentMs - SEEK_SMALL_MS, 0, episodeDurationMs))}
          disabled={noVideo}
          className="px-1.5 py-1 rounded hover:bg-white/20 disabled:opacity-30"
          aria-label="Back 5 seconds"
        >
          −5s
        </button>
        <button
          type="button"
          onClick={() => onSeek(clamp(currentMs - SEEK_LARGE_MS, 0, episodeDurationMs))}
          disabled={noVideo}
          className="px-1.5 py-1 rounded hover:bg-white/20 disabled:opacity-30"
          aria-label="Back 15 seconds"
        >
          −15s
        </button>
        <button
          type="button"
          onClick={() => onSeek(clamp(currentMs + SEEK_SMALL_MS, 0, episodeDurationMs))}
          disabled={noVideo}
          className="px-1.5 py-1 rounded hover:bg-white/20 disabled:opacity-30"
          aria-label="Forward 5 seconds"
        >
          +5s
        </button>
        <button
          type="button"
          onClick={() => onSeek(clamp(currentMs + SEEK_LARGE_MS, 0, episodeDurationMs))}
          disabled={noVideo}
          className="px-1.5 py-1 rounded hover:bg-white/20 disabled:opacity-30"
          aria-label="Forward 15 seconds"
        >
          +15s
        </button>

        <div className="ml-2 font-mono tabular-nums">
          {formatHMS(currentMs)} / {formatHMS(episodeDurationMs)}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={playbackRate}
            onChange={(e) => onPlaybackRateChange(parseFloat(e.target.value))}
            disabled={noVideo}
            className="bg-black/40 border border-white/20 rounded px-1.5 py-0.5 text-xs disabled:opacity-30"
            aria-label="Playback rate"
          >
            {PLAYBACK_RATES.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={toggleFullscreen}
            disabled={noVideo}
            className="p-1.5 rounded hover:bg-white/20 disabled:opacity-30"
            aria-label="Toggle fullscreen"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function findSegmentForMs(segments: VideoSegment[], ms: number): VideoSegment | null {
  for (const seg of segments) {
    if (ms >= seg.startMs && ms < seg.endMs) return seg;
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function formatHMS(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

// ─── Refresh-gap overlay ─────────────────────────────────────────────────

function RefreshGapOverlay({
  currentMs,
  segments,
  episodeDurationMs,
  onJumpToNext,
}: {
  currentMs: number;
  segments: VideoSegment[];
  episodeDurationMs: number;
  onJumpToNext: (ms: number) => void;
}) {
  // Find the gap bounds.
  let gapFromMs = 0;
  let gapToMs = episodeDurationMs;
  let nextSegStart: number | null = null;
  for (const seg of segments) {
    if (seg.endMs <= currentMs) {
      gapFromMs = Math.max(gapFromMs, seg.endMs);
    } else if (seg.startMs > currentMs) {
      gapToMs = Math.min(gapToMs, seg.startMs);
      nextSegStart = nextSegStart === null ? seg.startMs : Math.min(nextSegStart, seg.startMs);
    }
  }
  const gapMs = Math.max(0, gapToMs - gapFromMs);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-stone-900/85 text-stone-200 text-sm gap-2">
      <svg
        className="w-8 h-8 text-amber-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
      <div className="font-medium">Refresh gap — no video recorded</div>
      <div className="text-xs text-stone-400">Gap of {formatGap(gapMs)}</div>
      {nextSegStart !== null && (
        <button
          type="button"
          onClick={() => onJumpToNext(nextSegStart!)}
          className="mt-2 px-3 py-1 text-xs bg-stone-700 hover:bg-stone-600 rounded"
        >
          Skip to next segment →
        </button>
      )}
    </div>
  );
}

function formatGap(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
