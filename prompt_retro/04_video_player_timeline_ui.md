# Stage 4 — Video Player + Timeline UI Shell (Teacher Portal)

## Context

Stage 3 gives us the data. Now we build the **teacher-portal page** where a researcher picks an episode and sees a stitched video player synchronized with a master timeline ruler. Lanes (gaze, pupil, AUs, etc.) come in Stage 5 — this stage focuses on the **shell**: routing, episode picker, video stitching across `RecordingSegment`s, the timeline ruler, and refresh-gap markers.

**Hard rule:** the video's current playback position is the single source of truth. Everything else slaves to it.

## Tasks

### 1. Routing

Add to the teacher portal router (`apps/web/src/routes/teacher/`):

- `/teacher/research/courses/:courseId/students/:studentId/episodes` — episode picker
- `/teacher/research/episodes/:episodeId` — retrospective tracing view

Both routes guarded for `role === 'teacher' || role === 'admin'`.

### 2. Episode picker page

File: `apps/web/src/pages/teacher/research/EpisodePickerPage.tsx`

Fetches `GET /api/research/courses/:courseId/students/:studentId/episodes`. Shows a sortable table:

| Started | Duration | Sessions | Active time | Video | Refresh gaps | At-risk flags | Grouping | Actions |
| ------- | -------- | -------- | ----------- | ----- | ------------ | ------------- | -------- | ------- |

- "Grouping" column shows method + confidence as a small badge (green for `client_episode_id`, yellow for `auto_heuristic` ≥0.9, orange for lower confidence, gray for `manual`).
- "Video" column shows a camera icon if `hasVideo`, dimmed if not.
- Row click → navigate to `/teacher/research/episodes/:episodeId`.
- Default sort: `startedAt DESC`.
- Filter controls: date range, "has video only", min duration.

