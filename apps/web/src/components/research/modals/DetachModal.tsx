import { useEffect, useState } from 'react';
import type { EpisodeListItem } from '@ats/shared';
import { Modal } from './Modal';
import { api, ApiError } from '../../../lib/api';
import { researchMgmt } from '../../../lib/research-management';

/**
 * Detach a single session from its current episode and either move it to
 * an existing sibling episode or spin off a new one.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  episodeId: string;
  sessionId: string;
  courseId: string;
  studentId: string;
  onDetached: (targetEpisodeId: string) => void;
};

export function DetachModal({
  open,
  onClose,
  episodeId,
  sessionId,
  courseId,
  studentId,
  onDetached,
}: Props) {
  const [target, setTarget] = useState<'new' | string>('new');
  const [reason, setReason] = useState('');
  const [siblings, setSiblings] = useState<EpisodeListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget('new');
    setReason('');
    setError(null);
    let cancelled = false;
    setLoading(true);
    api
      .get<{ total: number; episodes: EpisodeListItem[] }>(
        `/research/courses/${courseId}/students/${studentId}/episodes?limit=100`,
      )
      .then((data) => {
        if (cancelled) return;
        setSiblings(data.episodes.filter((e) => e.id !== episodeId));
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : (e as Error).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, episodeId, courseId, studentId]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await researchMgmt.detachSession(episodeId, {
        sessionId,
        targetEpisodeId: target === 'new' ? undefined : target,
        reason: reason.trim() || undefined,
      });
      onDetached(res.targetEpisodeId);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Detach session"
      width={520}
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
            disabled={submitting}
            className="px-3 py-1 bg-stone-800 text-white rounded hover:bg-stone-700 disabled:opacity-40"
          >
            {submitting ? 'Detaching…' : 'Detach'}
          </button>
        </>
      }
    >
      <p className="text-stone-600 dark:text-stone-400 mb-3">
        Move session <code className="font-mono text-[10px]">{sessionId.slice(0, 8)}</code> out of
        this episode.
      </p>

      <fieldset className="space-y-2">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="detach-target"
            checked={target === 'new'}
            onChange={() => setTarget('new')}
          />
          <span>To a new episode</span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="detach-target"
            checked={target !== 'new'}
            onChange={() => {
              const first = siblings[0];
              if (first) setTarget(first.id);
            }}
            disabled={siblings.length === 0}
          />
          <div className="flex-1">
            <span>To existing episode</span>
            <select
              value={target === 'new' ? '' : target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={target === 'new' || siblings.length === 0}
              className="block mt-1 w-full border border-stone-300 dark:border-stone-700 rounded px-2 py-1 bg-white dark:bg-stone-950"
            >
              {siblings.length === 0 && <option value="">No sibling episodes</option>}
              {siblings.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id.slice(0, 8)} · {formatDate(s.startedAt)} · {s.sessionCount} sess
                </option>
              ))}
            </select>
          </div>
        </label>
      </fieldset>

      <label className="block mt-4">
        <span className="text-stone-500 mb-1 block">Reason (logged in audit trail)</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full border border-stone-300 dark:border-stone-700 rounded px-2 py-1 bg-white dark:bg-stone-950"
        />
      </label>

      {loading && <div className="mt-3 text-stone-400 text-[11px]">Loading siblings…</div>}
      {error && <div className="mt-3 text-red-600 text-[11px]">{error}</div>}
    </Modal>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
