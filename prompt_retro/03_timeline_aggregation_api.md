# Stage 3 — Timeline Aggregation API

## Context

Stages 1 and 2 ensure every `StudentSession` is grouped into a `LearningEpisode`. Now we need the read-side: a single endpoint that returns everything a researcher needs to render an episode timeline, with **server-side downsampling** so we don't send 10Hz gaze data when the UI is showing a 1-hour zoom.

This stage is **backend-only**. UI comes in Stage 4.

## Tasks

### 1. New module: `research/episode-timeline`

Create `src/modules/research/episode-timeline/` with:

- `episode-timeline.controller.ts`
- `episode-timeline.service.ts`
- `episode-timeline.module.ts`
- DTOs in `dto/`

Wire into the main app module. Guard everything with `JwtAuthGuard` + `RolesGuard` + `@Roles('teacher', 'admin')`. **Students must not have access to research routes.**

### 2. Endpoint: list episodes for a student in a course

```
GET /api/research/courses/:courseId/students/:studentId/episodes
  ?from=<ISO>&to=<ISO>&limit=50&offset=0
```

Response:

```ts
{
  total: number;
  episodes: Array<{
    id: string;
    startedAt: string; // ISO
    endedAt: string | null;
    durationMs: number; // endedAt - startedAt, or null
    totalActiveSecs: number;
    sessionCount: number;
    groupingMethod: string;
    groupingConfidence: number | null;
    hasVideo: boolean; // true if any RecordingSegment exists for any session
    // Quick health flags for the list view:
    flags: {
      atRiskCount: number; // count of derived_at_risk_flags rows linked to any session
      refreshGapCount: number; // sessionCount - 1 (number of refresh boundaries)
    };
  }>;
}
```

Authorization rule: the requesting teacher must own the course (or be an admin).

### 3. Endpoint: full episode timeline payload

```
GET /api/research/episodes/:id/timeline
  ?from=<msFromEpisodeStart>&to=<msFromEpisodeStart>
  &resolution=<low|medium|high|raw>
  &modalities=<comma-separated list>
```

`from` / `to` are **milliseconds relative to `episode.startedAt`**. Default: full episode.

