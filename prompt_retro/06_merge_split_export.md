# Stage 6 — Episode Merge/Split, Annotations & Scoped Export

## Context

By this point, retrospective tracing works end-to-end for a single auto-grouped episode. But the auto-grouper isn't perfect: the heuristic might split a single sitting (slow refresh + IP change), or merge two unrelated sittings (consecutive students on a school iPad). Researchers need to **manually correct grouping** and the system needs to keep an audit trail.

This stage adds:

1. Merge / split / detach operations on episodes
2. Persistent researcher annotations on episodes
3. Episode-scoped CSV/JSONL export, extending the existing export pipeline

## Tasks

### 1. Backend: episode mutation endpoints

In the `research/episode-timeline` module (or a new `research/episode-management` module), add:

#### `POST /api/research/episodes/merge`

```ts
body: { episodeIds: string[]; primaryId?: string; reason?: string }
response: { episodeId: string }
```

- All episodes must belong to the same `userId` and `courseId`. Reject 400 otherwise.
- All sessions from non-primary episodes are reassigned to `primaryId` (or to the earliest if not specified).
- Recompute aggregates on the surviving episode.
- Mark merged-away episodes as soft-deleted (add `deletedAt: DateTime?` to `LearningEpisode` if not already there).
- Write `EpisodeAudit` rows: one `"merged"` on the primary with `payload = { mergedFromIds, sessionIds, reason }`, and one `"session_detached"` per session per donor episode.
- The grouping method on the primary becomes `"manual"`, confidence `null`.

#### `POST /api/research/episodes/:id/split`

```ts
body: { splitAtSessionId: string; reason?: string }
response: { primaryId: string; newEpisodeId: string }
```

- The session at `splitAtSessionId` and all sessions starting **after** it become a new episode.
- The new episode's `groupingMethod = "manual"`, confidence `null`, `notes` = original notes + reason if provided.
- Recompute aggregates on both.
- Write `EpisodeAudit` rows on both episodes.

#### `POST /api/research/episodes/:id/detach-session`

```ts
body: { sessionId: string; targetEpisodeId?: string; reason?: string }
response: { sourceEpisodeId: string; targetEpisodeId: string }
```

- Detaches one session from current episode and either attaches it to `targetEpisodeId` (must belong to same user+course) or creates a new episode for just that session.
- Same audit + recompute rules.

#### `POST /api/research/episodes/:id/annotate`

```ts
body: {
  notes: string;
}
response: {
  id: string;
  notes: string;
}
```

- Replaces `LearningEpisode.notes`. Append-style history is overkill — but log to `EpisodeAudit` with `"annotated"` and the previous value in payload.

#### `GET /api/research/episodes/:id/audit`

Returns the `EpisodeAudit` history in chronological order with actor user names looked up.

All five endpoints require `@Roles('teacher', 'admin')` and the requesting teacher must own the course (or be admin).

### 2. UI: merge/split controls

In the trace page (`EpisodeTracePage`), add a **session boundary action menu**: when the researcher hovers a refresh-gap marker on the timeline ruler, show a small ⋯ button. Click reveals:

- **Split episode here** → creates new episode from this session onward. Confirm modal with reason field.
- **Detach this session** → submenu: "to a new episode" or "to existing episode (search dropdown)".

In the page header, next to "Back to episodes":

- **Merge with…** button → opens a modal listing recent episodes for this user+course with checkboxes. Confirm with a reason field.

After any mutation:

- Invalidate the timeline query and reload.
- Show a toast: "Episode split — primary now contains X sessions, new episode created with Y sessions. [Undo]" — the Undo button calls the inverse mutation within 30s.

### 3. UI: audit trail viewer

Add a "History" section to the inspector panel's "Session info" tab — really, on the episode level. List all `EpisodeAudit` entries with:

- Timestamp
- Actor (or "system" for auto-grouping)
- Action
- Human-readable summary of payload (e.g. "Merged from 2 episodes containing 4 sessions")

Episodes with `groupingMethod = "manual"` should display a small "Manually grouped" badge in the picker and on the trace page header.

### 4. UI: notes / annotations

Re-enable the "Notes" tab in the inspector (stubbed in Stage 5).

- Markdown-supported text area (use the existing markdown component if there is one).
- Auto-save on blur via `POST /api/research/episodes/:id/annotate`.
- Show "Last edited Xm ago by NAME" below.
- Notes appear in the episode picker as a tooltip on hover.

