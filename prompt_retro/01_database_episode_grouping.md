# Stage 1 — Database Schema & Episode Grouping

## Context

Our platform tracks student study time via `StudentSession` rows. Each login (or token refresh) creates a new session, which means **a single study sitting gets fragmented across multiple sessions whenever the student refreshes the browser, briefly loses connection, or reopens a tab**.

For the upcoming Retrospective Tracing feature, researchers need to replay a "sitting" as one continuous timeline. We're introducing a `LearningEpisode` concept that groups 1..N `StudentSession` rows.

This stage is **backend-only**: schema, migration, grouping service, and a backfill job for historical data. No UI, no API endpoints yet.

## Tasks

### 1. Add the `LearningEpisode` Prisma model

In `prisma/schema.prisma`:

```prisma
model LearningEpisode {
  id                  String    @id @default(uuid())
  userId              String
  courseId            String
  startedAt           DateTime
  endedAt             DateTime?
  totalActiveSecs     Int       @default(0)
  sessionCount        Int       @default(0)
  groupingMethod      String    // "client_episode_id" | "auto_heuristic" | "auto_heuristic_backfill" | "manual"
  groupingConfidence  Float?    // 0..1, null for client-provided or manual
  notes               String?

  user      User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  course    Course           @relation(fields: [courseId], references: [id], onDelete: Cascade)
  sessions  StudentSession[]
  audits    EpisodeAudit[]

  @@index([userId, courseId, startedAt])
  @@index([courseId, startedAt])
}

model EpisodeAudit {
  id            String   @id @default(uuid())
  episodeId     String
  action        String   // "created" | "merged" | "split" | "annotated" | "session_attached" | "session_detached"
  actorUserId   String?  // null for system actions
  payload       Json     // context-dependent: e.g. { mergedFromIds: [...] }, { splitAtSessionId: ... }
  createdAt     DateTime @default(now())

  episode  LearningEpisode @relation(fields: [episodeId], references: [id], onDelete: Cascade)

  @@index([episodeId, createdAt])
}
```

Add to `StudentSession`:

```prisma
episodeId  String?
episode    LearningEpisode? @relation(fields: [episodeId], references: [id], onDelete: SetNull)

@@index([episodeId])
```

Add the inverse relation `episodes  LearningEpisode[]` to `User` and `Course`.

### 2. Create the migration

Run `pnpm prisma migrate dev --name add_learning_episode`. Verify the migration SQL adds:

- The two new tables with FKs
- `episodeId` column + index on `StudentSession`
- No data loss on existing rows

### 3. Build the `EpisodeGroupingService`

Create `src/modules/learning-episode/episode-grouping.service.ts` (NestJS module). Public methods:

```ts
class EpisodeGroupingService {
  /**
   * Called when a new StudentSession is created.
   * Returns the episodeId to attach. Creates a new episode if needed.
   */
  async assignEpisodeForSession(input: {
    sessionId: string;
    userId: string;
    courseId: string;
    startedAt: Date;
    userAgent?: string;
    ipAddress?: string;
    clientEpisodeId?: string; // from X-Learning-Episode-Id header (Stage 2)
  }): Promise<{ episodeId: string; method: string; confidence: number | null }>;

  /** Backfill all unassigned historical sessions. Idempotent. */
  async backfillAllSessions(opts?: {
    batchSize?: number;
    dryRun?: boolean;
  }): Promise<{ assigned: number; created: number }>;

  /** Recompute totalActiveSecs / sessionCount / endedAt aggregates for an episode. */
  async recomputeEpisodeAggregates(episodeId: string): Promise<void>;
}
```

**Grouping logic** (in priority order):

1. **If `clientEpisodeId` is provided and matches an existing episode for this user+course**, attach to it. Method = `"client_episode_id"`, confidence = `null`.
2. **Otherwise, fetch the most recent prior session for this user+course.** Apply heuristic:
   - If `gap < 5 min` AND `userAgent` matches → attach to same episode. Method = `"auto_heuristic"`, confidence = `0.95`.
   - If `gap < 15 min` AND `userAgent` matches AND `ipAddress` matches → attach to same episode. Method = `"auto_heuristic"`, confidence = `0.75`.
   - Otherwise → create a new episode. Confidence = `1.0` (high confidence it's a new sitting).
3. **Always write an `EpisodeAudit` row** with `action = "session_attached"` and the decision payload.

Thresholds (`5 min`, `15 min`) must come from `ConfigService`, not hardcoded — config keys: `EPISODE_GAP_MIN_TIGHT`, `EPISODE_GAP_MIN_LOOSE`. Default values match above.

### 4. Hook into the existing session-creation flow

Find wherever `StudentSession` rows are created (likely the auth or session module). After the row is inserted, call `assignEpisodeForSession` and update the row with the resulting `episodeId`. Do this **inside the same transaction** as session creation — partial state is worse than a brief lock.

If session creation already runs in a transaction, pass the Prisma `tx` client through to the service.

### 5. Backfill script

Create `scripts/backfill-episodes.ts` runnable via `pnpm tsx scripts/backfill-episodes.ts [--dry-run] [--batch-size=500]`.

It must:

- Iterate `StudentSession` rows where `episodeId IS NULL`, ordered by `(userId, courseId, startedAt ASC)`.
- For each, apply the same heuristic as #3 (no `clientEpisodeId` available for historical data — skip step 1).
- Use method `"auto_heuristic_backfill"` for all backfilled assignments.
- Print progress every batch and a final summary.
- Be safely re-runnable (idempotent — sessions with non-null `episodeId` are skipped).

### 6. Recompute aggregates on session end

Find where `StudentSession.endedAt` is set (session close handler / cron sweep). After update, call `recomputeEpisodeAggregates(episodeId)` to update:

- `endedAt` = max of all attached sessions' `endedAt`
- `totalActiveSecs` = sum of attached sessions' `durationSecs`
- `sessionCount` = count of attached sessions

### 7. Tests

In `test/episode-grouping.service.spec.ts`, cover:

- New user, no prior session → creates new episode, confidence 1.0
- 2-min gap, same UA → attaches with confidence 0.95
- 10-min gap, same UA, same IP → attaches with confidence 0.75
- 10-min gap, different UA → new episode
- 30-min gap → new episode
- `clientEpisodeId` provided and valid → attaches regardless of gap
- `clientEpisodeId` provided but doesn't belong to user → fails open to heuristic
- Backfill on a fixture with 50 sessions across 3 users produces sensible groupings

## Acceptance criteria

- [ ] `pnpm prisma migrate dev` runs cleanly on a fresh DB
- [ ] All new tests pass: `pnpm test episode-grouping`
- [ ] Backfill script run with `--dry-run` on existing dev data prints expected counts without writes
- [ ] Backfill run for real assigns every historical `StudentSession` an `episodeId`
- [ ] Creating a new session in dev (login as a student) results in `episodeId` being set immediately
- [ ] Linter and typecheck pass: `pnpm lint && pnpm typecheck`

## Notes / gotchas

- **Do not** modify any of the 41 log/tracking tables in this stage. They keep their `sessionId` FK; we'll join through `StudentSession.episodeId` at query time.
- Keep the grouping service pure where possible (inject Prisma, don't call other services) so it's easy to unit-test.
- The `EpisodeAudit` table will get heavily written — make sure the index is on `(episodeId, createdAt)`, not just `episodeId`.
- If a session's `endedAt` is updated retroactively (e.g. crash recovery), aggregates must be recomputed — don't forget that path.
