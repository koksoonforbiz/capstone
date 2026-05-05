import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { EpisodeListItem, EpisodeListResponse } from '@ats/shared';
import { api, ApiError } from '../../../lib/api';

/**
 * Teacher portal — list of learning episodes for a given (course, student)
 * pair. Clicking a row opens the retrospective tracing page (Stage 4).
 *
 * Backed by Stage-3 endpoint:
 *   GET /api/research/courses/:courseId/students/:studentId/episodes
 */

type SortKey = 'startedAt' | 'durationMs' | 'sessionCount' | 'totalActiveSecs';
type SortDir = 'asc' | 'desc';

export function EpisodePickerPage() {
  const { courseId, studentId } = useParams<{ courseId: string; studentId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [episodes, setEpisodes] = useState<EpisodeListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Filters (URL-backed so the link stays shareable).
  const fromParam = searchParams.get('from') ?? '';
  const toParam = searchParams.get('to') ?? '';
  const hasVideoOnly = searchParams.get('hasVideo') === '1';
  const minDurationMin = parseInt(searchParams.get('minDuration') ?? '0', 10) || 0;

  const [sortKey, setSortKey] = useState<SortKey>('startedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // ─── Fetch ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!courseId || !studentId) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const qs = new URLSearchParams();
    if (fromParam) qs.set('from', fromParam);
    if (toParam) qs.set('to', toParam);
    qs.set('limit', '200');
    const path =
      `/research/courses/${courseId}/students/${studentId}/episodes` +
      (qs.toString() ? `?${qs.toString()}` : '');

    api
      .get<EpisodeListResponse>(path)
      .then((data) => {
        if (cancelled) return;
        setEpisodes(data.episodes);
        setTotal(data.total);
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
  }, [courseId, studentId, fromParam, toParam, refreshTick]);

  // ─── Filter + sort ────────────────────────────────────────────────────
  const filteredSorted = useMemo(() => {
    const minMs = minDurationMin * 60_000;
    const filtered = episodes.filter((ep) => {
      if (hasVideoOnly && !ep.hasVideo) return false;
      if (minMs > 0 && (ep.durationMs ?? 0) < minMs) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      const sign = sortDir === 'asc' ? 1 : -1;
      switch (sortKey) {
        case 'startedAt':
          return sign * (Date.parse(a.startedAt) - Date.parse(b.startedAt));
        case 'durationMs':
          return sign * ((a.durationMs ?? 0) - (b.durationMs ?? 0));
        case 'sessionCount':
          return sign * (a.sessionCount - b.sessionCount);
        case 'totalActiveSecs':
          return sign * (a.totalActiveSecs - b.totalActiveSecs);
      }
    });
    return sorted;
  }, [episodes, hasVideoOnly, minDurationMin, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'startedAt' ? 'desc' : 'desc');
    }
  }

  function setFilter(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-stone-900 dark:text-stone-100">
              Learning episodes
            </h1>
            <p className="text-xs text-stone-500 mt-0.5">
              Course <span className="font-mono">{courseId?.slice(0, 8)}</span>
              <span className="mx-1.5">·</span>
              Student <span className="font-mono">{studentId?.slice(0, 8)}</span>
              {!isLoading && (
                <>
                  <span className="mx-1.5">·</span>
                  {total} {total === 1 ? 'episode' : 'episodes'}
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="text-xs text-stone-600 hover:text-stone-900 dark:text-stone-300 px-2 py-1 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
          >
            Refresh
          </button>
        </div>

        {/* Filter row */}
        <div className="mt-4 flex flex-wrap gap-3 items-end text-xs">
          <label className="flex flex-col">
            <span className="text-stone-500 mb-1">From</span>
            <input
              type="date"
              value={fromParam}
              onChange={(e) => setFilter('from', e.target.value || null)}
              className="border border-stone-300 dark:border-stone-700 rounded px-2 py-1 bg-white dark:bg-stone-900"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-stone-500 mb-1">To</span>
            <input
              type="date"
              value={toParam}
              onChange={(e) => setFilter('to', e.target.value || null)}
              className="border border-stone-300 dark:border-stone-700 rounded px-2 py-1 bg-white dark:bg-stone-900"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-stone-500 mb-1">Min duration (min)</span>
            <input
              type="number"
              min={0}
              value={minDurationMin || ''}
              onChange={(e) => setFilter('minDuration', e.target.value || null)}
              className="border border-stone-300 dark:border-stone-700 rounded px-2 py-1 bg-white dark:bg-stone-900 w-20"
            />
          </label>
          <label className="flex items-center gap-2 ml-1">
            <input
              type="checkbox"
              checked={hasVideoOnly}
              onChange={(e) => setFilter('hasVideo', e.target.checked ? '1' : null)}
              className="rounded"
            />
            <span>Has video only</span>
          </label>
        </div>
      </header>

      {/* Body */}
      {isLoading && (
        <div className="space-y-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 rounded bg-stone-100 dark:bg-stone-800 animate-pulse" />
          ))}
        </div>
      )}

      {error && !isLoading && (
        <div className="border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 rounded p-4 text-sm text-red-700 dark:text-red-300">
          <div className="font-medium mb-1">Failed to load episodes</div>
          <div className="text-xs opacity-80">{error}</div>
          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="mt-2 text-xs px-2 py-1 border border-red-300 rounded hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && filteredSorted.length === 0 && (
        <div className="text-center py-16 text-stone-400 text-sm">
          {episodes.length === 0
            ? 'No episodes yet for this student.'
            : 'No episodes match the current filters.'}
        </div>
      )}

      {!isLoading && !error && filteredSorted.length > 0 && (
        <div className="overflow-x-auto border border-stone-200 dark:border-stone-700 rounded">
          <table className="min-w-full text-xs">
            <thead className="bg-stone-50 dark:bg-stone-900 text-stone-500">
              <tr>
                <Th
                  label="Started"
                  sortable
                  onClick={() => toggleSort('startedAt')}
                  active={sortKey === 'startedAt'}
                  dir={sortDir}
                />
                <Th
                  label="Duration"
                  sortable
                  onClick={() => toggleSort('durationMs')}
                  active={sortKey === 'durationMs'}
                  dir={sortDir}
                />
                <Th
                  label="Sessions"
                  sortable
                  onClick={() => toggleSort('sessionCount')}
                  active={sortKey === 'sessionCount'}
                  dir={sortDir}
                />
                <Th
                  label="Active time"
                  sortable
                  onClick={() => toggleSort('totalActiveSecs')}
                  active={sortKey === 'totalActiveSecs'}
                  dir={sortDir}
                />
                <Th label="Video" />
                <Th label="Refresh gaps" />
                <Th label="At-risk flags" />
                <Th label="Grouping" />
                <Th label="" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
              {filteredSorted.map((ep) => (
                <tr
                  key={ep.id}
                  className="hover:bg-stone-50 dark:hover:bg-stone-900/60 cursor-pointer"
                  onClick={() => navigate(`/teacher/research/episodes/${ep.id}`)}
                >
                  <td className="px-3 py-2 whitespace-nowrap font-mono tabular-nums text-stone-700 dark:text-stone-200">
                    {formatStartedAt(ep.startedAt)}
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums">
                    {formatDuration(ep.durationMs)}
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums">{ep.sessionCount}</td>
                  <td className="px-3 py-2 font-mono tabular-nums">
                    {formatActiveSecs(ep.totalActiveSecs)}
                  </td>
                  <td className="px-3 py-2">
                    <VideoIcon hasVideo={ep.hasVideo} />
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums">
                    {ep.flags.refreshGapCount > 0 ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        {ep.flags.refreshGapCount}
                      </span>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums">
                    {ep.flags.atRiskCount > 0 ? (
                      <span className="text-red-600 dark:text-red-400">{ep.flags.atRiskCount}</span>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <GroupingBadge method={ep.groupingMethod} confidence={ep.groupingConfidence} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      to={`/teacher/research/episodes/${ep.id}`}
                      className="text-stone-600 hover:text-stone-900 dark:text-stone-300"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function Th({
  label,
  sortable,
  onClick,
  active,
  dir,
}: {
  label: string;
  sortable?: boolean;
  onClick?: () => void;
  active?: boolean;
  dir?: SortDir;
}) {
  return (
    <th
      scope="col"
      className={`text-left px-3 py-2 font-medium uppercase text-[10px] tracking-wide ${
        sortable ? 'cursor-pointer hover:text-stone-700 dark:hover:text-stone-200' : ''
      }`}
      onClick={onClick}
    >
      {label}
      {active && sortable && <span className="ml-1">{dir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );
}

function VideoIcon({ hasVideo }: { hasVideo: boolean }) {
  return (
    <svg
      className={`w-4 h-4 ${hasVideo ? 'text-stone-700 dark:text-stone-200' : 'text-stone-300 dark:text-stone-600'}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-label={hasVideo ? 'Has video' : 'No video'}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

function GroupingBadge({ method, confidence }: { method: string; confidence: number | null }) {
  const conf = confidence ?? 1;
  let color = 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300';
  let labelExtra = '';

  if (method === 'client_episode_id') {
    color = 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
  } else if (method === 'auto_heuristic') {
    if (conf >= 0.9) {
      color = 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
    } else {
      color = 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400';
    }
    labelExtra = ` ${Math.round(conf * 100)}%`;
  } else if (method === 'manual') {
    color = 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-300';
  }

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${color}`}
    >
      {method.replace(/_/g, ' ')}
      {labelExtra}
    </span>
  );
}

// ─── Format helpers ───────────────────────────────────────────────────────

function formatStartedAt(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function formatActiveSecs(secs: number): string {
  if (secs <= 0) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
