import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Resolution, TimelinePayload } from '@ats/shared';
import { api, ApiError } from '../../../lib/api';
import { useTimelineState } from '../../../hooks/useTimelineState';
import { useLaneConfig } from '../../../hooks/useLaneConfig';
import { StitchedVideoPlayer } from '../../../components/research/StitchedVideoPlayer';
import { TimelineRuler } from '../../../components/research/TimelineRuler';
import { LaneContainer, type SelectedEventKind } from '../../../components/research/LaneContainer';
import { InspectorPanel, type SelectedEvent } from '../../../components/research/InspectorPanel';
import { MergeModal } from '../../../components/research/modals/MergeModal';
import { SplitModal } from '../../../components/research/modals/SplitModal';
import { DetachModal } from '../../../components/research/modals/DetachModal';
import { ExportModal } from '../../../components/research/modals/ExportModal';

/**
 * Retrospective tracing — the page where a researcher actually inspects an
 * episode. Stage 4 builds the shell: header, video player, master timeline
 * ruler, refresh-gap markers. Lanes + inspector arrive in Stage 5.
 */

const RESOLUTION_OPTIONS: { value: Resolution; label: string }[] = [
  { value: 'low', label: 'Low (5s buckets)' },
  { value: 'medium', label: 'Medium (1s buckets)' },
  { value: 'high', label: 'High (200ms buckets)' },
  { value: 'raw', label: 'Raw (no bucketing)' },
];

