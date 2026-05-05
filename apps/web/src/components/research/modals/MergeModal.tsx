import { useEffect, useMemo, useState } from 'react';
import type { EpisodeListItem } from '@ats/shared';
import { Modal } from './Modal';
import { api, ApiError } from '../../../lib/api';
import { researchMgmt } from '../../../lib/research-management';

/**
 * Merge episodes for a given (course, student) pair (Stage 6).
 *
 * Lists every episode for the student that is NOT already the current one,
 * and lets the researcher pick siblings to merge into the current. The
 * primary defaults to the earliest-started, but the user can pick another.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  episodeId: string;
  courseId: string;
  studentId: string;
  onMerged: (newPrimaryId: string) => void;
};

export function MergeModal({ open, onClose, episodeId, courseId, studentId, onMerged }: Props) {
  const [candidates, setCandidates] = useState<EpisodeListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [primary, setPrimary] = useState<string>(episodeId);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset state when the modal opens.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set([episodeId]));
    setPrimary(episodeId);
    setReason('');
    setSubmitError(null);
  }, [open, episodeId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .get<{ total: number; episodes: EpisodeListItem[] }>(
        `/research/courses/${courseId}/students/${studentId}/episodes?limit=100`,
      )
      .then((data) => {
        if (cancelled) return;
        setCandidates(data.episodes);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof ApiError ? e.message : (e as Error).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, courseId, studentId]);

  const sorted = useMemo(
    () => [...candidates].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
    [candidates],
  );

  const toggle = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) {
        if (n.size === 1) return n; // never empty — can't merge nothing
        n.delete(id);
        if (primary === id) {
          // Pick the smallest remaining as new primary.
          const next = [...n][0];
          if (next) setPrimary(next);
        }
      } else {
        n.add(id);
      }
      return n;
    });
  };

  async function submit() {
    if (selected.size < 2) {
      setSubmitError('Pick at least one other episode to merge with.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await researchMgmt.merge({
        episodeIds: [...selected],
        primaryId: primary,
        reason: reason.trim() || undefined,
      });
      onMerged(res.episodeId);
      onClose();
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge episodes"
      width={560}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={selected.size < 2 || submitting}
            className="px-3 py-1 bg-stone-800 text-white rounded hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Merging…' : `Merge ${selected.size} episodes`}
          </button>
        </>
      }
    >
      <p className="text-stone-600 dark:text-stone-400 mb-3">
        Select episodes to merge into a single sitting. The primary keeps its ID and inherits all
        sessions; donors are soft-deleted but stay resolvable for citations.
      </p>

      {loading && <div className="text-stone-400">Loading episodes…</div>}
      {loadError && <div className="text-red-600">Failed to load: {loadError}</div>}

      {!loading && !loadError && (
        <div className="border border-stone-200 dark:border-stone-700 rounded divide-y divide-stone-200 dark:divide-stone-700 max-h-72 overflow-y-auto">
          {sorted.map((ep) => {
            const isSelected = selected.has(ep.id);
            const isPrimary = primary === ep.id;
            return (
              <label
                key={ep.id}
                className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50 ${
                  isSelected ? 'bg-stone-50 dark:bg-stone-800/30' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(ep.id)}
                  className="rounded"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[11px] text-stone-700 dark:text-stone-200">
                    {ep.id.slice(0, 8)} · {formatDate(ep.startedAt)}
                  </div>
                  <div className="text-[10px] text-stone-500">
                    {ep.sessionCount} sess · {formatDuration(ep.durationMs)} · {ep.groupingMethod}
                  </div>
                </div>
                {isSelected && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      setPrimary(ep.id);
                    }}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      isPrimary
                        ? 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/30 dark:text-emerald-400'
                        : 'bg-white dark:bg-stone-900 border-stone-300 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800'
                    }`}
                  >
                    {isPrimary ? '★ primary' : 'set as primary'}
                  </button>
                )}
              </label>
            );
          })}
        </div>
      )}

      <label className="block mt-4">
        <span className="text-stone-500 mb-1 block">Reason (logged in audit trail)</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. same student session, slow refresh after IP change"
          className="w-full border border-stone-300 dark:border-stone-700 rounded px-2 py-1 bg-white dark:bg-stone-950"
        />
      </label>

      {submitError && <div className="mt-3 text-red-600 text-[11px]">{submitError}</div>}
    </Modal>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
