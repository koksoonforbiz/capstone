import { useEffect, useState } from 'react';
import {
  LE_INACTIVITY_THRESHOLD_MS,
  LE_LAST_ACTIVITY_KEY,
  getOrCreateEpisodeId,
  rotateEpisodeId,
} from '../lib/learning-episode';

/**
 * Resolves a `learningEpisodeId` for the current course context (Stage 2).
 *
 * Returns `null` while `courseId` is undefined (e.g. the page is still
 * loading the course). Once available, getOrCreateEpisodeId either returns
 * the stored ID (refresh case) or rotates a new one (cold start, expired,
 * or course-switch case).
 *
 * Subscribes to `visibilitychange` so a tab returning from background after
 * a long idle period rolls over to a fresh episode rather than reattaching
 * to a stale one — the inactivity check isn't fired by re-render alone.
 */
export function useLearningEpisode(courseId: string | undefined): { episodeId: string | null } {
  const [episodeId, setEpisodeId] = useState<string | null>(null);

  // Resolve / rotate when courseId becomes known or changes.
  useEffect(() => {
    if (!courseId) {
      setEpisodeId(null);
      return;
    }
    setEpisodeId(getOrCreateEpisodeId(courseId));
  }, [courseId]);

  // On tab visibility return, double-check the inactivity threshold. If it
  // crossed while the tab was hidden (most common path: laptop closed for
  // an hour) rotate so the next request lands in a new episode.
  useEffect(() => {
    if (!courseId) return;

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      let lastActivity = NaN;
      try {
        const raw = window.localStorage.getItem(LE_LAST_ACTIVITY_KEY);
        if (raw) lastActivity = parseInt(raw, 10);
      } catch {
        // localStorage unavailable — heuristic grouper covers the gap.
      }
      if (Number.isFinite(lastActivity) && Date.now() - lastActivity > LE_INACTIVITY_THRESHOLD_MS) {
        const next = rotateEpisodeId();
        setEpisodeId(next);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [courseId]);

  return { episodeId };
}