Use `react-query` (or the project's existing data-fetching hook) with a 30s stale time.

### 3. Retrospective tracing page shell

File: `apps/web/src/pages/teacher/research/EpisodeTracePage.tsx`

Layout (use Tailwind, no extra UI lib — match the project's existing patterns):

```
┌──────────────────────────────────────────────────────────────────┐
│  Header: student name, course, episode start time, duration      │
│          [Back to episodes]  [Resolution: medium ▾]  [Export ▾]  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌────────────────────────────────┐                             │
│   │                                │   ┌─ Inspector ───────────┐ │
│   │      Stitched video player     │   │                       │ │
│   │      (16:9, ~720p max)         │   │  (Stage 5)            │ │
│   │                                │   │                       │ │
│   └────────────────────────────────┘   └───────────────────────┘ │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  Timeline ruler (wall clock + relative)                          │
│  Refresh markers: │     │       │                                │
├──────────────────────────────────────────────────────────────────┤
│  [Lanes — Stage 5]                                               │
└──────────────────────────────────────────────────────────────────┘
```

The page fetches `GET /api/research/episodes/:id/timeline` once on mount with `resolution=medium` and the full range. Show a skeleton loader while fetching.

### 4. Stitched video player component

File: `apps/web/src/components/research/StitchedVideoPlayer.tsx`

Props:

```ts
type Props = {
  segments: VideoSegment[]; // from timeline payload, ordered
  episodeDurationMs: number;
  currentMs: number; // controlled — episode-relative position
  onTimeUpdate: (ms: number) => void;
  onSeek: (ms: number) => void;
  playing: boolean;
  onPlayingChange: (p: boolean) => void;
  playbackRate: number;
  onPlaybackRateChange: (r: number) => void;
};
```

**Behaviour:**

- Renders one `<video>` element. Source = current segment's `signedUrl`.
- Tracks `currentMs` (episode-relative). When `currentMs` falls inside `[segment.startMs, segment.endMs]`, set `<video>.currentTime = (currentMs - segment.startMs) / 1000`.
- On `timeupdate` from the video, compute `currentMs = segment.startMs + video.currentTime*1000` and call `onTimeUpdate`.
- When `currentMs` crosses into a different segment, swap `src` to that segment's `signedUrl`. Use `loadedmetadata` event before resuming playback.
- When `currentMs` lands in a gap **between** segments (refresh window), pause the video, show an overlay: "Refresh gap (Xs) — no video recorded". User can still scrub through it; video resumes when they enter the next segment.
- Controls: play/pause, ±5s, ±15s, playback rate (0.5x, 1x, 1.5x, 2x), full-screen toggle. Keyboard: Space = play/pause, ← → = ±5s, Shift+← → = ±15s.

**Important:** segments may have small overlaps or sub-second gaps from the recorder rotating. Snap to the segment whose `startMs <= currentMs < endMs`; if none matches, treat as gap.

### 5. Master timeline ruler component

File: `apps/web/src/components/research/TimelineRuler.tsx`

Props:

```ts
type Props = {
  episodeStartedAt: Date;
  episodeDurationMs: number;
  currentMs: number;
  onSeek: (ms: number) => void;
  zoomMs: number; // visible window width in ms
  onZoomChange: (ms: number) => void;
  panMs: number; // start of visible window relative to episode
  onPanChange: (ms: number) => void;
  sessionBoundaries: SessionBoundary[];
};
```

**Renders:**

- A horizontal axis with two label rows: top = wall-clock (HH:MM:SS), bottom = episode-relative (`+MM:SS` or `+HH:MM:SS`).
- Tick density adapts to zoom. Minimum tick spacing 60px.
- A vertical playhead line at `currentMs`. Draggable.
- Vertical bands at every refresh gap (between consecutive `sessionBoundaries`). Color = warm gray, with hover tooltip: "Refresh — gap of Xs from previous session".
- Vertical thin lines at each session start with the session ID truncated to 8 chars.
- Click anywhere on the ruler → `onSeek(clickedMs)`.
- Mouse wheel + Ctrl/⌘ = zoom (centered on cursor). Mouse wheel without modifier = pan.
- Pinch-zoom on touchpads (gesture event) also supported.

Implementation: SVG, not Canvas. We're not rendering 100k items here — this is just the ruler. The lanes in Stage 5 may use Canvas where needed.

### 6. Time state hook

Create `apps/web/src/hooks/useTimelineState.ts`:

```ts
function useTimelineState(episode: TimelinePayload['episode']): {
  currentMs: number;
  setCurrentMs: (ms: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  playbackRate: number;
  setPlaybackRate: (r: number) => void;
  zoomMs: number;
  setZoomMs: (ms: number) => void;
  panMs: number;
  setPanMs: (ms: number) => void;
  // derived
  visibleRangeMs: { from: number; to: number };
  msToPx: (ms: number, containerWidthPx: number) => number;
  pxToMs: (px: number, containerWidthPx: number) => number;
};
```

This is the central state store for the page. `EpisodeTracePage` owns one instance and threads it down. Don't use Zustand/Redux for this — `useState` + memoization is enough.

### 7. URL state

Sync `currentMs`, `zoomMs`, `panMs` to the URL as query params (`?t=&zoom=&pan=`) so researchers can copy-paste a link to a specific moment. Use `useSearchParams` from React Router, debounced 300ms.

### 8. Loading and error states

- Initial fetch loading → centered skeleton (video frame placeholder + ruler shimmer).
- Fetch error → inline error card with retry button.
- Episode has no video segments → render the page anyway, show a "No video recorded for this episode" placeholder where the player would be. Lanes still render in Stage 5.

### 9. Keyboard accessibility

- Page is keyboard-navigable: Tab cycles through controls.
- Playhead is `role="slider"` with arrow-key seeking.
- Refresh-gap markers are focusable with descriptive `aria-label`.

## Acceptance criteria

- [ ] Episode picker lists all episodes for a course/student with correct grouping badges
- [ ] Clicking an episode opens the trace page and loads the timeline payload
- [ ] Video plays continuously across multiple `RecordingSegment`s without manual reload
- [ ] Scrubbing the ruler seeks the video; `<video>.timeupdate` updates the playhead position
- [ ] Refresh gaps show as labeled bands and pausing the video while in a gap is automatic
- [ ] Zoom + pan work via mouse wheel + Ctrl, and stay centered on cursor
- [ ] URL reflects current position; reloading the page restores it
- [ ] Page is responsive down to a 1280px viewport (not mobile-optimized — desktop only is OK)
- [ ] Keyboard shortcuts (Space, arrows) work
- [ ] Linter, typecheck, and existing tests all pass

## Notes / gotchas

- **Don't re-fetch the timeline on zoom/pan changes.** The Stage 3 endpoint returns the full episode. Zooming is a render concern, not a data concern. (Resolution-change re-fetches are OK and expected.)
- Browser autoplay policies may block the video from auto-playing on mount. Don't auto-play; show a play button overlay until the user clicks.
- Watch out for `currentMs` drift when the video tab is backgrounded — `requestVideoFrameCallback` is more accurate than `timeupdate` if available, but `timeupdate` is sufficient for v1.
- Do not stream video from MinIO directly through the API — use the **signed URL** in the segment payload. The `<video>` element fetches MinIO directly.
- **Reuse the design tokens** from `frontend-design` SKILL — load that SKILL.md before writing components if you're going to do anything visually opinionated.
- The "Export" button in the header is a placeholder for Stage 6. Stub it as disabled with a tooltip.
