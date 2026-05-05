import { memo, useMemo, useState } from 'react';
import { msToX } from './canvas-utils';

/**
 * Generic point-in-time marker lane (Stage 5).
 *
 * SVG-rendered. Used by activity, errors, at-risk, dialogue, EF detections.
 * Markers within `clusterPx` of each other on screen are merged into a
 * single cluster marker labeled with the count to keep dense regions
 * readable.
 */

export type EventMarker = {
  id: string;
  tMs: number;
  label: string;
  color?: string; // Tailwind-friendly CSS color (overrides default)
  payload?: unknown; // returned via onSelect for the inspector
};

type Props = {
  markers: EventMarker[];
  fromMs: number;
  toMs: number;
  width: number;
  height: number;
  defaultColor?: string;
  onSelect?: (marker: EventMarker) => void;
  selectedId?: string | null;
  clusterPx?: number;
};

export const EventMarkerLane = memo(function EventMarkerLane({
  markers,
  fromMs,
  toMs,
  width,
  height,
  defaultColor = 'rgb(82, 130, 145)',
  onSelect,
  selectedId,
  clusterPx = 4,
}: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const visibleMarkers = useMemo(
    () => markers.filter((m) => m.tMs >= fromMs && m.tMs <= toMs),
    [markers, fromMs, toMs],
  );

  // Cluster within `clusterPx` so tightly-packed events render as one mark.
  const clusters = useMemo(() => {
    if (visibleMarkers.length === 0) return [];
    const sorted = [...visibleMarkers].sort((a, b) => a.tMs - b.tMs);
    const out: Array<{
      id: string;
      tMs: number;
      x: number;
      members: EventMarker[];
    }> = [];
    for (const m of sorted) {
      const x = msToX(m.tMs, fromMs, toMs, width);
      const last = out[out.length - 1];
      if (last && Math.abs(x - last.x) <= clusterPx) {
        last.members.push(m);
        // re-anchor the cluster to the midpoint
        last.x = (last.x * (last.members.length - 1) + x) / last.members.length;
        last.tMs = last.members.reduce((s, mm) => s + mm.tMs, 0) / last.members.length;
      } else {
        out.push({ id: m.id, tMs: m.tMs, x, members: [m] });
      }
    }
    return out;
  }, [visibleMarkers, fromMs, toMs, width, clusterPx]);

  return (
    <svg width={width} height={height} className="block">
      {clusters.map((c) => {
        const single = c.members.length === 1;
        const marker = c.members[0]!;
        const color = marker.color ?? defaultColor;
        const isHovered = hoverId === c.id;
        const isSelected = !!selectedId && c.members.some((m) => m.id === selectedId);
        const tickH = isSelected ? height : Math.min(height, isHovered ? height : height - 4);
        return (
          <g
            key={c.id}
            onMouseEnter={() => setHoverId(c.id)}
            onMouseLeave={() => setHoverId(null)}
            onClick={(e) => {
              e.stopPropagation();
              if (single && onSelect) onSelect(marker);
            }}
            className={onSelect ? 'cursor-pointer' : undefined}
          >
            <line
              x1={c.x}
              x2={c.x}
              y1={(height - tickH) / 2}
              y2={(height + tickH) / 2}
              stroke={color}
              strokeWidth={isSelected ? 3 : isHovered ? 2 : 1.5}
              opacity={single ? 0.95 : 0.75}
            />
            {!single && (
              <text
                x={c.x + 3}
                y={Math.min(height - 2, height / 2 + 4)}
                fontSize={9}
                fill={color}
                className="font-mono"
              >
                ×{c.members.length}
              </text>
            )}
            <title>
              {single
                ? `${marker.label}\n+${formatHMS(marker.tMs)}`
                : `${c.members.length} events at ~${formatHMS(c.tMs)}`}
            </title>
          </g>
        );
      })}
    </svg>
  );
});

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
