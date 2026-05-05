import { memo, useLayoutEffect, useRef, useState } from 'react';

/**
 * Shared layout primitive for every lane in the LaneContainer (Stage 5).
 *
 * Layout:
 *   ┌───────────── 180px gutter ─────────────┐ ┌── flex content (canvas/svg) ──┐
 *   │ name · info · visibility · height-grip │ │  lane render                  │
 *   └────────────────────────────────────────┘ └───────────────────────────────┘
 *
 * The content area exposes its measured pixel width to children via a
 * render-prop, so canvas lanes can size themselves correctly.
 */

const GUTTER_WIDTH = 180;

export type LaneShellProps = {
  name: string;
  info?: string; // tooltip explaining what this lane shows
  visible: boolean;
  onToggleVisible: () => void;
  height: number; // px; stored in lane config
  onHeightChange?: (h: number) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  legend?: React.ReactNode;
  empty?: boolean; // if true, show a "No data" placeholder over the content
  emptyLabel?: string;
  children: (size: { width: number; height: number }) => React.ReactNode;
};

export const LaneShell = memo(function LaneShell({
  name,
  info,
  visible,
  onToggleVisible,
  height,
  onHeightChange,
  onMoveUp,
  onMoveDown,
  legend,
  empty,
  emptyLabel,
  children,
}: LaneShellProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setWidth(Math.max(0, entry.contentRect.width));
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // Lane-content height excludes the bottom drag handle.
  const contentHeight = Math.max(20, height - 6);

  return (
    <div className="flex border-b border-stone-200 dark:border-stone-700/60" style={{ height }}>
      {/* Gutter */}
      <div
        className="shrink-0 px-2 py-1.5 bg-stone-50 dark:bg-stone-900/40 border-r border-stone-200 dark:border-stone-700/60 flex flex-col gap-1 overflow-hidden"
        style={{ width: GUTTER_WIDTH }}
      >
        <div className="flex items-center gap-1 min-w-0">
          <button
            type="button"
            onClick={onToggleVisible}
            aria-label={visible ? `Hide ${name}` : `Show ${name}`}
            className={`shrink-0 w-3 h-3 rounded-sm border ${
              visible
                ? 'bg-emerald-500 border-emerald-600'
                : 'bg-transparent border-stone-400 dark:border-stone-600'
            }`}
          />
          <span
            className="text-[11px] font-medium text-stone-700 dark:text-stone-200 truncate"
            title={info ?? name}
          >
            {name}
          </span>
          {info && (
            <span
              className="ml-auto text-[10px] text-stone-400 cursor-help"
              title={info}
              aria-label={info}
            >
              ⓘ
            </span>
          )}
        </div>
        {legend && <div className="text-[10px] text-stone-500 truncate">{legend}</div>}
        {(onMoveUp || onMoveDown) && (
          <div className="mt-auto flex items-center gap-1 text-[10px] text-stone-400">
            {onMoveUp && (
              <button
                type="button"
                onClick={onMoveUp}
                aria-label={`Move ${name} up`}
                className="px-1 hover:text-stone-700 dark:hover:text-stone-200"
              >
                ↑
              </button>
            )}
            {onMoveDown && (
              <button
                type="button"
                onClick={onMoveDown}
                aria-label={`Move ${name} down`}
                className="px-1 hover:text-stone-700 dark:hover:text-stone-200"
              >
                ↓
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div
        ref={contentRef}
        className="relative flex-1 min-w-0 bg-white dark:bg-stone-950"
        style={{ height: contentHeight }}
      >
        {visible && width > 0 && children({ width, height: contentHeight })}
        {visible && empty && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-stone-300 dark:text-stone-600 italic pointer-events-none">
            {emptyLabel ?? 'No data for this episode'}
          </div>
        )}
        {!visible && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-stone-300 dark:text-stone-600 italic">
            hidden
          </div>
        )}
      </div>

      {/* Bottom drag handle for height (hidden if not provided) */}
      {onHeightChange && <ResizeGrip currentHeight={height} onHeightChange={onHeightChange} />}
    </div>
  );
});

function ResizeGrip({
  currentHeight,
  onHeightChange,
}: {
  currentHeight: number;
  onHeightChange: (h: number) => void;
}) {
  const startRef = useRef<{ y: number; h: number } | null>(null);

  function handleDown(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    startRef.current = { y: e.clientY, h: currentHeight };
    function onMove(ev: MouseEvent) {
      if (!startRef.current) return;
      const delta = ev.clientY - startRef.current.y;
      const next = Math.max(28, Math.min(320, startRef.current.h + delta));
      onHeightChange(next);
    }
    function onUp() {
      startRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize lane"
      onMouseDown={handleDown}
      className="absolute left-0 right-0 bottom-0 h-1.5 cursor-row-resize hover:bg-stone-300/60 dark:hover:bg-stone-600/60"
    />
  );
}

export const LANE_GUTTER_WIDTH = GUTTER_WIDTH;
