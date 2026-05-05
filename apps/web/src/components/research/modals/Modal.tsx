import { useEffect } from 'react';

/**
 * Minimal modal primitive — fixed overlay + centered card. Closes on
 * Escape and outside-click. The retrospective-tracing dialogs are
 * researcher-internal so a heavyweight a11y component isn't worth pulling
 * in; this matches the rest of the project's lightweight pattern.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

export function Modal({ open, onClose, title, width = 480, children, footer }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded shadow-lg max-h-[90vh] flex flex-col"
        style={{ width }}
      >
        <header className="px-4 py-2.5 border-b border-stone-200 dark:border-stone-700 flex items-center">
          <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 text-xs text-stone-700 dark:text-stone-200">
          {children}
        </div>
        {footer && (
          <footer className="px-4 py-2.5 border-t border-stone-200 dark:border-stone-700 flex justify-end gap-2 text-xs">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
