import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Auto-logout after a period of user inactivity.
 *
 * Triggers `onLogout()` when the user has been idle for `idleMs`. Shows
 * a warning `warnMs` before the logout fires so the user can dismiss it
 * by interacting (`reset()` is called for them).
 *
 * "Activity" = mousemove, mousedown, keydown, scroll, wheel, touchstart.
 * Network activity (XHR/fetch) does NOT reset the timer — bots /
 * background tabs polling the API don't count as user activity.
 *
 * The session-end / new-session boundary the user wants for clean log
 * traceability is enforced as: 15 min of no input → forced logout →
 * the next login starts a fresh StudentSession.
 */
type Options = {
  /** Time of inactivity before logout fires. Default: 15 min. */
  idleMs?: number;
  /** Time before logout to show the warning. Default: 60 s. */
  warnMs?: number;
  /** Whether the timer should be active. Pass `false` to disable
   *  (e.g. when the user isn't logged in). */
  enabled: boolean;
  /** Called when idle threshold is hit. Should perform logout. */
  onLogout: () => void;
};

const ACTIVITY_EVENTS: (keyof DocumentEventMap)[] = [
  'mousemove',
  'mousedown',
  'keydown',
  'scroll',
  'wheel',
  'touchstart',
];

export function useIdleLogout({
  idleMs = 15 * 60_000,
  warnMs = 60_000,
  enabled,
  onLogout,
}: Options): {
  isWarning: boolean;
  secondsUntilLogout: number;
  reset: () => void;
} {
  const [isWarning, setIsWarning] = useState(false);
  const [secondsUntilLogout, setSecondsUntilLogout] = useState(idleMs / 1000);

  const lastActivityRef = useRef<number>(Date.now());
  const logoutHandleRef = useRef<number | null>(null);
  const warnHandleRef = useRef<number | null>(null);
  const tickHandleRef = useRef<number | null>(null);
  const onLogoutRef = useRef(onLogout);
  onLogoutRef.current = onLogout;

  const clearTimers = useCallback(() => {
    if (logoutHandleRef.current !== null) {
      window.clearTimeout(logoutHandleRef.current);
      logoutHandleRef.current = null;
    }
    if (warnHandleRef.current !== null) {
      window.clearTimeout(warnHandleRef.current);
      warnHandleRef.current = null;
    }
    if (tickHandleRef.current !== null) {
      window.clearInterval(tickHandleRef.current);
      tickHandleRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIsWarning(false);
    setSecondsUntilLogout(idleMs / 1000);
    clearTimers();
    if (!enabled) return;

    warnHandleRef.current = window.setTimeout(() => {
      setIsWarning(true);
      // Start a 1Hz countdown for the modal display.
      tickHandleRef.current = window.setInterval(() => {
        const remain = Math.max(
          0,
          Math.ceil((lastActivityRef.current + idleMs - Date.now()) / 1000),
        );
        setSecondsUntilLogout(remain);
      }, 1000);
    }, idleMs - warnMs);

    logoutHandleRef.current = window.setTimeout(() => {
      clearTimers();
      onLogoutRef.current();
    }, idleMs);
  }, [enabled, idleMs, warnMs, clearTimers]);

  useEffect(() => {
    if (!enabled) {
      clearTimers();
      setIsWarning(false);
      return;
    }
    reset();

    const handleActivity = () => reset();
    for (const ev of ACTIVITY_EVENTS) {
      document.addEventListener(ev, handleActivity, { passive: true });
    }
    // visibilitychange isn't user activity per se, but coming back to a
    // backgrounded tab is a reasonable "user is here" signal.
    document.addEventListener('visibilitychange', handleActivity);
    return () => {
      for (const ev of ACTIVITY_EVENTS) {
        document.removeEventListener(ev, handleActivity);
      }
      document.removeEventListener('visibilitychange', handleActivity);
      clearTimers();
    };
  }, [enabled, reset, clearTimers]);

  return { isWarning, secondsUntilLogout, reset };
}