`resolution` controls downsampling targets (see #4 below). Default: `medium`.

`modalities` is a filter — if omitted, return everything. Comma-separated values from:
`activity, video, gaze, pupil, emotion, au, derived, ef_detection, dialogue, click, scroll, cursor, visibility, error, affective_state, at_risk`.

Response shape (TypeScript):

```ts
type TimelinePayload = {
  episode: {
    id: string;
    userId: string;
    courseId: string;
    startedAt: string; // ISO — the t0 anchor
    endedAt: string | null;
    durationMs: number | null;
    sessionCount: number;
    groupingMethod: string;
    groupingConfidence: number | null;
  };
  // Session boundaries within the episode — render these as refresh markers
  sessionBoundaries: Array<{
    sessionId: string;
    sessionStartMs: number; // relative to episode t0
    sessionEndMs: number | null;
    refreshGapMsBefore: number | null; // gap from previous session's endedAt; null for first
    userAgent: string | null;
    ipAddress: string | null;
  }>;
  // Stitched video manifest
  video: {
    segments: Array<{
      id: string;
      sessionId: string;
      minioKey: string; // signed URL minted separately — see #5
      signedUrl: string;
      startMs: number; // relative to episode t0 (from RecordingSegment.startWallTime)
      endMs: number;
      durationMs: number;
      fileSizeBytes: number;
    }>;
    totalDurationMs: number; // sum of segment durations (NOT episode duration — gaps excluded)
  };
  lanes: {
    activity?: Array<{ tMs: number; sessionId: string; action: string; metadata: any }>;
    gaze?: Array<{ tMs: number; x: number; y: number; conf: number }>;
    pupil?: Array<{ tMs: number; diameter: number }>;
    emotion?: Array<{ tMs: number; dominant: string; scores: Record<string, number> }>;
    au?: Array<{ tMs: number; aus: Record<string, number> }>; // AU01..AU28
    affective?: Array<{
      startMs: number;
      endMs: number;
      engagement: number;
      boredom: number;
      confusion: number;
      frustration: number;
      dominantState: string;
    }>;
    derived?: {
      engagement: Array<{ startMs: number; endMs: number; score: number }>;
      cognitiveLoad: Array<{ startMs: number; endMs: number; index: number }>;
    };
    atRisk?: Array<{ tMs: number; riskLevel: string; reasons: any }>;
    efDetection?: Array<{
      tMs: number;
      messageId: string;
      constructKey: string;
      label: string;
      confidence: number;
      severity: string | null;
      rationale: string;
    }>;
    dialogue?: Array<{ tMs: number; messageId: string; role: string; preview: string }>;
    click?: Array<{ tMs: number; x: number; y: number; pageUrl: string; elementSelector: string }>;
    scroll?: Array<{ tMs: number; scrollY: number; scrollPercent: number; pageUrl: string }>;
    cursor?: Array<{ tMs: number; x: number; y: number; pageUrl: string }>; // already throttled
    visibility?: Array<{ tMs: number; visibleState: string; hiddenDurationMs: number | null }>;
    error?: Array<{ tMs: number; errorMessage: string; pageUrl: string; errorType: string }>;
  };
  meta: {
    resolution: string;
    requestedRangeMs: { from: number; to: number };
    downsampledLanes: string[]; // which lanes had downsampling applied
    truncatedLanes: Array<{ lane: string; capHit: number }>; // if any lane hit a hard row cap
  };
};
```

### 4. Downsampling rules

Each modality has a "natural" rate (1Hz, 2Hz, 10Hz, etc.). Downsample on the SQL side using `time_bucket`-style aggregation (Postgres window functions, or `date_bin`). Targets:

| Resolution | Bucket size                                     | Applies to                                                                   |
| ---------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `raw`      | none — return every row, capped at 50k per lane | All                                                                          |
| `high`     | 200ms                                           | gaze, pupil, cursor, AU                                                      |
| `medium`   | 1s                                              | gaze, pupil, cursor, AU; events emitted as-is                                |
| `low`      | 5s                                              | gaze, pupil, cursor, AU, emotion frame; derived/affective windows kept as-is |

For event-style lanes (activity, click, error, ef_detection, dialogue, atRisk, visibility), **never downsample** — they are inherently sparse. Cap at 10k rows per lane and report truncation in `meta.truncatedLanes`.

For the AU lane at `medium`/`low`, return per-bucket means for the 18 tracked AUs.

For gaze at `medium`/`low`, return per-bucket centroid (mean x, mean y, mean confidence).

### 5. Video URLs

Use the existing MinIO client to mint **signed URLs** valid for the request user's session length (1h is fine — the UI will refresh if needed). Don't return raw MinIO keys to the client. Each segment's `signedUrl` is a presigned GET.

### 6. Performance

This endpoint will be slow if implemented naively. Required optimizations:

- **Run lane queries in parallel** via `Promise.all` — they're independent reads.
- **Bound every query** by `(sessionId IN $episodeSessionIds, timestamp BETWEEN $from AND $to)`. Index check: confirm `(sessionId, timestamp)` composite indexes exist on the high-volume tables (`webgazer_log`, `pupil_size_log`, `cursor_logs`, `click_logs`, `emotion_frame`, `pyfeat_au_result`). If missing, add a migration in this stage to create them.
- Use **raw SQL via `prisma.$queryRaw`** for the bucketed aggregations — Prisma's groupBy doesn't express time-bucketing well.
- Add a **request-scoped timing log**: log total duration + per-lane duration at INFO level. We need this to identify slow queries in production.

### 7. Episode summary endpoint (for the list view)

```
GET /api/research/episodes/:id/summary
```

Lightweight version of the timeline payload — just episode metadata, session boundaries, and one-line counts per lane (e.g. `{ activity: 1245, gaze: 38201, ... }`). Used by the episode picker UI.

### 8. Zod schemas in `@ats/shared`

Define the response types as Zod schemas in the shared package so the frontend can parse and type them. Export both the schema and inferred type:

```ts
export const TimelinePayloadSchema = z.object({ ... });
export type TimelinePayload = z.infer<typeof TimelinePayloadSchema>;
```

Same for `EpisodeListItem`, `EpisodeSummary`, lane row types.

### 9. Tests

In `test/episode-timeline.service.spec.ts`:

- Seed an episode with 2 sessions, ~5 minutes of synthetic gaze + pupil + activity + 1 video segment.
- Request `resolution=raw` → returns every row.
- Request `resolution=medium` → gaze/pupil bucketed to 1s, activity unchanged.
- Request with `modalities=gaze,activity` → other lanes are absent (not empty arrays).
- Request with `from=60000&to=120000` → only rows in that window.
- Episode owned by another teacher → 403.
- Cap-hit case: insert 11k click_logs → response includes `meta.truncatedLanes`.

Integration test for the controller: full HTTP flow with a teacher JWT.

## Acceptance criteria

- [ ] All three endpoints return correct shapes verified against Zod schemas
- [ ] Episode timeline for a 1-hour session returns in under 2 seconds at `resolution=medium`
- [ ] Concurrent lane queries verified via timing logs (parallel, not sequential)
- [ ] Required indexes added to schema and migrated
- [ ] Video segment URLs are signed and expire
- [ ] Authorization: a teacher cannot read another teacher's course episodes
- [ ] Tests pass: `pnpm test episode-timeline`

## Notes / gotchas

- **Episode-relative time (`tMs`) is the contract.** The frontend should never have to do its own `wallTime - episodeStart` math. Compute it server-side.
- The `RecordingSegment` table stores `startWallTime` as wall-clock — convert to relative ms in the response: `tMs = startWallTime - episode.startedAt`.
- `aligned_frames` is a precomputed table for post-hoc multimodal sync. **Do not query it for the live timeline endpoint** — that's for a future "frame-level inspector" feature. Use the raw modality tables here.
- If an episode is still active (`endedAt IS NULL`), set `durationMs` to `now() - startedAt` and proceed normally. Researchers may want to inspect a session that just ended seconds ago.
- Some old episodes may have sessions where biometric consent was not given — those sessions will have no `RecordingSegment`, no `WebgazerLog`, etc. Handle gracefully (empty lanes, `hasVideo: false`).
- Don't forget to add an OpenAPI/Swagger annotation for these endpoints if the project exposes API docs.
