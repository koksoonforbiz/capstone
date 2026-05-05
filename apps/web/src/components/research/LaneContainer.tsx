import { useMemo } from 'react';
import type { TimelinePayload } from '@ats/shared';
import { LaneShell, LANE_GUTTER_WIDTH } from './lanes/LaneShell';
import { EventMarkerLane, type EventMarker } from './lanes/EventMarkerLane';
import { LineSeriesLane, type LineSeries } from './lanes/LineSeriesLane';
import { StackedAreaLane, type StackedSample } from './lanes/StackedAreaLane';
import { GazePathLane } from './lanes/GazePathLane';
import { HeatmapLane } from './lanes/HeatmapLane';
import { BandLane, type Band } from './lanes/BandLane';
import type { LaneId, LaneConfig } from '../../hooks/useLaneConfig';

/**
 * Master lane container (Stage 5).
 *
 * Reads `panMs` / `zoomMs` from the timeline state and renders every lane
 * sharing the same x-axis. The shared playhead is a single CSS-translated
 * line that spans the full lane stack — moves on every `currentMs` tick
 * but doesn't trigger lane re-renders (each lane is React.memo'd on
 * data + window).
 */

type Props = {
  payload: TimelinePayload;
  fromMs: number;
  toMs: number;
  currentMs: number;
  episodeDurationMs: number;
  config: LaneConfig;
  onToggleVisible: (id: LaneId) => void;
  onSetHeight: (id: LaneId, h: number) => void;
  onMoveUp: (id: LaneId) => void;
  onMoveDown: (id: LaneId) => void;
  onSelectEvent: (kind: SelectedEventKind, payload: unknown, tMs: number) => void;
  selectedEventId: string | null;
  // Gaze trace/density toggle.
  gazeMode: 'trace' | 'density';
  onGazeModeChange: (m: 'trace' | 'density') => void;
};

export type SelectedEventKind = 'activity' | 'efDetection' | 'atRisk' | 'error' | 'dialogue';