### 5. Episode-scoped export

Extend the existing CSV/JSONL export pipeline. Find the current export module — it likely lives somewhere like `apps/api/src/modules/export/` and writes to MinIO `log-exports/`.

Add:

#### `POST /api/research/episodes/:id/export`

```ts
body: {
  modalities: string[];      // same enum as Stage 3's modalities filter
  format: 'csv' | 'jsonl';
  includeVideo: boolean;     // if true, include signed URLs to all video segments in a manifest
}
response: { jobId: string }
```

- Creates an export job. Job processes asynchronously, uploads to MinIO under `log-exports/episodes/{episodeId}/{jobId}/`.
- One file per modality, plus an `episode.json` with metadata + session boundaries + audit summary.
- If `includeVideo`, write a `video_manifest.json` with segment metadata and signed URLs (longer expiry — 24h since researchers may download at leisure).

Reuse the existing job-tracking pattern (`EventQueue` if applicable, or whatever the platform uses).

#### `GET /api/research/episodes/:id/exports`

Lists previous export jobs for this episode, with status and download URLs.

#### Frontend

The "Export" button in the trace page header now opens a modal:

- Modality checklist (default: all)
- Format radio (CSV / JSONL)
- "Include video segment URLs" toggle
- Submit → kicks off job, switches modal to a status view.

When job completes, show a "Download" button. Re-opening the modal later shows past exports.

### 6. Permissions hardening

Audit the new endpoints for:

- Cross-tenant data leaks: a teacher must not be able to merge an episode from another teacher's course.
- The `targetEpisodeId` in detach-session must also pass the ownership check.
- Admin role bypasses ownership but still gets audit logged (set `actorUserId` regardless of role).

### 7. Tests

Backend:

- Merge two valid episodes → primary survives, sessions reassigned, audit rows written.
- Merge episodes from different users → 400.
- Split at first session of an episode → 400 (would create empty source).
- Detach session to a new episode → both have correct aggregates.
- Annotate writes to audit and updates the field.
- Export job completes and uploads expected files to MinIO (mock the storage in tests).
- Permission tests: teacher A cannot mutate teacher B's episode.

Frontend:

- Merge modal lists candidate episodes filtered to same user + course.
- Split confirmation requires a reason (or marks the audit with "no reason").
- Undo toast invokes the inverse mutation.
- Export modal disables Submit until at least one modality is selected.

E2E:

- Full path: open episode → split at second session → both episodes appear in picker → merge them back → original is restored (with audit trail showing the split-then-merge).

## Acceptance criteria

- [ ] All four mutation endpoints work and write audit rows
- [ ] Merge respects same-user / same-course constraints
- [ ] Split correctly partitions sessions and recomputes aggregates on both sides
- [ ] Audit trail visible in the UI with actor names and humanized actions
- [ ] Annotations persist and surface in the picker
- [ ] Export produces valid CSV/JSONL files in MinIO with the expected structure
- [ ] Video manifest in export contains segments with signed URLs valid for 24h
- [ ] Undo toast works within its 30s window
- [ ] Permission tests prevent cross-teacher access
- [ ] Linter, typecheck, all tests pass

## Notes / gotchas

- **Soft-delete merged episodes, don't hard-delete.** A researcher might publish a paper referencing an episode ID that later gets merged away — we need it resolvable.
- The `EpisodeAudit` table will be valuable for research-integrity audits. Make sure it includes enough context to fully reconstruct what happened, not just "merged" with a payload of `{}`.
- Be explicit about what the "Undo" toast does: for a merge, it re-splits using the audit payload to identify which sessions came from where; for a split, it re-merges; for detach, it re-attaches. Store the inverse-operation parameters in component state when showing the toast.
- The export endpoint's "Include video URLs" option is a privacy-sensitive feature. Add a confirmation step that says "Video URLs will be valid for 24 hours from generation. Treat the export bundle as confidential." Researchers downloading webcam footage of students need that reminder.
- Don't try to also implement cross-episode comparison views or cohort-level aggregations in this stage. Those are separate features. Keep this stage scoped to **single-episode management**.
- After this stage ships, consider monitoring how often merge/split is used. If it's high (>5% of episodes), the auto-grouping heuristic in Stage 1 needs tuning. Keep that data in mind.
