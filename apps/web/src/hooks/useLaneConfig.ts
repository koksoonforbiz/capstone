import { useCallback, useEffect, useState } from 'react';

/**
 * Lane configuration store for the retrospective tracing UI (Stage 5).
 *
 * Persisted to localStorage so a researcher's preferred order / heights /
 * visibility carries across sessions. Per-user keying is implicit: the
 * key includes a version so we can ship breaking config changes.
 */

const STORAGE_KEY = 'ats.researchLaneConfig.v1';

export type LaneId =
  | 'activity'
  | 'efDetection'
  | 'dialogue'
  | 'affective'
  | 'emotion'
  | 'au'
  | 'gaze'
  | 'pupil'
  | 'engagement'
  | 'cognitiveLoad'
  | 'atRisk'
  | 'click'
  | 'scroll'
  | 'visibility'
  | 'error';

export type LaneSettings = {
  visible: boolean;
  height: number;
};

export type LaneConfig = {
  order: LaneId[];
  settings: Record<LaneId, LaneSettings>;
};

const DEFAULT_ORDER: LaneId[] = [
  'activity',
  'efDetection',
  'dialogue',
  'affective',
  'emotion',
  'au',
  'gaze',
  'pupil',
  'engagement',
  'cognitiveLoad',
  'atRisk',
  'click',
  'scroll',
  'visibility',
  'error',
];

const DEFAULT_HEIGHTS: Record<LaneId, number> = {
  activity: 32,
  efDetection: 32,
  dialogue: 32,
  affective: 44,
  emotion: 56,
  au: 56,
  gaze: 56,
  pupil: 56,
  engagement: 44,
  cognitiveLoad: 44,
  atRisk: 32,
  click: 32,
  scroll: 44,
  visibility: 28,
  error: 32,
};

function defaultConfig(): LaneConfig {
  const settings = {} as Record<LaneId, LaneSettings>;
  for (const id of DEFAULT_ORDER) {
    settings[id] = { visible: true, height: DEFAULT_HEIGHTS[id] };
  }
  return { order: [...DEFAULT_ORDER], settings };
}

function readConfig(): LaneConfig {
  if (typeof window === 'undefined') return defaultConfig();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    const parsed = JSON.parse(raw) as Partial<LaneConfig>;
    const base = defaultConfig();
    // Merge cautiously — drop unknown ids, add new ids with defaults.
    const order: LaneId[] = [];
    if (Array.isArray(parsed.order)) {
      for (const id of parsed.order) {
        if (DEFAULT_ORDER.includes(id as LaneId) && !order.includes(id as LaneId)) {
          order.push(id as LaneId);
        }
      }
    }
    for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id);
    const settings = { ...base.settings };
    if (parsed.settings && typeof parsed.settings === 'object') {
      for (const id of DEFAULT_ORDER) {
        const s = (parsed.settings as Record<string, unknown>)[id];
        if (s && typeof s === 'object') {
          const sObj = s as { visible?: unknown; height?: unknown };
          settings[id] = {
            visible: typeof sObj.visible === 'boolean' ? sObj.visible : true,
            height:
              typeof sObj.height === 'number' && sObj.height > 0
                ? Math.max(28, Math.min(320, sObj.height))
                : DEFAULT_HEIGHTS[id],
          };
        }
      }
    }
    return { order, settings };
  } catch {
    return defaultConfig();
  }
}

function writeConfig(c: LaneConfig) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // quota / storage disabled — ignore silently
  }
}

export function useLaneConfig() {
  const [config, setConfig] = useState<LaneConfig>(() => readConfig());

  // Re-persist on every change.
  useEffect(() => {
    writeConfig(config);
  }, [config]);

  const setVisible = useCallback((id: LaneId, visible: boolean) => {
    setConfig((c) => ({
      ...c,
      settings: { ...c.settings, [id]: { ...c.settings[id], visible } },
    }));
  }, []);

  const setHeight = useCallback((id: LaneId, height: number) => {
    setConfig((c) => ({
      ...c,
      settings: { ...c.settings, [id]: { ...c.settings[id], height } },
    }));
  }, []);

  const moveLane = useCallback((id: LaneId, direction: 'up' | 'down') => {
    setConfig((c) => {
      const idx = c.order.indexOf(id);
      if (idx < 0) return c;
      const newIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= c.order.length) return c;
      const order = [...c.order];
      const [removed] = order.splice(idx, 1);
      if (removed) order.splice(newIdx, 0, removed);
      return { ...c, order };
    });
  }, []);

  const reset = useCallback(() => setConfig(defaultConfig()), []);

  return { config, setVisible, setHeight, moveLane, reset };
}
