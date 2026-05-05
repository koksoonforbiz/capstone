import { useEffect, useRef, useState } from 'react';

/**
 * Trailing-edge throttle for any value. Returns the most recent value
 * but caps update frequency to once per `intervalMs`.
 *
 * Used to keep the inspector "Now" tab responsive without re-rendering
 * 60Hz when the playhead is moving at video frame rate.
 */
export function useThrottled<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastEmittedRef = useRef<number>(0);
  const pendingValueRef = useRef<T>(value);
  const pendingHandleRef = useRef<number | null>(null);

  useEffect(() => {
    pendingValueRef.current = value;
    const now = performance.now();
    const elapsed = now - lastEmittedRef.current;
    if (elapsed >= intervalMs) {
      lastEmittedRef.current = now;
      setThrottled(value);
      return;
    }
    if (pendingHandleRef.current !== null) {
      window.clearTimeout(pendingHandleRef.current);
    }
    pendingHandleRef.current = window.setTimeout(() => {
      lastEmittedRef.current = performance.now();
      pendingHandleRef.current = null;
      setThrottled(pendingValueRef.current);
    }, intervalMs - elapsed);
    return () => {
      if (pendingHandleRef.current !== null) {
        window.clearTimeout(pendingHandleRef.current);
        pendingHandleRef.current = null;
      }
    };
  }, [value, intervalMs]);

  return throttled;
}