export function EpisodeTracePage() {
  const { episodeId } = useParams<{ episodeId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [payload, setPayload] = useState<TimelinePayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution>(
    (searchParams.get('res') as Resolution) || 'medium',
  );

  // ─── Fetch timeline ───────────────────────────────────────────────────
  useEffect(() => {
    if (!episodeId) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    api
      .get<TimelinePayload>(`/research/episodes/${episodeId}/timeline?resolution=${resolution}`)
      .then((data) => {
        if (cancelled) return;
        // Server-side response is contract-enforced via @ats/shared types
        // (Stage 3 controller). We don't re-parse with Zod on the frontend
        // to keep the bundle slim — rollup struggles with the CJS shared
        // package's runtime exports, and the static types are sufficient.
        setPayload(data);
        setIsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof ApiError ? e.message : (e as Error)?.message || 'Unknown error';
        setError(msg);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [episodeId, resolution]);

  if (isLoading) {
    return <SkeletonPage />;
  }

  if (error) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 rounded p-4 text-sm text-red-700 dark:text-red-300">
          <div className="font-medium mb-1">Failed to load episode</div>
          <div className="text-xs opacity-80">{error}</div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setResolution((r) => r)}
              className="text-xs px-2 py-1 border border-red-300 rounded hover:bg-red-100"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="text-xs px-2 py-1 border border-stone-300 rounded hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!payload) return null;

  return (
    <EpisodeTraceContent
      payload={payload}
      resolution={resolution}
      onResolutionChange={(r) => {
        setResolution(r);
        const next = new URLSearchParams(searchParams);
        next.set('res', r);
        setSearchParams(next, { replace: true });
      }}
    />
  );
}

// ─── Inner content (separated so the timeline state hook only mounts once
//     payload is loaded — episode data is required for derived state) ────
function EpisodeTraceContent({
  payload,
  resolution,
  onResolutionChange,
}: {
  payload: TimelinePayload;
  resolution: Resolution;
  onResolutionChange: (r: Resolution) => void;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const ts = useTimelineState(payload.episode);
  const episodeStartedAt = useMemo(
    () => new Date(payload.episode.startedAt),
    [payload.episode.startedAt],
  );
  const episodeDurationMs = payload.episode.durationMs ?? 0;

  // ─── URL state hydration (once on mount) ───────────────────────────────
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const t = parseInt(searchParams.get('t') ?? '', 10);
    const z = parseInt(searchParams.get('zoom') ?? '', 10);
    const p = parseInt(searchParams.get('pan') ?? '', 10);
    if (Number.isFinite(t) && t >= 0) ts.setCurrentMs(t);
    if (Number.isFinite(z) && z > 0) ts.setZoomMs(z);
    if (Number.isFinite(p) && p >= 0) ts.setPanMs(p);
    // Intentionally only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── URL state sync (debounced 300ms) ─────────────────────────────────
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      next.set('t', Math.round(ts.currentMs).toString());
      next.set('zoom', Math.round(ts.zoomMs).toString());
      next.set('pan', Math.round(ts.panMs).toString());
      next.set('res', resolution);
      setSearchParams(next, { replace: true });
    }, 300);
    return () => window.clearTimeout(handle);
    // searchParams/setSearchParams are stable enough; we only need to react
    // to time/zoom/pan changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ts.currentMs, ts.zoomMs, ts.panMs, resolution]);

  const onSeek = useCallback(
    (ms: number) => {
      ts.setCurrentMs(ms);
    },
    [ts],
  );

  // ─── Stage 5: lane config, selected event, gaze mode, inspector collapse ─
  const { config: laneConfig, setVisible, setHeight, moveLane } = useLaneConfig();
  const [selectedEvent, setSelectedEvent] = useState<SelectedEvent | null>(null);
  const [gazeMode, setGazeMode] = useState<'trace' | 'density'>('trace');
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);

  // ─── Stage 6: mutation modals + audit refresh + toast ───────────────────
  const [mergeOpen, setMergeOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [splitTarget, setSplitTarget] = useState<{
    sessionId: string;
    index: number;
  } | null>(null);
  const [detachTarget, setDetachTarget] = useState<{ sessionId: string } | null>(null);
  const [auditRefreshTick, setAuditRefreshTick] = useState(0);
  const [toast, setToast] = useState<{
    msg: string;
    href?: string;
    hrefLabel?: string;
  } | null>(null);

  // Auto-dismiss the toast after 8s.
  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(h);
  }, [toast]);

  const isManual = payload.episode.groupingMethod === 'manual';

  // Click-to-jump on any lane marker: pause + seek + ensure visible window.
  const handleSelectEvent = useCallback(
    (kind: SelectedEventKind, eventPayload: unknown, tMs: number) => {
      ts.setPlaying(false);
      ts.setCurrentMs(tMs);

      // Recenter the visible window if tMs is currently outside it.
      const inWindow = tMs >= ts.panMs && tMs <= ts.panMs + ts.zoomMs;
      if (!inWindow) {
        const halfZoom = ts.zoomMs / 2;
        const desiredPan = Math.max(0, Math.min(episodeDurationMs - ts.zoomMs, tMs - halfZoom));
        ts.setPanMs(Math.max(0, desiredPan));
      }

      setSelectedEvent({ kind, tMs, payload: eventPayload });
    },
    [ts, episodeDurationMs],
  );

  const selectedEventDomId = useMemo(() => {
    if (!selectedEvent) return null;
    const p = selectedEvent.payload as { messageId?: string; constructKey?: string };
    if (selectedEvent.kind === 'efDetection' && p.messageId && p.constructKey) {
      return `ef-${p.messageId}-${p.constructKey}`;
    }
    return null;
  }, [selectedEvent]);

  const groupingLabel = useMemo(() => {
    const m = payload.episode.groupingMethod.replace(/_/g, ' ');
    if (
      payload.episode.groupingMethod === 'auto_heuristic' &&
      payload.episode.groupingConfidence !== null
    ) {
      return `${m} ${Math.round(payload.episode.groupingConfidence * 100)}%`;
    }
    return m;
  }, [payload.episode.groupingMethod, payload.episode.groupingConfidence]);

  return (
    <div className="flex flex-col h-full min-h-screen bg-stone-50 dark:bg-stone-950">
      {/* Header */}
      <header className="px-6 py-3 bg-white dark:bg-stone-900 border-b border-stone-200 dark:border-stone-700 flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-xs text-stone-600 hover:text-stone-900 dark:text-stone-300 px-2 py-1 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
        >
          ← Back
        </button>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-stone-900 dark:text-stone-100 truncate">
            Episode <span className="font-mono">{payload.episode.id.slice(0, 8)}</span>
          </h1>
          <div className="text-xs text-stone-500 truncate flex items-center gap-1.5 flex-wrap">
            <span>{episodeStartedAt.toLocaleString()}</span>
            <span>·</span>
            <span>{formatDuration(episodeDurationMs)}</span>
            <span>·</span>
            <span>
              {payload.episode.sessionCount}{' '}
              {payload.episode.sessionCount === 1 ? 'session' : 'sessions'}
            </span>
            <span>·</span>
            <span className="capitalize">{groupingLabel}</span>
            {isManual && (
              <span
                className="ml-1 px-1.5 py-0.5 rounded bg-stone-200 dark:bg-stone-700 text-stone-700 dark:text-stone-200 text-[10px] font-medium"
                title="This episode was manually grouped by a researcher"
              >
                Manually grouped
              </span>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5">
            <span className="text-stone-500">Resolution</span>
            <select
              value={resolution}
              onChange={(e) => onResolutionChange(e.target.value as Resolution)}
              className="border border-stone-300 dark:border-stone-700 rounded px-2 py-1 bg-white dark:bg-stone-900"
            >
              {RESOLUTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setMergeOpen(true)}
            className="px-2 py-1 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800 bg-white dark:bg-stone-900"
          >
            Merge with…
          </button>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="px-2 py-1 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800 bg-white dark:bg-stone-900"
          >
            Export ▾
          </button>
        </div>
      </header>

      {/* Body */}
      <div
        className={`flex-1 px-6 py-4 grid grid-cols-1 ${
          inspectorCollapsed
            ? 'xl:grid-cols-[minmax(0,1fr)_3rem]'
            : 'xl:grid-cols-[minmax(0,1fr)_360px]'
        } gap-4`}
      >
        {/* Left: video + ruler */}
        <div className="flex flex-col gap-4 min-w-0">
          <StitchedVideoPlayer
            segments={payload.video.segments}
            episodeDurationMs={episodeDurationMs}
            currentMs={ts.currentMs}
            onTimeUpdate={(ms) => ts.setCurrentMs(ms)}
            onSeek={onSeek}
            playing={ts.playing}
            onPlayingChange={ts.setPlaying}
            playbackRate={ts.playbackRate}
            onPlaybackRateChange={ts.setPlaybackRate}
          />

          {/* Ruler + zoom controls */}
          <section aria-label="Timeline ruler" className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-stone-500">
              <span>Timeline</span>
              <span>·</span>
              <span>
                Visible window: {formatDuration(ts.zoomMs)} of {formatDuration(episodeDurationMs)}
              </span>
              <div className="ml-auto flex gap-1">
                <button
                  type="button"
                  onClick={() => ts.setZoomMs(Math.max(1000, ts.zoomMs / 2))}
                  className="px-2 py-0.5 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
                  aria-label="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => ts.setZoomMs(Math.min(episodeDurationMs, ts.zoomMs * 2))}
                  className="px-2 py-0.5 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
                  aria-label="Zoom out"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => {
                    ts.setZoomMs(episodeDurationMs);
                    ts.setPanMs(0);
                  }}
                  className="px-2 py-0.5 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
                  aria-label="Fit"
                >
                  Fit
                </button>
              </div>
            </div>

            <TimelineRuler
              episodeStartedAt={episodeStartedAt}
              episodeDurationMs={episodeDurationMs}
              currentMs={ts.currentMs}
              onSeek={onSeek}
              zoomMs={ts.zoomMs}
              onZoomChange={ts.setZoomMs}
              panMs={ts.panMs}
              onPanChange={ts.setPanMs}
              sessionBoundaries={payload.sessionBoundaries}
            />

            {payload.meta.downsampledLanes.length > 0 && (
              <div className="text-[11px] text-stone-500 italic">
                Downsampled lanes at {resolution}: {payload.meta.downsampledLanes.join(', ')}
              </div>
            )}
            {payload.meta.truncatedLanes.length > 0 && (
              <div className="text-[11px] text-amber-600 dark:text-amber-400">
                Truncated:{' '}
                {payload.meta.truncatedLanes.map((t) => `${t.lane} (${t.capHit})`).join(', ')}
              </div>
            )}
          </section>

          {/* Lanes (Stage 5) */}
          <LaneContainer
            payload={payload}
            fromMs={ts.visibleRangeMs.from}
            toMs={ts.visibleRangeMs.to}
            currentMs={ts.currentMs}
            episodeDurationMs={episodeDurationMs}
            config={laneConfig}
            onToggleVisible={(id) => setVisible(id, !laneConfig.settings[id].visible)}
            onSetHeight={setHeight}
            onMoveUp={(id) => moveLane(id, 'up')}
            onMoveDown={(id) => moveLane(id, 'down')}
            onSelectEvent={handleSelectEvent}
            selectedEventId={selectedEventDomId}
            gazeMode={gazeMode}
            onGazeModeChange={setGazeMode}
          />
        </div>

        {/* Right: inspector (Stage 5) */}
        <aside className={inspectorCollapsed ? 'hidden xl:block w-12' : 'hidden xl:block min-w-0'}>
          <div className="sticky top-4">
            <InspectorPanel
              payload={payload}
              currentMs={ts.currentMs}
              selectedEvent={selectedEvent}
              onJumpToSelected={(ms) => {
                ts.setPlaying(false);
                ts.setCurrentMs(ms);
              }}
              collapsed={inspectorCollapsed}
              onToggleCollapsed={() => setInspectorCollapsed((c) => !c)}
              refreshTick={auditRefreshTick}
              initialNotes={payload.episode.notes ?? null}
            />
          </div>
        </aside>
      </div>

      {/* Mutation modals (Stage 6) */}
      <MergeModal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        episodeId={payload.episode.id}
        courseId={payload.episode.courseId}
        studentId={payload.episode.userId}
        onMerged={(newPrimaryId) => {
          setToast({
            msg: `Episode merged → ${newPrimaryId.slice(0, 8)}.`,
            href: `/teacher/research/episodes/${newPrimaryId}`,
            hrefLabel: 'Open',
          });
          setAuditRefreshTick((t) => t + 1);
          // If the user merged INTO this episode, just refresh; if INTO a
          // different one, navigate to it.
          if (newPrimaryId !== payload.episode.id) {
            navigate(`/teacher/research/episodes/${newPrimaryId}`);
          } else {
            // Reload the timeline so aggregates are fresh.
            window.location.reload();
          }
        }}
      />
      {splitTarget && (
        <SplitModal
          open
          onClose={() => setSplitTarget(null)}
          episodeId={payload.episode.id}
          splitAtSessionId={splitTarget.sessionId}
          splitAtIndex={splitTarget.index}
          totalSessions={payload.episode.sessionCount}
          onSplit={(newId) => {
            setToast({
              msg: `Episode split — new episode ${newId.slice(0, 8)} created.`,
              href: `/teacher/research/episodes/${newId}`,
              hrefLabel: 'Open new',
            });
            setAuditRefreshTick((t) => t + 1);
            window.location.reload();
          }}
        />
      )}
      {detachTarget && (
        <DetachModal
          open
          onClose={() => setDetachTarget(null)}
          episodeId={payload.episode.id}
          sessionId={detachTarget.sessionId}
          courseId={payload.episode.courseId}
          studentId={payload.episode.userId}
          onDetached={(targetId) => {
            setToast({
              msg: `Session detached → episode ${targetId.slice(0, 8)}.`,
              href: `/teacher/research/episodes/${targetId}`,
              hrefLabel: 'Open target',
            });
            setAuditRefreshTick((t) => t + 1);
            window.location.reload();
          }}
        />
      )}
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        episodeId={payload.episode.id}
      />

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-stone-900 text-stone-50 text-xs rounded shadow-lg px-3 py-2 flex items-center gap-2"
        >
          <span>{toast.msg}</span>
          {toast.href && (
            <a href={toast.href} className="underline text-emerald-300 hover:text-emerald-200">
              {toast.hrefLabel ?? 'Open'}
            </a>
          )}
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="text-stone-400 hover:text-stone-100 ml-1"
          >
            ✕
          </button>
        </div>
      )}

      {/* Session-boundary action toolbar — discoverable handles for Split /
          Detach (Stage 6). The spec asks for a hover ⋯ menu on refresh-gap
          markers in the SVG ruler; an inline session list under the ruler
          gives equivalent discoverability without bloating the ruler with
          interactive DOM. */}
      {payload.sessionBoundaries.length > 1 && (
        <SessionsActionStrip
          payload={payload}
          onSplit={(sessionId, index) => setSplitTarget({ sessionId, index })}
          onDetach={(sessionId) => setDetachTarget({ sessionId })}
          onSeek={(ms) => {
            ts.setPlaying(false);
            ts.setCurrentMs(ms);
          }}
        />
      )}
    </div>
  );
}

