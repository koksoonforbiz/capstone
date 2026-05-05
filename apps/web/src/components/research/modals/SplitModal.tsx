import { useState } from 'react';
import { Modal } from './Modal';
import { ApiError } from '../../../lib/api';
import { researchMgmt } from '../../../lib/research-management';

type Props = {
  open: boolean;
  onClose: () => void;
  episodeId: string;
  splitAtSessionId: string;
  /** Position in the session list (0-based). For UX framing only. */
  splitAtIndex: number;
  totalSessions: number;
  onSplit: (newEpisodeId: string) => void;
};

export function SplitModal({
  open,
  onClose,
  episodeId,
  splitAtSessionId,
  splitAtIndex,
  totalSessions,
  onSplit,
}: Props) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const movedCount = totalSessions - splitAtIndex;
  const remainingCount = splitAtIndex;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await researchMgmt.split(episodeId, {
        splitAtSessionId,
        reason: reason.trim() || undefined,
      });
      onSplit(res.newEpisodeId);
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
      title="Split episode"
      width={460}
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
            disabled={submitting || splitAtIndex === 0}
            className="px-3 py-1 bg-stone-800 text-white rounded hover:bg-stone-700 disabled:opacity-40"
          >
            {submitting ? 'Splitting…' : 'Split here'}
          </button>
        </>
      }
    >
      {splitAtIndex === 0 ? (
        <div className="text-amber-600 dark:text-amber-400 text-[11px]">
          Cannot split at the first session — that would leave the source episode empty.
        </div>
      ) : (
        <>
          <p className="text-stone-600 dark:text-stone-400 mb-2">
            This will keep {remainingCount} session{remainingCount === 1 ? '' : 's'} on the current
            episode and move {movedCount} session
            {movedCount === 1 ? '' : 's'} into a new episode. Both will be marked{' '}
            <code>manual</code> from here on.
          </p>
          <label className="block">
            <span className="text-stone-500 mb-1 block">Reason (logged in audit trail)</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. different sitting after long break"
              className="w-full border border-stone-300 dark:border-stone-700 rounded px-2 py-1 bg-white dark:bg-stone-950"
            />
          </label>
          {error && <div className="mt-3 text-red-600 text-[11px]">{error}</div>}
        </>
      )}
    </Modal>
  );
}
