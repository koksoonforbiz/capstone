import { memo, useMemo } from 'react';
import { msToX } from './canvas-utils';

/**
 * Interval-band lane (Stage 5).
 *
 * SVG-rendered. Used for visibility (page hidden vs visible) and
 * affective-state windows. Each band has a color per state and a
 * descriptive `label` for the hover tooltip.
 */

export type Band = {
  id: string;
  fromMs: number;
  toMs: number;
  state: string;
  label: string;
  color: string;
};

type Props = {
  bands: Band[];
  fromMs: number;
  toMs: number;
  width: number;
  height: number;
};

export const BandLane = memo(function BandLane({ bands, fromMs, toMs, width, height }: Props) {
  const visible = useMemo(
    () => bands.filter((b) => b.toMs >= fromMs && b.fromMs <= toMs),
    [bands, fromMs, toMs],
  );

  return (
    <svg width={width} height={height} className="block">
      {visible.map((b) => {
        const x1 = Math.max(0, msToX(b.fromMs, fromMs, toMs, width));
        const x2 = Math.min(width, msToX(b.toMs, fromMs, toMs, width));
        const w = Math.max(1, x2 - x1);
        return (
          <g key={b.id}>
            <rect x={x1} y={4} width={w} height={height - 8} fill={b.color} opacity={0.55}>
              <title>{b.label}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
});
