import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelinePayload } from '@ats/shared';
import { useThrottled } from '../../hooks/useThrottled';
import { GazeMiniMap } from './GazeMiniMap';
import { researchMgmt, summarizeAudit, type AuditEntry } from '../../lib/research-management';
import { ApiError } from '../../lib/api';

/**
 * Inspector panel (Stage 5).
 *
 * Tabbed right-side panel showing context for the playhead position or a
 * selected event. Five tabs:
 *   • Now — live readout of every modality at currentMs
 *   • Selected event — full payload for the marker that was clicked
 *   • Session info — metadata for the session containing currentMs
 *   • Notes — text area (persisting via API lands in Stage 6)
 */

type Tab = 'now' | 'selected' | 'session' | 'notes';

export type SelectedEvent = {
  kind: string;
  tMs: number;
  payload: unknown;
};

type Props = {
  payload: TimelinePayload;
  currentMs: number;
  selectedEvent: SelectedEvent | null;
  onJumpToSelected: (ms: number) => void;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Bumped externally after a mutation lands so audit + notes refresh. */
  refreshTick?: number;
  /** Initial notes from the timeline payload (pre-fetched). */
  initialNotes?: string | null;
};

export function InspectorPanel({
  payload,
  currentMs,
  selectedEvent,
  onJumpToSelected,
  onClose,
  collapsed,
  onToggleCollapsed,
  refreshTick = 0,
  initialNotes = null,
}: Props) {
  const [tab, setTab] = useState<Tab>('now');

  // Whenever a new event is selected, snap to the "Selected" tab.
  const lastSelectedKeyRef = useRef<string>('');
  const selectedKey = selectedEvent ? `${selectedEvent.kind}|${selectedEvent.tMs}` : '';
  useEffect(() => {
    if (selectedKey && lastSelectedKeyRef.current !== selectedKey) {
      lastSelectedKeyRef.current = selectedKey;
      setTab('selected');
    }
  }, [selectedKey]);

  if (collapsed) {
    return (
      <div className="border border-stone-200 dark:border-stone-700 rounded bg-white dark:bg-stone-900 p-2 flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          aria-label="Expand inspector"
          title="Expand inspector"
        >
          ◀
        </button>
        <div className="text-[10px] text-stone-400 [writing-mode:vertical-rl] rotate-180">
          Inspector
        </div>
      </div>
    );
  }

  return (
    <div className="border border-stone-200 dark:border-stone-700 rounded bg-white dark:bg-stone-900 flex flex-col h-full max-h-[calc(100vh-7rem)] overflow-hidden">
      <header className="flex items-center border-b border-stone-200 dark:border-stone-700 text-xs">
        <TabButton active={tab === 'now'} onClick={() => setTab('now')}>
          Now
        </TabButton>
        <TabButton active={tab === 'selected'} onClick={() => setTab('selected')}>
          Selected
        </TabButton>
        <TabButton active={tab === 'session'} onClick={() => setTab('session')}>
          Session
        </TabButton>
        <TabButton active={tab === 'notes'} onClick={() => setTab('notes')}>
          Notes
        </TabButton>
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Collapse inspector"
            className="ml-auto px-2 py-1.5 text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          >
            ▶
          </button>
        )}
        {onClose && !onToggleCollapsed && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            className="ml-auto px-2 py-1.5 text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          >
            ✕
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-3 text-xs text-stone-700 dark:text-stone-200 space-y-3">
        {tab === 'now' && <NowTab payload={payload} currentMs={currentMs} />}
        {tab === 'selected' && <SelectedTab event={selectedEvent} onJumpTo={onJumpToSelected} />}
        {tab === 'session' && (
          <SessionTab payload={payload} currentMs={currentMs} refreshTick={refreshTick} />
        )}
        {tab === 'notes' && (
          <NotesTab
            episodeId={payload.episode.id}
            initialNotes={initialNotes}
            refreshTick={refreshTick}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 border-r border-stone-200 dark:border-stone-700 ${
        active
          ? 'bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 font-medium'
          : 'bg-stone-50 dark:bg-stone-900/40 text-stone-500 hover:text-stone-700 dark:hover:text-stone-200'
      }`}
    >
      {children}
    </button>
  );
}

// ─── Now ────────────────────────────────────────────────────────────────

function NowTab({ payload, currentMs }: { payload: TimelinePayload; currentMs: number }) {
  // Throttle to 250ms to avoid 60Hz re-renders during playback.
  const tMs = useThrottled(currentMs, 250);
  const lanes = payload.lanes;

  const currentActivity = useMemo(
    () => findLatestAtOrBefore(lanes.activity ?? [], (r) => r.tMs, tMs),
    [lanes.activity, tMs],
  );
  const currentGaze = useMemo(
    () => findLatestAtOrBefore(lanes.gaze ?? [], (r) => r.tMs, tMs),
    [lanes.gaze, tMs],
  );
  const currentPupil = useMemo(
    () => findLatestAtOrBefore(lanes.pupil ?? [], (r) => r.tMs, tMs),
    [lanes.pupil, tMs],
  );
  const currentEmotion = useMemo(
    () => findLatestAtOrBefore(lanes.emotion ?? [], (r) => r.tMs, tMs),
    [lanes.emotion, tMs],
  );
  const currentAU = useMemo(
    () => findLatestAtOrBefore(lanes.au ?? [], (r) => r.tMs, tMs),
    [lanes.au, tMs],
  );
  const currentAffective = useMemo(() => {
    const rows = lanes.affective ?? [];
    for (const w of rows) if (w.startMs <= tMs && tMs <= w.endMs) return w;
    return null;
  }, [lanes.affective, tMs]);
  const currentEngagement = useMemo(() => {
    const rows = lanes.derived?.engagement ?? [];
    for (const w of rows) if (w.startMs <= tMs && tMs <= w.endMs) return w;
    return null;
  }, [lanes.derived, tMs]);
  const currentCognitiveLoad = useMemo(() => {
    const rows = lanes.derived?.cognitiveLoad ?? [];
    for (const w of rows) if (w.startMs <= tMs && tMs <= w.endMs) return w;
    return null;
  }, [lanes.derived, tMs]);

  // Gaze trail — last ~2s before tMs, up to 60 points.
  const gazeTrail = useMemo(() => {
    const rows = lanes.gaze ?? [];
    const out: { tMs: number; x: number; y: number }[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.tMs > tMs) continue;
      if (tMs - r.tMs > 2000) break;
      out.push({ tMs: r.tMs, x: r.x, y: r.y });
      if (out.length >= 60) break;
    }
    return out.reverse();
  }, [lanes.gaze, tMs]);

  // AU spikes — values > 1.0.
  const auSpikes = useMemo(() => {
    if (!currentAU) return [];
    return Object.entries(currentAU.aus ?? {})
      .filter(([, v]) => v !== null && v !== undefined && v > 1.0)
      .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`);
  }, [currentAU]);

  return (
    <>
      <Section label="Time">
        <Row label="t" value={`+${formatHMS(tMs)}`} />
      </Section>

      <Section label="Activity">
        {currentActivity ? (
          <>
            <Row label="action" value={currentActivity.action} />
          </>
        ) : (
          <Empty />
        )}
      </Section>

      <Section label="Gaze">
        {currentGaze ? (
          <>
            <Row label="x" value={currentGaze.x.toFixed(0)} />
            <Row label="y" value={currentGaze.y.toFixed(0)} />
            <Row
              label="conf"
              value={currentGaze.conf !== null ? currentGaze.conf.toFixed(2) : 'unknown'}
            />
            <div className="mt-1.5">
              <GazeMiniMap
                trail={gazeTrail}
                current={{
                  x: currentGaze.x,
                  y: currentGaze.y,
                  conf: currentGaze.conf,
                }}
              />
            </div>
          </>
        ) : (
          <Empty>not tracking</Empty>
        )}
      </Section>

      <Section label="Pupil">
        {currentPupil ? (
          <Row label="diameter" value={`${currentPupil.diameter.toFixed(2)} mm`} />
        ) : (
          <Empty />
        )}
      </Section>

      <Section label="Emotion">
        {currentEmotion ? (
          <>
            <Row label="dominant" value={currentEmotion.dominant ?? '—'} />
            {Object.entries(currentEmotion.scores ?? {})
              .filter(([, v]) => v !== null && v !== undefined)
              .sort(([, a], [, b]) => ((b as number | null) ?? 0) - ((a as number | null) ?? 0))
              .slice(0, 3)
              .map(([k, v]) => (
                <Row key={k} label={k} value={(v as number).toFixed(2)} />
              ))}
          </>
        ) : (
          <Empty />
        )}
      </Section>

      <Section label="AU spikes (>1.0)">
        {auSpikes.length > 0 ? (
          <div className="font-mono text-[10px] flex flex-wrap gap-1">
            {auSpikes.map((s) => (
              <span key={s} className="px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800">
                {s}
              </span>
            ))}
          </div>
        ) : (
          <Empty>no spikes</Empty>
        )}
      </Section>

      <Section label="Affective state">
        {currentAffective ? (
          <>
            <Row label="state" value={currentAffective.dominantState} />
            <Row label="engagement" value={currentAffective.engagement.toFixed(2)} />
            <Row label="boredom" value={currentAffective.boredom.toFixed(2)} />
            <Row label="confusion" value={currentAffective.confusion.toFixed(2)} />
            <Row label="frustration" value={currentAffective.frustration.toFixed(2)} />
          </>
        ) : (
          <Empty />
        )}
      </Section>

      <Section label="Derived">
        {currentEngagement || currentCognitiveLoad ? (
          <>
            {currentEngagement && (
              <Row label="engagement" value={currentEngagement.score.toFixed(2)} />
            )}
            {currentCognitiveLoad && (
              <Row label="cognitive load" value={currentCognitiveLoad.score.toFixed(2)} />
            )}
          </>
        ) : (
          <Empty />
        )}
      </Section>
    </>
  );
}