function SessionsActionStrip({
  payload,
  onSplit,
  onDetach,
  onSeek,
}: {
  payload: TimelinePayload;
  onSplit: (sessionId: string, index: number) => void;
  onDetach: (sessionId: string) => void;
  onSeek: (ms: number) => void;
}) {
  return (
    <details className="fixed left-6 bottom-6 max-w-md bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded shadow text-xs">
      <summary className="px-3 py-1.5 cursor-pointer select-none text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100">
        Sessions ({payload.sessionBoundaries.length}) · Split / Detach
      </summary>
      <ul className="max-h-72 overflow-y-auto divide-y divide-stone-200 dark:divide-stone-700">
        {payload.sessionBoundaries.map((b, i) => (
          <li
            key={b.sessionId}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-800/40"
          >
            <button
              type="button"
              onClick={() => onSeek(b.sessionStartMs)}
              className="font-mono text-[11px] text-left"
              title={`Jump to +${formatDuration(b.sessionStartMs)}`}
            >
              {b.sessionId.slice(0, 8)}
            </button>
            {b.refreshGapMsBefore !== null && b.refreshGapMsBefore > 0 && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400">
                refresh +{formatDuration(b.refreshGapMsBefore)}
              </span>
            )}
            <span className="ml-auto flex gap-1">
              <button
                type="button"
                onClick={() => onSplit(b.sessionId, i)}
                disabled={i === 0}
                className="text-[10px] px-1.5 py-0.5 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-not-allowed"
                title={i === 0 ? 'Cannot split before the first session' : 'Split episode here'}
              >
                Split
              </button>
              <button
                type="button"
                onClick={() => onDetach(b.sessionId)}
                disabled={payload.sessionBoundaries.length === 1}
                className="text-[10px] px-1.5 py-0.5 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30"
              >
                Detach
              </button>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────

function SkeletonPage() {
  return (
    <div className="flex flex-col min-h-screen bg-stone-50 dark:bg-stone-950">
      <header className="px-6 py-3 border-b border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
        <div className="h-5 w-48 bg-stone-200 dark:bg-stone-800 rounded animate-pulse" />
        <div className="h-3 w-72 bg-stone-200 dark:bg-stone-800 rounded animate-pulse mt-1.5" />
      </header>
      <div className="flex-1 px-6 py-4 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
        <div className="flex flex-col gap-4">
          <div className="aspect-video w-full max-w-[1280px] bg-stone-200 dark:bg-stone-800 rounded-lg animate-pulse" />
          <div className="h-14 w-full bg-stone-200 dark:bg-stone-800 rounded animate-pulse" />
          <div className="h-32 w-full bg-stone-100 dark:bg-stone-800/60 rounded animate-pulse" />
        </div>
        <div className="hidden xl:block">
          <div className="h-64 w-full bg-stone-200 dark:bg-stone-800 rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
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
