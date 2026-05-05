/**
 * Client-side episode ID lifecycle (prompt_retro Stage 2).
 *
 * The browser-generated `learningEpisodeId` is the strongest grouping signal
 * we send to the server: tab/window context survives refreshes, brief network
 * hiccups, and reopens, so emitting the same UUID on every request from a
 * sitting lets the backend collapse multiple StudentSession rows into a
 * single LearningEpisode without relying on flaky heuristics.
 *
 * The ID lives in localStorage under three keys:
 *
 *   - `ats.learningEpisodeId`            — the active UUID v4
 *   - `ats.learningEpisodeLastActivity`  — epoch ms of most recent activity
 *   - `ats.learningEpisodeCourseId`      — courseId the episode is scoped to
 *
 * The episode rotates (i.e. `getOrCreateEpisodeId` returns a fresh UUID) when:
 *   - no episode is stored, OR
 *   - inactivity exceeds 30 minutes, OR
 *   - the requested courseId differs from the stored one.
 *
 * All localStorage interactions are wrapped in try/catch — Safari private
 * mode, full quotas, or disabled storage will silently fall back to in-memory
 * state, and the server-side heuristic grouper covers the gap.
 */

export const LE_STORAGE_KEY = 'ats.learningEpisodeId';
export const LE_LAST_ACTIVITY_KEY = 'ats.learningEpisodeLastActivity';
export const LE_COURSE_KEY = 'ats.learningEpisodeCourseId';
export const LE_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

// In-memory fallback when localStorage isn't available (Safari private mode,
// quota-full, browser settings disabling storage). Three plain refs — kept
// minimal because we don't want a parallel state machine, just a soft
// shadow of what localStorage *would* hold.
const memoryStore: { id: string | null; lastActivity: number | null; courseId: string | null } = {
  id: null,
  lastActivity: null,
  courseId: null,
};

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    if (key === LE_STORAGE_KEY) return memoryStore.id;
    if (key === LE_LAST_ACTIVITY_KEY) return memoryStore.lastActivity?.toString() ?? null;
    if (key === LE_COURSE_KEY) return memoryStore.courseId;
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    if (key === LE_STORAGE_KEY) memoryStore.id = value;
    else if (key === LE_LAST_ACTIVITY_KEY) memoryStore.lastActivity = parseInt(value, 10);
    else if (key === LE_COURSE_KEY) memoryStore.courseId = value;
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    if (key === LE_STORAGE_KEY) memoryStore.id = null;
    else if (key === LE_LAST_ACTIVITY_KEY) memoryStore.lastActivity = null;
    else if (key === LE_COURSE_KEY) memoryStore.courseId = null;
  }
}

function generateUuidV4(): string {
  // crypto.randomUUID is available in every browser we ship to (Chrome 92+,
  // Safari 15.4+, Firefox 95+) and inside Vitest/jsdom.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Pre-2022 fallback: assemble from getRandomValues. Same RFC 4122 v4 layout.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  buf[6] = (buf[6]! & 0x0f) | 0x40;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function writeAll(id: string, courseId: string): void {
  safeWrite(LE_STORAGE_KEY, id);
  safeWrite(LE_LAST_ACTIVITY_KEY, Date.now().toString());
  safeWrite(LE_COURSE_KEY, courseId);
}

/**
 * Return the current episode ID, rotating to a fresh UUID when the stored
 * episode is too old, missing, or scoped to a different course.
 *
 * Always touches `lastActivity` so subsequent calls see a fresh timestamp.
 */
export function getOrCreateEpisodeId(courseId: string): string {
  const existingId = safeRead(LE_STORAGE_KEY);
  const existingCourse = safeRead(LE_COURSE_KEY);
  const lastActivityRaw = safeRead(LE_LAST_ACTIVITY_KEY);
  const lastActivity = lastActivityRaw ? parseInt(lastActivityRaw, 10) : NaN;

  const inactivityExceeded =
    Number.isFinite(lastActivity) && Date.now() - lastActivity > LE_INACTIVITY_THRESHOLD_MS;

  const shouldRotate =
    !existingId ||
    !Number.isFinite(lastActivity) ||
    inactivityExceeded ||
    existingCourse !== courseId;

  if (shouldRotate) {
    const next = generateUuidV4();
    writeAll(next, courseId);
    return next;
  }

  // Existing episode is fresh and matches the course — just touch activity.
  safeWrite(LE_LAST_ACTIVITY_KEY, Date.now().toString());
  return existingId!;
}

/**
 * Force-rotate the episode ID. Used by the visibility listener after a
 * confirmed inactivity rollover, and by integration tests.
 *
 * The caller must already know the courseId — this function preserves the
 * stored courseId; if there isn't one yet, the new episode is courseless
 * until the next `getOrCreateEpisodeId(courseId)` call upgrades it.
 */
export function rotateEpisodeId(): string {
  const courseId = safeRead(LE_COURSE_KEY) ?? '';
  const next = generateUuidV4();
  safeWrite(LE_STORAGE_KEY, next);
  safeWrite(LE_LAST_ACTIVITY_KEY, Date.now().toString());
  if (courseId) safeWrite(LE_COURSE_KEY, courseId);
  return next;
}

/** Drop all three keys — called on explicit logout. */
export function clearEpisodeId(): void {
  safeRemove(LE_STORAGE_KEY);
  safeRemove(LE_LAST_ACTIVITY_KEY);
  safeRemove(LE_COURSE_KEY);
}

/**
 * Cheap heartbeat. Updates `lastActivity` to now() without changing the ID.
 * Wired to the api.ts response success path and the interaction-log batch
 * flush (see useInteractionLogger.flushAll), so an actively-using student's
 * episode never times out.
 */
export function touchEpisodeActivity(): void {
  safeWrite(LE_LAST_ACTIVITY_KEY, Date.now().toString());
}

/**
 * Read the current episode ID without side effects (no rotation, no
 * activity touch). Used by the request interceptor in api.ts so a request
 * that fires before the React hook has run can still attach the header.
 */
export function readEpisodeIdOrNull(): string | null {
  return safeRead(LE_STORAGE_KEY);
}