export function LaneContainer({
  payload,
  fromMs,
  toMs,
  currentMs,
  episodeDurationMs,
  config,
  onToggleVisible,
  onSetHeight,
  onMoveUp,
  onMoveDown,
  onSelectEvent,
  selectedEventId,
  gazeMode,
  onGazeModeChange,
}: Props) {
  const lanes = payload.lanes;

  // ─── Pre-shape data per lane (memoed on raw payload) ─────────────────
  const activityMarkers = useMemo<EventMarker[]>(
    () =>
      (lanes.activity ?? []).map((r, i) => ({
        id: `activity-${i}`,
        tMs: r.tMs,
        label: r.action,
        color: actionColor(r.action),
        payload: r,
      })),
    [lanes.activity],
  );

  const efMarkers = useMemo<EventMarker[]>(
    () =>
      (lanes.efDetection ?? []).map((r) => ({
        id: `ef-${r.messageId}-${r.constructKey}`,
        tMs: r.tMs,
        label: `${r.constructKey}: ${r.label}`,
        color: efColor(r.label),
        payload: r,
      })),
    [lanes.efDetection],
  );

  const atRiskMarkers = useMemo<EventMarker[]>(
    () =>
      (lanes.atRisk ?? []).map((r, i) => ({
        id: `atrisk-${i}`,
        tMs: r.tMs,
        label: `risk: ${r.riskLevel}`,
        color: riskColor(r.riskLevel),
        payload: r,
      })),
    [lanes.atRisk],
  );

  const errorMarkers = useMemo<EventMarker[]>(
    () =>
      (lanes.error ?? []).map((r, i) => ({
        id: `err-${i}`,
        tMs: r.tMs,
        label: r.errorMessage,
        color: 'rgb(220, 38, 38)',
        payload: r,
      })),
    [lanes.error],
  );

  const emotionSamples = useMemo<StackedSample[]>(
    () =>
      (lanes.emotion ?? []).map((r) => ({
        tMs: r.tMs,
        components: Object.fromEntries(Object.entries(r.scores ?? {}).map(([k, v]) => [k, v ?? 0])),
      })),
    [lanes.emotion],
  );

  const auSamples = useMemo<StackedSample[]>(
    () =>
      (lanes.au ?? []).map((r) => ({
        tMs: r.tMs,
        components: Object.fromEntries(Object.entries(r.aus ?? {}).map(([k, v]) => [k, v ?? 0])),
      })),
    [lanes.au],
  );

  const affectiveBands = useMemo<Band[]>(
    () =>
      (lanes.affective ?? []).map((w, i) => ({
        id: `aff-${i}`,
        fromMs: w.startMs,
        toMs: w.endMs,
        state: w.dominantState,
        label: `${w.dominantState} · eng=${w.engagement.toFixed(2)} bored=${w.boredom.toFixed(2)} conf=${w.confusion.toFixed(2)}`,
        color: affectiveColor(w.dominantState),
      })),
    [lanes.affective],
  );

  const visibilityBands = useMemo<Band[]>(() => {
    // Visibility events are point-in-time state changes. Build bands by
    // walking transitions: from one event to the next, the lane is in
    // that event's `visibleState`. Implicit "visible" before first event
    // and "visible" after last (we don't actually know, but it's the
    // sensible default).
    const rows = lanes.visibility ?? [];
    if (rows.length === 0) return [];
    const out: Band[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const next = rows[i + 1];
      const to = next ? next.tMs : episodeDurationMs;
      out.push({
        id: `vis-${i}`,
        fromMs: r.tMs,
        toMs: to,
        state: r.visibleState,
        label: `${r.visibleState} · ${formatGap(to - r.tMs)}`,
        color: r.visibleState === 'visible' ? 'rgb(82, 130, 145)' : 'rgb(146, 124, 90)',
      });
    }
    return out;
  }, [lanes.visibility, episodeDurationMs]);

  const pupilSeries = useMemo<LineSeries[]>(() => {
    const rows = lanes.pupil ?? [];
    if (rows.length === 0) return [];
    return [
      {
        id: 'pupil',
        label: 'pupil ⌀',
        color: 'rgb(82, 130, 145)',
        points: rows.map((r) => ({ tMs: r.tMs, value: r.diameter })),
        unit: 'mm',
      },
    ];
  }, [lanes.pupil]);

  const engagementSeries = useMemo<LineSeries[]>(() => {
    const rows = lanes.derived?.engagement ?? [];
    if (rows.length === 0) return [];
    return [
      {
        id: 'engagement',
        label: 'engagement',
        color: 'rgb(82, 130, 145)',
        points: rows.map((r) => ({
          tMs: (r.startMs + r.endMs) / 2,
          value: r.score,
        })),
        yMin: 0,
        yMax: 1,
        fillOpacity: 0.18,
      },
    ];
  }, [lanes.derived]);

  const cognitiveLoadSeries = useMemo<LineSeries[]>(() => {
    const rows = lanes.derived?.cognitiveLoad ?? [];
    if (rows.length === 0) return [];
    return [
      {
        id: 'cognitive-load',
        label: 'cognitive load',
        color: 'rgb(146, 124, 90)',
        points: rows.map((r) => ({
          tMs: (r.startMs + r.endMs) / 2,
          value: r.score,
        })),
        yMin: 0,
        yMax: 1,
        fillOpacity: 0.18,
      },
    ];
  }, [lanes.derived]);

  const scrollSeries = useMemo<LineSeries[]>(() => {
    const rows = lanes.scroll ?? [];
    if (rows.length === 0) return [];
    return [
      {
        id: 'scroll',
        label: 'scroll',
        color: 'rgb(82, 130, 145)',
        points: rows.map((r) => ({ tMs: r.tMs, value: r.scrollPercent })),
        yMin: 0,
        yMax: 100,
        unit: '%',
      },
    ];
  }, [lanes.scroll]);

  const clickEvents = useMemo(
    () => (lanes.click ?? []).map((r) => ({ tMs: r.tMs })),
    [lanes.click],
  );

  // ─── Render lanes per config order ───────────────────────────────────
  const renderLane = (id: LaneId): React.ReactNode => {
    const settings = config.settings[id];
    const idx = config.order.indexOf(id);
    const canMoveUp = idx > 0;
    const canMoveDown = idx >= 0 && idx < config.order.length - 1;
    const shellProps = {
      visible: settings.visible,
      onToggleVisible: () => onToggleVisible(id),
      height: settings.height,
      onHeightChange: (h: number) => onSetHeight(id, h),
      onMoveUp: canMoveUp ? () => onMoveUp(id) : undefined,
      onMoveDown: canMoveDown ? () => onMoveDown(id) : undefined,
    };

    switch (id) {
      case 'activity':
        return (
          <LaneShell
            key={id}
            name="Activity"
            info="Page-level activity events: views, focus, blur, navigation."
            empty={activityMarkers.length === 0}
            {...shellProps}
          >
            {({ width, height }) => (
              <EventMarkerLane
                markers={activityMarkers}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
                selectedId={selectedEventId}
                onSelect={(m) => onSelectEvent('activity', m.payload, m.tMs)}
              />
            )}
          </LaneShell>
        );
      case 'efDetection':
        return (
          <LaneShell
            key={id}
            name="EF detections"
            info="Executive-function constructs detected in dialogue messages."
            empty={efMarkers.length === 0}
            legend="text-mining results"
            {...shellProps}
          >
            {({ width, height }) => (
              <EventMarkerLane
                markers={efMarkers}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
                selectedId={selectedEventId}
                onSelect={(m) => onSelectEvent('efDetection', m.payload, m.tMs)}
              />
            )}
          </LaneShell>
        );
      case 'dialogue':
        return (
          <LaneShell
            key={id}
            name="Dialogue"
            info="Per-message dialogue events. Pending API support — see prompt_retro 03 follow-ups."
            empty
            emptyLabel="Dialogue lane API support deferred (Stage 3 follow-up)"
            {...shellProps}
          >
            {() => null}
          </LaneShell>
        );
      case 'affective':
        return (
          <LaneShell
            key={id}
            name="Affective state"
            info="Dominant affective state windows (engagement / boredom / confusion / frustration)."
            empty={affectiveBands.length === 0}
            legend="state windows"
            {...shellProps}
          >
            {({ width, height }) => (
              <BandLane
                bands={affectiveBands}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
              />
            )}
          </LaneShell>
        );
      case 'emotion':
        return (
          <LaneShell
            key={id}
            name="Emotion"
            info="Per-frame emotion probabilities (8 emotions, normalized)."
            empty={emotionSamples.length === 0}
            legend={<EmotionLegend />}
            {...shellProps}
          >
            {({ width, height }) => (
              <StackedAreaLane
                samples={emotionSamples}
                series={EMOTION_SERIES}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
              />
            )}
          </LaneShell>
        );
      case 'au':
        return (
          <LaneShell
            key={id}
            name="AU intensities"
            info="OpenFace AU intensities (collapsed). Lane is empty if pyfeat-AU pipeline hasn't run for this episode."
            empty={auSamples.length === 0}
            emptyLabel="AU lane API support deferred (Stage 3 follow-up)"
            legend="18 action units"
            {...shellProps}
          >
            {({ width, height }) => (
              <StackedAreaLane
                samples={auSamples}
                series={auSamplesToSeries(auSamples)}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
              />
            )}
          </LaneShell>
        );
      case 'gaze':
        return (
          <LaneShell
            key={id}
            name="Gaze"
            info="WebGazer gaze trace. Toggle between trace (x/y) and density (variance/sec)."
            empty={(lanes.gaze ?? []).length === 0}
            legend={
              <button
                type="button"
                onClick={() => onGazeModeChange(gazeMode === 'trace' ? 'density' : 'trace')}
                className="text-[10px] underline hover:text-stone-700 dark:hover:text-stone-200"
              >
                {gazeMode === 'trace' ? 'switch to density' : 'switch to trace'}
              </button>
            }
            {...shellProps}
          >
            {({ width, height }) => (
              <GazePathLane
                rows={lanes.gaze ?? []}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
                mode={gazeMode}
              />
            )}
          </LaneShell>
        );
      case 'pupil':
        return (
          <LaneShell
            key={id}
            name="Pupil ⌀"
            info="Pupil diameter samples — proxy for cognitive load."
            empty={pupilSeries.length === 0 || (pupilSeries[0]?.points.length ?? 0) === 0}
            {...shellProps}
          >
            {({ width, height }) => (
              <LineSeriesLane
                series={pupilSeries}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
              />
            )}
          </LaneShell>
        );
      case 'engagement':
        return (
          <LaneShell
            key={id}
            name="Engagement"
            info="Derived engagement score (0..1) per affective window."
            empty={engagementSeries.length === 0 || (engagementSeries[0]?.points.length ?? 0) === 0}
            {...shellProps}
          >
            {({ width, height }) => (
              <LineSeriesLane
                series={engagementSeries}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
              />
            )}
          </LaneShell>
        );
      case 'cognitiveLoad':
        return (
          <LaneShell
            key={id}
            name="Cognitive load"
            info="Derived cognitive-load score (0..1) per affective window."
            empty={
              cognitiveLoadSeries.length === 0 || (cognitiveLoadSeries[0]?.points.length ?? 0) === 0
            }
            {...shellProps}
          >
            {({ width, height }) => (
              <LineSeriesLane
                series={cognitiveLoadSeries}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
              />
            )}
          </LaneShell>
        );
      case 'atRisk':
        return (
          <LaneShell
            key={id}
            name="At-risk flags"
            info="Derived-at-risk flags raised on the affective pipeline."
            empty={atRiskMarkers.length === 0}
            {...shellProps}
          >
            {({ width, height }) => (
              <EventMarkerLane
                markers={atRiskMarkers}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
                selectedId={selectedEventId}
                onSelect={(m) => onSelectEvent('atRisk', m.payload, m.tMs)}
              />
            )}
          </LaneShell>
        );
      case 'click':
        return (
          <LaneShell
            key={id}
            name="Clicks"
            info="Click density (5s buckets). Darker = more clicks."
            empty={clickEvents.length === 0}
            {...shellProps}
          >
            {({ width, height }) => (
              <HeatmapLane
                events={clickEvents}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
              />
            )}
          </LaneShell>
        );
      case 'scroll':
        return (
          <LaneShell
            key={id}
            name="Scroll"
            info="Scroll position as % of page height."
            empty={scrollSeries.length === 0 || (scrollSeries[0]?.points.length ?? 0) === 0}
            {...shellProps}
          >
            {({ width, height }) => (
              <LineSeriesLane
                series={scrollSeries}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
              />
            )}
          </LaneShell>
        );
      case 'visibility':
        return (
          <LaneShell
            key={id}
            name="Visibility"
            info="Page hidden vs visible (visibilitychange events)."
            empty={visibilityBands.length === 0}
            {...shellProps}
          >
            {({ width, height }) => (
              <BandLane
                bands={visibilityBands}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
              />
            )}
          </LaneShell>
        );
      case 'error':
        return (
          <LaneShell
            key={id}
            name="Errors"
            info="Client-side errors captured during the session."
            empty={errorMarkers.length === 0}
            {...shellProps}
          >
            {({ width, height }) => (
              <EventMarkerLane
                markers={errorMarkers}
                fromMs={fromMs}
                toMs={toMs}
                width={width}
                height={height}
                selectedId={selectedEventId}
                onSelect={(m) => onSelectEvent('error', m.payload, m.tMs)}
              />
            )}
          </LaneShell>
        );
    }
  };

  // ─── Playhead overlay ────────────────────────────────────────────────
  // We render the lane stack first, then a single absolutely-positioned
  // line that spans the content area only (to the right of the gutter).
  // It re-renders on every currentMs change but doesn't trigger any lane
  // re-render because each lane is React.memo'd on data + window.
  const span = toMs - fromMs;
  const playheadX =
    span > 0 && currentMs >= fromMs && currentMs <= toMs
      ? ((currentMs - fromMs) / span) * 100
      : null;

  return (
    <div className="relative border border-stone-200 dark:border-stone-700/60 rounded overflow-hidden bg-white dark:bg-stone-950">
      <div className="flex flex-col">{config.order.map((id) => renderLane(id))}</div>
      {/* Playhead line — covers content area, not gutter */}
      <div
        className="absolute top-0 bottom-0 pointer-events-none"
        style={{ left: LANE_GUTTER_WIDTH, right: 0 }}
      >
        {playheadX !== null && (
          <div
            className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_4px_rgba(220,38,38,0.4)]"
            style={{ left: `${playheadX}%` }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Color tokens ───────────────────────────────────────────────────────

const EMOTION_SERIES = [
  { key: 'happy', label: 'happy', color: 'rgba(82, 160, 130, 0.8)' },
  { key: 'sad', label: 'sad', color: 'rgba(82, 100, 130, 0.8)' },
  { key: 'angry', label: 'angry', color: 'rgba(180, 90, 80, 0.8)' },
  { key: 'fear', label: 'fear', color: 'rgba(140, 100, 160, 0.8)' },
  { key: 'surprise', label: 'surprise', color: 'rgba(210, 180, 80, 0.8)' },
  { key: 'disgust', label: 'disgust', color: 'rgba(120, 140, 90, 0.8)' },
  { key: 'contempt', label: 'contempt', color: 'rgba(140, 110, 90, 0.8)' },
  { key: 'neutral', label: 'neutral', color: 'rgba(160, 154, 145, 0.7)' },
];

function EmotionLegend() {
  return (
    <div className="flex flex-wrap gap-x-1.5 gap-y-0.5">
      {EMOTION_SERIES.slice(0, 4).map((e) => (
        <span key={e.key} className="text-[9px]" style={{ color: e.color }}>
          ■ {e.label}
        </span>
      ))}
    </div>
  );
}

function auSamplesToSeries(samples: StackedSample[]) {
  // Pick all keys that ever appear, sorted, give each a deterministic color
  // from a palette.
  const keys = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s.components)) keys.add(k);
  const sorted = [...keys].sort();
  const palette = [
    'rgba(82, 130, 145, 0.7)',
    'rgba(146, 124, 90, 0.7)',
    'rgba(160, 90, 100, 0.7)',
    'rgba(110, 140, 90, 0.7)',
    'rgba(160, 130, 80, 0.7)',
    'rgba(120, 110, 150, 0.7)',
    'rgba(90, 130, 110, 0.7)',
    'rgba(180, 110, 90, 0.7)',
    'rgba(100, 120, 140, 0.7)',
    'rgba(170, 150, 100, 0.7)',
    'rgba(140, 100, 130, 0.7)',
    'rgba(110, 130, 90, 0.7)',
    'rgba(150, 120, 110, 0.7)',
    'rgba(100, 110, 130, 0.7)',
    'rgba(170, 140, 110, 0.7)',
    'rgba(130, 110, 100, 0.7)',
    'rgba(120, 140, 130, 0.7)',
    'rgba(160, 100, 110, 0.7)',
  ];
  return sorted.map((k, i) => ({
    key: k,
    label: k,
    color: palette[i % palette.length]!,
  }));
}

function actionColor(action: string): string {
  if (action.startsWith('error')) return 'rgb(220, 38, 38)';
  if (action.startsWith('focus') || action.startsWith('blur')) return 'rgb(146, 124, 90)';
  if (action.includes('navigate') || action.includes('view')) return 'rgb(82, 130, 145)';
  return 'rgb(120, 113, 108)';
}

function efColor(label: string): string {
  if (label === 'present') return 'rgb(82, 160, 130)';
  if (label === 'absent') return 'rgb(180, 90, 80)';
  if (label === 'unclear') return 'rgb(146, 124, 90)';
  return 'rgb(120, 113, 108)';
}

function riskColor(level: string): string {
  if (level === 'high') return 'rgb(220, 38, 38)';
  if (level === 'medium') return 'rgb(217, 119, 6)';
  return 'rgb(146, 124, 90)';
}

function affectiveColor(state: string): string {
  switch (state) {
    case 'engaged':
      return 'rgb(82, 160, 130)';
    case 'bored':
      return 'rgb(160, 154, 145)';
    case 'confused':
      return 'rgb(146, 124, 90)';
    case 'frustrated':
      return 'rgb(180, 90, 80)';
    default:
      return 'rgb(120, 113, 108)';
  }
}

function formatGap(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
