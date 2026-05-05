# Retrospective Tracing — Claude Code Prompt Pack

This directory contains a sequence of prompts to feed into **Claude Code** to implement the **Retrospective Tracing** feature on the teacher portal.

## What we're building

A teacher/researcher tool that lets you replay any past study session as a **video-anchored, multi-modal timeline**. The video is the master scrubber; every other log stream (gaze, pupil, AUs, emotions, clicks, dialogue, EF detections, etc.) is rendered as a synchronized lane below it.

A second core problem is that **a single sitting can be split across multiple `StudentSession` rows** when a student refreshes the browser. We solve this by introducing a `LearningEpisode` concept that groups related sessions, with three layers of grouping (client-side ID, server heuristic, manual override).

## Stage order and dependencies

Run these in order. Each stage builds on the previous.

| #   | File                              | Builds                                                                                              | Depends on |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `01_database_episode_grouping.md` | `LearningEpisode` model, episode FK on `StudentSession`, heuristic grouper service, backfill script | —          |
| 2   | `02_client_episode_tracking.md`   | `learningEpisodeId` in localStorage, `X-Learning-Episode-Id` header, server-side intake             | Stage 1    |
| 3   | `03_timeline_aggregation_api.md`  | `GET /research/episodes/:id/timeline` endpoint with downsampling                                    | Stage 1    |
| 4   | `04_video_player_timeline_ui.md`  | Teacher-portal page shell, stitched video player, timeline ruler, refresh-gap markers               | Stage 3    |
| 5   | `05_lanes_inspector_ui.md`        | All modality lanes, gaze overlay on video, inspector panel, click-to-jump                           | Stage 4    |
| 6   | `06_merge_split_export.md`        | Episode merge/split tools, annotations, episode-scoped CSV/JSONL export                             | Stage 5    |

## How to use these prompts

1. Open Claude Code in the repo root.
2. Paste the contents of one stage file as your message.
3. Review the diff carefully before accepting — these touch many files.
4. Run the migration / start dev servers / run tests as instructed at the end of each stage.
5. Move to the next stage only when the current one passes its acceptance criteria.

## Conventions assumed by all prompts

- **Backend:** NestJS 10 + Prisma 6.19 in `apps/api/` (or wherever the Nest app lives — adjust paths if different).
- **Frontend:** React 18 + Vite + Tailwind v4 + React Router v6 in `apps/web/`.
- **Shared package:** `@ats/shared` (Zod schemas + types) — add new types here, not duplicated.
- **Auth:** Every new endpoint uses `JwtAuthGuard` + `RolesGuard` with `@Roles('teacher', 'admin')` for research/teacher routes.
- **Real-time:** Only used where needed; retrospective tracing is read-only historical, so REST is sufficient.
- **Linting:** Pre-commit hooks run typecheck + ESLint + Prettier — code must pass.

## Out of scope (for now)

- Live (current-session) tracing — this feature is **historical only**.
- Cross-student aggregate views (cohort heatmaps) — separate future feature.
- Mobile/tablet UI for the tracing view — desktop-first.
- Public sharing of episode replays — internal teacher portal only.
