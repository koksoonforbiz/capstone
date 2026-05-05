import { useEffect, useState } from 'react';
import type { TimelineModality } from '@ats/shared';
import { Modal } from './Modal';
import { ApiError } from '../../../lib/api';
import {
  researchMgmt,
  type ExportManifest,
  type ExportSummary,
} from '../../../lib/research-management';

/**
 * Inlined modality list — Rollup can't statically resolve named runtime
 * exports through `@ats/shared`'s CJS `__exportStar` (same trade-off as
 * Stage 4). Cleanest long-term fix: emit ESM from `packages/shared`.
 * Until then, this list must stay in sync with TIMELINE_MODALITIES in
 * `packages/shared/src/research-timeline.schema.ts`.
 */
const TIMELINE_MODALITIES = [
  'activity',
  'video',
  'gaze',
  'pupil',
  'emotion',
  'au',
  'derived',
  'ef_detection',
  'click',
  'scroll',
  'cursor',
  'visibility',
  'error',
  'affective_state',
  'at_risk',
] as const;

/**
 * Episode-scoped export (Stage 6).
 *
 * Opens with a configuration form (modality checklist + format radio +
 * include-video toggle), submits → switches to a status view, then to
 * download links. Re-opening shows past exports listed under the
 * episode's MinIO prefix.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  episodeId: string;
};

const MODALITIES_DISPLAY = TIMELINE_MODALITIES.filter((m) => m !== 'video');

const MODALITY_LABELS: Record<string, string> = {
  activity: 'Activity events',
  gaze: 'Gaze (x, y)',
  pupil: 'Pupil diameter',
  emotion: 'Emotion frames',
  au: 'Action units',
  derived: 'Derived (engagement + cognitive load)',
  ef_detection: 'EF detections',
  click: 'Clicks',
  scroll: 'Scroll position',
  cursor: 'Cursor position',
  visibility: 'Page visibility',
  error: 'Errors',
  affective_state: 'Affective state windows',
  at_risk: 'At-risk flags',
};

export function ExportModal({ open, onClose, episodeId }: Props) {
  const [phase, setPhase] = useState<'configure' | 'submitting' | 'done' | 'error'>('configure');
  const [modalities, setModalities] = useState<Set<string>>(() => new Set(MODALITIES_DISPLAY));
  const [format, setFormat] = useState<'csv' | 'jsonl'>('csv');
  const [includeVideo, setIncludeVideo] = useState(false);
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Past exports for this episode.
  const [previous, setPrevious] = useState<ExportSummary[]>([]);
  const [loadingPast, setLoadingPast] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPhase('configure');
    setManifest(null);
    setError(null);
    let cancelled = false;
    setLoadingPast(true);
    researchMgmt
      .listExports(episodeId)
      .then((d) => !cancelled && setPrevious(d))
      .catch(() => {
        /* non-fatal */
      })
      .finally(() => !cancelled && setLoadingPast(false));
    return () => {
      cancelled = true;
    };
  }, [open, episodeId]);

  function toggleModality(m: string) {
    setModalities((s) => {
      const n = new Set(s);
      if (n.has(m)) n.delete(m);
      else n.add(m);
      return n;
    });
  }

  async function submit() {
    if (modalities.size === 0) {
      setError('Select at least one modality.');
      return;
    }
    setPhase('submitting');
    setError(null);
    try {
      const res = await researchMgmt.createExport(episodeId, {
        modalities: [...modalities] as TimelineModality[],
        format,
        includeVideo,
      });
      setManifest(res);
      setPhase('done');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setPhase('error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export episode"
      width={560}
      footer={
        phase === 'configure' ? (
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
              disabled={modalities.size === 0}
              className="px-3 py-1 bg-stone-800 text-white rounded hover:bg-stone-700 disabled:opacity-40"
            >
              Generate export
            </button>
          </>
        ) : phase === 'done' || phase === 'error' ? (
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
          >
            Close
          </button>
        ) : null
      }
    >
      {phase === 'configure' && (
        <>
          <section>
            <h3 className="font-medium mb-1.5 text-stone-700 dark:text-stone-200">Modalities</h3>
            <div className="grid grid-cols-2 gap-y-1 gap-x-3">
              {MODALITIES_DISPLAY.map((m) => (
                <label key={m} className="flex items-center gap-1.5 text-[11px]">
                  <input
                    type="checkbox"
                    checked={modalities.has(m)}
                    onChange={() => toggleModality(m)}
                  />
                  <span>{MODALITY_LABELS[m] ?? m}</span>
                </label>
              ))}
            </div>
            <div className="mt-1.5 text-[10px] text-stone-400">
              {modalities.size} of {MODALITIES_DISPLAY.length} selected
            </div>
          </section>

          <section className="mt-4">
            <h3 className="font-medium mb-1.5 text-stone-700 dark:text-stone-200">Format</h3>
            <div className="flex gap-3 text-[11px]">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="export-format"
                  checked={format === 'csv'}
                  onChange={() => setFormat('csv')}
                />
                <span>CSV (one file per modality)</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="export-format"
                  checked={format === 'jsonl'}
                  onChange={() => setFormat('jsonl')}
                />
                <span>JSONL (one row per line)</span>
              </label>
            </div>
          </section>

          <section className="mt-4">
            <h3 className="font-medium mb-1.5 text-stone-700 dark:text-stone-200">Video</h3>
            <label className="flex items-start gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={includeVideo}
                onChange={(e) => setIncludeVideo(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Include video segment URLs</span>
                <br />
                <span className="text-stone-400">
                  Adds <code>video_manifest.json</code> with 24-hour signed URLs to every recording
                  segment. Treat the export bundle as confidential — these URLs grant direct access
                  to webcam footage.
                </span>
              </span>
            </label>
          </section>

          {error && <div className="mt-3 text-red-600 text-[11px]">{error}</div>}

          {previous.length > 0 && (
            <section className="mt-5 border-t border-stone-200 dark:border-stone-700 pt-3">
              <h3 className="font-medium text-stone-700 dark:text-stone-200 mb-1.5">
                Previous exports
              </h3>
              <ul className="text-[11px] space-y-1">
                {previous.map((p) => (
                  <li key={p.exportId} className="flex items-center gap-2">
                    <span className="text-stone-400 font-mono">
                      {new Date(p.createdAt).toLocaleString()}
                    </span>
                    <span>· {p.format}</span>
                    <span>· {p.fileCount} files</span>
                    {p.includeVideo && <span>· +video</span>}
                    <a
                      href={p.manifestSignedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto underline hover:text-stone-700 dark:hover:text-stone-200"
                    >
                      manifest
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {loadingPast && (
            <div className="mt-3 text-[10px] text-stone-400 italic">Loading past exports…</div>
          )}
        </>
      )}

      {phase === 'submitting' && (
        <div className="text-stone-500 text-center py-12">
          <div className="animate-pulse">Generating export bundle…</div>
          <div className="text-[10px] mt-2 text-stone-400">
            Pulling raw modality data and writing files to MinIO.
          </div>
        </div>
      )}

      {phase === 'done' && manifest && (
        <>
          <div className="text-emerald-600 dark:text-emerald-400 mb-3">
            ✓ Export ready. URLs valid for 24 hours.
          </div>
          <ul className="border border-stone-200 dark:border-stone-700 rounded divide-y divide-stone-200 dark:divide-stone-700 max-h-64 overflow-y-auto">
            {manifest.files.map((f) => (
              <li key={f.key} className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                <span className="font-mono text-stone-700 dark:text-stone-200">
                  {f.modality}.{f.format === 'csv' ? 'csv' : 'jsonl'}
                </span>
                <span className="text-stone-400">{f.rowCount} rows</span>
                <a
                  href={f.signedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto underline text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100"
                >
                  Download
                </a>
              </li>
            ))}
            {manifest.videoManifestSignedUrl && (
              <li className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                <span className="font-mono text-stone-700 dark:text-stone-200">
                  video_manifest.json
                </span>
                <span className="text-stone-400">segment URLs (24h)</span>
                <a
                  href={manifest.videoManifestSignedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto underline text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100"
                >
                  Download
                </a>
              </li>
            )}
          </ul>
        </>
      )}

      {phase === 'error' && <div className="text-red-600">{error ?? 'Export failed'}</div>}
    </Modal>
  );
}