// ─── Selected event ─────────────────────────────────────────────────────

function SelectedTab({
  event,
  onJumpTo,
}: {
  event: SelectedEvent | null;
  onJumpTo: (ms: number) => void;
}) {
  if (!event) {
    return <Empty>Click any marker in the lanes below to inspect it.</Empty>;
  }
  const json = JSON.stringify(event.payload, null, 2);

  function copy() {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(json);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-stone-400">{event.kind}</span>
        <span className="font-mono text-[10px] text-stone-500">+{formatHMS(event.tMs)}</span>
        <button
          type="button"
          onClick={() => onJumpTo(event.tMs)}
          className="ml-auto text-[10px] px-2 py-0.5 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
        >
          Jump to
        </button>
        <button
          type="button"
          onClick={copy}
          className="text-[10px] px-2 py-0.5 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
        >
          Copy
        </button>
      </div>
      <pre className="text-[10px] font-mono bg-stone-50 dark:bg-stone-950 p-2 rounded border border-stone-200 dark:border-stone-700 overflow-x-auto whitespace-pre">
        {json}
      </pre>
    </>
  );
}

// ─── Session ────────────────────────────────────────────────────────────

function SessionTab({
  payload,
  currentMs,
  refreshTick,
}: {
  payload: TimelinePayload;
  currentMs: number;
  refreshTick: number;
}) {
  const session = useMemo(() => {
    const sorted = [...payload.sessionBoundaries].sort(
      (a, b) => a.sessionStartMs - b.sessionStartMs,
    );
    let active = sorted[0] ?? null;
    for (const s of sorted) {
      if (s.sessionStartMs <= currentMs) active = s;
    }
    return active;
  }, [payload.sessionBoundaries, currentMs]);

  // Episode-level audit history (Stage 6).
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAuditLoading(true);
    setAuditError(null);
    researchMgmt
      .getAudit(payload.episode.id)
      .then((rows) => {
        if (cancelled) return;
        setAudits(rows);
        setAuditLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setAuditError(e instanceof ApiError ? e.message : (e as Error).message);
        setAuditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [payload.episode.id, refreshTick]);

  return (
    <>
      {session ? (
        <>
          <Section label="Session">
            <Row label="ID" value={session.sessionId} mono />
            <Row label="startedAt" value={`+${formatHMS(session.sessionStartMs)}`} mono />
            <Row
              label="endedAt"
              value={
                session.sessionEndMs !== null
                  ? `+${formatHMS(session.sessionEndMs)}`
                  : '— (still open)'
              }
              mono
            />
            {session.userAgent && <Row label="UA" value={session.userAgent} />}
            {session.ipAddress && <Row label="IP" value={session.ipAddress} mono />}
          </Section>
          <Section label="Refresh gap">
            {(() => {
              const idx = payload.sessionBoundaries.findIndex(
                (s) => s.sessionId === session.sessionId,
              );
              const next = payload.sessionBoundaries[idx + 1] ?? null;
              const refreshGap = next?.refreshGapMsBefore ?? null;
              return refreshGap !== null && refreshGap > 0 ? (
                <Row label="to next session" value={formatGap(refreshGap)} />
              ) : (
                <Empty>no gap to next session</Empty>
              );
            })()}
          </Section>
        </>
      ) : (
        <Empty>No session recorded at this point.</Empty>
      )}

      {/* Episode-level audit trail (Stage 6) */}
      <Section label="Episode history">
        {auditLoading && <Empty>loading…</Empty>}
        {auditError && <div className="text-red-600 text-[11px]">{auditError}</div>}
        {!auditLoading && !auditError && audits.length === 0 && <Empty>no audit entries yet</Empty>}
        {!auditLoading && audits.length > 0 && (
          <ul className="space-y-1.5 mt-1">
            {audits.map((a) => (
              <li key={a.id} className="border-l-2 border-stone-300 dark:border-stone-700 pl-2">
                <div className="text-[10px] text-stone-400">
                  {new Date(a.createdAt).toLocaleString()}
                  <span className="mx-1">·</span>
                  {a.actor?.name ?? 'system'}
                </div>
                <div className="text-[11px]">{summarizeAudit(a)}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

// ─── Notes ──────────────────────────────────────────────────────────────

function NotesTab({
  episodeId,
  initialNotes,
  refreshTick,
}: {
  episodeId: string;
  initialNotes: string | null;
  refreshTick: number;
}) {
  const [value, setValue] = useState(initialNotes ?? '');
  const [savedValue, setSavedValue] = useState(initialNotes ?? '');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resync if the episode changes externally (refreshTick bump from a
  // mutation).
  useEffect(() => {
    setValue(initialNotes ?? '');
    setSavedValue(initialNotes ?? '');
  }, [initialNotes, refreshTick]);

  const dirty = value !== savedValue;

  const save = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      const res = await researchMgmt.annotate(episodeId, value);
      setSavedValue(res.notes);
      setSavedAt(new Date());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [episodeId, value, dirty]);

  return (
    <>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        rows={10}
        className="w-full text-xs border border-stone-300 dark:border-stone-700 rounded p-2 bg-stone-50 dark:bg-stone-950"
        placeholder="Researcher notes for this episode (auto-saves on blur)…"
      />
      <div className="mt-2 flex items-center gap-2 text-[10px] text-stone-400">
        {saving ? (
          <span>Saving…</span>
        ) : dirty ? (
          <button
            type="button"
            onClick={save}
            className="px-2 py-0.5 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200"
          >
            Save now
          </button>
        ) : savedAt ? (
          <span>Saved {timeAgo(savedAt)}</span>
        ) : (
          <span className="italic">
            Notes auto-save on blur and surface in the episode picker tooltip.
          </span>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>
    </>
  );
}

function timeAgo(d: Date): string {
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ─── Atoms ──────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wide text-stone-400 mb-1">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <span className="text-stone-500">{label}</span>
      <span className={`text-right truncate ${mono ? 'font-mono text-[10px]' : ''}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function Empty({ children }: { children?: React.ReactNode }) {
  return (
    <div className="text-stone-400 italic text-[11px]">{children ?? 'no data at this time'}</div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function findLatestAtOrBefore<T>(
  rows: readonly T[],
  getMs: (r: T) => number,
  tMs: number,
): T | null {
  // Server-side rows are already sorted ascending by tMs; walk from the
  // tail to find the most recent at-or-before. Linear is fine here because
  // the throttled `tMs` from the inspector hits this at most 4Hz.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (getMs(r) <= tMs) return r;
  }
  return null;
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
