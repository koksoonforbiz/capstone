/**
 * 60-second countdown modal shown before the idle-logout fires.
 * Any user activity (mouse, key, scroll) dismisses it via the parent's
 * `onStayActive` handler — that just calls `reset()` from `useIdleLogout`.
 */

type Props = {
  open: boolean;
  secondsUntilLogout: number;
  onStayActive: () => void;
  onLogoutNow: () => void;
};

export function IdleLogoutWarning({ open, secondsUntilLogout, onStayActive, onLogoutNow }: Props) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Inactivity warning"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="bg-white dark:bg-stone-900 border border-amber-300 dark:border-amber-700 rounded-lg shadow-lg w-[420px] p-5">
        <div className="flex items-center gap-2 mb-2">
          <svg
            className="w-5 h-5 text-amber-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            You'll be logged out for inactivity
          </h2>
        </div>
        <p className="text-xs text-stone-600 dark:text-stone-300 mb-3">
          We log you out after 15 minutes of no activity so each session in your data is tied to one
          continuous sitting. Move your mouse or press any key to stay logged in.
        </p>
        <div className="text-center mb-4">
          <div className="text-3xl font-mono tabular-nums text-amber-600 dark:text-amber-400">
            {Math.max(0, secondsUntilLogout)}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-stone-400">
            seconds remaining
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onLogoutNow}
            className="text-xs px-3 py-1.5 border border-stone-300 dark:border-stone-700 rounded hover:bg-stone-50 dark:hover:bg-stone-800"
          >
            Log out now
          </button>
          <button
            type="button"
            onClick={onStayActive}
            className="text-xs px-3 py-1.5 bg-stone-800 text-white rounded hover:bg-stone-700"
          >
            Stay logged in
          </button>
        </div>
      </div>
    </div>
  );
}
