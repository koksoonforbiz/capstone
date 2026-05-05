# Stage 2 — Client-Side Episode ID Tracking

## Context

Stage 1 added `LearningEpisode` and a server-side heuristic grouper that infers grouping from gap + user-agent + IP. The heuristic catches most cases but isn't always right (e.g. two students on the same school proxy refreshing within 5 minutes).

This stage adds the **strongest signal**: a client-generated `learningEpisodeId` persisted in `localStorage` that survives refreshes. The browser knows it's the same sitting because the tab/window context remembers — we just need to pass that knowledge to the server.

## Tasks

### 1. Frontend: episode ID lifecycle

Create `apps/web/src/lib/learning-episode.ts`:

```ts
export const LE_STORAGE_KEY = 'ats.learningEpisodeId';
export const LE_LAST_ACTIVITY_KEY = 'ats.learningEpisodeLastActivity';
export const LE_COURSE_KEY = 'ats.learningEpisodeCourseId';
export const LE_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

export function getOrCreateEpisodeId(courseId: string): string { ... }
export function rotateEpisodeId(): string { ... }
export function clearEpisodeId(): void { ... }
export function touchEpisodeActivity(): void { ... }
```

**Rules for `getOrCreateEpisodeId`**:

1. Read `LE_STORAGE_KEY`, `LE_LAST_ACTIVITY_KEY`, `LE_COURSE_KEY`.
2. **Rotate** (generate new UUID v4, write all three keys, return new) if any of:
   - No existing episode ID
   - `Date.now() - lastActivity > 30 min`
   - Stored `courseId` differs from the requested one
3. Otherwise return the existing ID and update `lastActivity` to now.

`rotateEpisodeId()` always generates a new UUID and writes it.
`clearEpisodeId()` removes all three keys (called on explicit logout).

### 2. React hook

Create `apps/web/src/hooks/useLearningEpisode.ts`:

```ts
export function useLearningEpisode(courseId: string | undefined): { episodeId: string | null };
```

- When `courseId` becomes available, call `getOrCreateEpisodeId(courseId)` and return.
- Set up a `visibilitychange` listener: when the tab returns to visible, re-check inactivity threshold and rotate if exceeded.
- On unmount, do nothing (we want it to persist).

### 3. Wire into the auth/session flow

Find the auth context / login mutation (likely `apps/web/src/lib/auth.ts` or similar):

- **On login success**: do not auto-generate the episode ID yet — we don't know which course the student will enter. Just clear any stale ID by calling `clearEpisodeId()`.
- **On explicit logout**: call `clearEpisodeId()`.

Find the course-entry route (where a student lands on a course dashboard, e.g. `/courses/:id`):

- Use the `useLearningEpisode(courseId)` hook here.
- Once the episode ID resolves, ensure it's attached to the axios/fetch instance default headers.

### 4. Axios interceptor (or fetch wrapper)

In `apps/web/src/lib/http.ts` (or wherever the API client lives):

- Add a request interceptor that reads `LE_STORAGE_KEY` from `localStorage` and, if present, attaches `X-Learning-Episode-Id: <uuid>`.
- Also call `touchEpisodeActivity()` on every successful response (cheap heartbeat — keeps the episode alive while the user is making API calls).

### 5. Activity-driven heartbeat

The platform already throttles cursor/click/scroll events (Stage 0 docs say batched every 30s). Hook into the existing batch flush:

- Just before sending the batch, call `touchEpisodeActivity()`.
- This means an active student's episode never expires even if they don't trigger React re-renders.

### 6. Backend: read the header on session creation

Update wherever `StudentSession` is created (touched in Stage 1):

- Extract `X-Learning-Episode-Id` header (lowercased, since Node normalizes).
- Validate format: must be a UUID v4. Reject silently if invalid (fall through to heuristic).
- Pass as `clientEpisodeId` to `EpisodeGroupingService.assignEpisodeForSession`.

Validation rule for `EpisodeGroupingService` (already specified in Stage 1, restating):

- If the `clientEpisodeId` exists and belongs to **a different user**, ignore it and log a warning (this is a security signal — possible token leak or shared device).
- If it exists and belongs to the same user but a **different course**, ignore it (treat as new episode).
- If it doesn't exist at all but is a valid UUID, **create the episode with that ID** so the client and server stay in sync.

### 7. Telemetry

Add a count of `groupingMethod` outcomes to the existing metrics endpoint (or log them). We want to monitor:

- % of sessions assigned via `client_episode_id`
- % via `auto_heuristic`
- Distribution of `groupingConfidence`

Goal: confirm in production that ≥80% of refresh-induced new sessions get correctly grouped via the client ID path.

### 8. Tests

Frontend (`apps/web/src/lib/learning-episode.test.ts`):

- Returns existing ID when within threshold
- Rotates when inactivity exceeds threshold
- Rotates when courseId changes
- `clearEpisodeId` removes all keys
- `touchEpisodeActivity` updates timestamp without changing ID

Backend:

- Extend `episode-grouping.service.spec.ts` with cases:
  - Valid client ID for same user + course → attaches with method `"client_episode_id"`
  - Client ID for different user → ignored, falls through to heuristic, warning logged
  - Client ID with valid UUID but no matching episode → creates new episode with that ID
  - Malformed `X-Learning-Episode-Id` header → 4xx? No — silently fall through (don't break session creation over a header bug)

## Acceptance criteria

- [ ] Login as student, enter a course → DevTools shows `X-Learning-Episode-Id` on subsequent requests
- [ ] Refresh the page → same `X-Learning-Episode-Id`, server attaches new session to existing episode
- [ ] Sit idle for 30+ minutes, return → new episode ID generated, new episode created
- [ ] Switch courses → new episode ID generated
- [ ] Logout → `localStorage` keys cleared
- [ ] `localStorage` disabled in browser → still works (heuristic kicks in, just less accurate)
- [ ] All new tests pass

## Notes / gotchas

- **Do not** use `sessionStorage`. We specifically need refresh persistence, which is `localStorage`.
- Don't put the episode ID in cookies — we don't need it sent on every request unconditionally, and cookies create CSRF complications.
- Two tabs on the same course will share the same episode ID via `localStorage`. That's fine — both windows are arguably the same sitting. Don't try to be clever with `BroadcastChannel` here.
- Be defensive against `localStorage` throwing (Safari private mode, full quota). Wrap in try/catch and fall back to in-memory storage; the heuristic will cover us.
- The header name is `X-Learning-Episode-Id` (capital X). Use that consistently — Express lowercases it server-side, but axios sends it as written.
