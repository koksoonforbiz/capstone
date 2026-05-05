# Stage 5 — Modality Lanes, Gaze Overlay & Inspector Panel

## Context

Stage 4 gave us the video player, timeline ruler, and refresh-gap markers. Now we render **the actual research signal** — every modality as its own lane, synchronized to the playhead, plus a gaze overlay on the video and an inspector panel that explains whatever the playhead is currently over.

Many of these lanes can be visually dense (10Hz gaze, 1Hz AUs). Use Canvas for high-density lanes, SVG for sparse event lanes.

## Tasks

### 1. Lane container

File: `apps/web/src/components/research/LaneContainer.tsx`

Layout: a vertical stack of lanes, each lane a horizontal strip that shares the same x-axis (time) as the timeline ruler. The shared playhead line extends down through every lane.

Each lane has:

- A fixed-width left gutter (~180px) with: lane name, info icon (tooltip explaining what it shows), visibility toggle, height-adjust handle.
- A scrolling/fixed time axis area on the right.
- All lanes share the same `zoomMs` / `panMs` from `useTimelineState`.

Lane order (default; user can reorder via drag handle):

1. Activity events
2. EF detections (dialogue constructs)
3. Dialogue messages
4. Affective state windows
5. Emotion timeline
6. AU intensities (collapsed by default — expandable to show all 18 AUs)
7. Gaze (x,y trace)
8. Pupil diameter
9. Derived engagement
10. Derived cognitive load
11. At-risk flags
12. Click density
13. Scroll position
14. Visibility (page hidden/visible)
15. Errors

Persist lane order, visibility, and heights to `localStorage` per user (key: `ats.researchLaneConfig.v1`).

### 2. Lane primitives

Create reusable lane components in `apps/web/src/components/research/lanes/`:

#### a. `EventMarkerLane`

For sparse, point-in-time events: activity, errors, at-risk flags, dialogue messages, EF detections.

- SVG rendering.
- Each event = a colored marker (vertical tick or small icon).
- Hover → tooltip with details.
- Click → set `selectedEvent` in inspector + seek video to `tMs`.
- Color coded by event type (use the design token palette).

#### b. `LineSeriesLane`

For continuous numeric series: pupil diameter, derived engagement, derived cognitive load, scroll position.

- Canvas rendering.
- One line per series.
- Optional fill area below.
- Y-axis label on the right edge.
- Hover → vertical guide + tooltip showing value at cursor.

#### c. `StackedAreaLane`

For multi-component proportions: emotion timeline (8 emotions), affective state.

- Canvas rendering.
- Stacked areas summing to 1.0.
- Legend in the gutter (color swatches).
- Hover → tooltip with all components' values.

#### d. `GazePathLane`

Specialized for gaze. Two modes (toggle in gutter):

- **Trace mode**: x and y as two thin Canvas-rendered series.
- **Density mode**: a 1D heatmap showing how much movement happened per second (variance proxy).

#### e. `HeatmapLane`

For click density and cursor density over time.

- Canvas-rendered horizontal heatmap, bucketed to 5s.
- Darker = more events.

#### f. `BandLane`

For interval data: visibility (page hidden), affective state windows.

- SVG-rendered horizontal bands with color per state.
- Hover → state name + duration.

### 3. Gaze overlay on the video

File: `apps/web/src/components/research/GazeOverlay.tsx`

Renders an absolutely-positioned canvas on top of the video element. Draws:

- The current gaze point at `currentMs` (interpolated between the two nearest WebgazerLog entries).
- A short trailing path of the last ~2 seconds of gaze (fading out).
- Optional fixation circles where gaze stayed within ~30px for >200ms.

**Coordinate translation:**
WebgazerLog stores `gazeX`, `gazeY` in **viewport coordinates from the original recording session**. The current `<video>` element is showing what the student saw, but it might be scaled differently. We need the original viewport size to scale correctly — that's `viewport_logs` (width/height per page load).

Use the most recent `viewport_logs` row at-or-before `currentMs` to get the original viewport dimensions. Scale gaze (x, y) to the video element's rendered size:

```ts
const scaleX = videoRect.width / viewport.width;
const scaleY = videoRect.height / viewport.height;
const overlayX = gaze.x * scaleX;
const overlayY = gaze.y * scaleY;
```

Toggle in the player chrome to show/hide the overlay.

**Important:** the recorded webcam video is **NOT** what the student saw. It's their face. Re-read the architecture: `RecordingSegment` is webcam recording. So the overlay above only makes sense if there's also a screen recording — check whether the platform records screen too. **If no screen recording exists, drop the gaze overlay feature** and instead surface gaze as a 2D mini-map widget in the inspector showing "gaze position at current time" relative to a normalized 1.0×1.0 viewport. Adjust this section based on what's actually in the schema.

### 4. Inspector panel

File: `apps/web/src/components/research/InspectorPanel.tsx`

Right-side panel (collapsible, default 320px wide). Shows context for whatever is selected or under the playhead. Tabbed sections:

#### Tab: **Now** (default)

Whatever modalities have data at `currentMs`:

- Current activity (most recent ActivityLog event)
- Current page URL
- Gaze: x, y, confidence (or "not tracking")
- Pupil: diameter (mm or normalized)
- Dominant emotion: name + confidence
- AU spikes: list AUs > 1.0
- Affective state: dominantState + scores
- Engagement / cognitive load score from latest derived window

Auto-updates as the playhead moves (throttle 250ms — don't re-render on every frame).

#### Tab: **Selected event**

When the user clicks an event marker. Shows full row JSON in a readable format, plus a "Jump to" button (already at this time) and a "Copy event" button.

#### Tab: **Session info**

For the session containing the current `tMs`:

- Session ID
- Started / ended at
- Duration
- User agent + IP
- Refresh gap to next session (if any)
- Counts of each modality in this session

#### Tab: **Notes**

Researcher annotations. Local-only for this stage (Stage 6 will persist them via API). Provide a text area; "Save" is disabled with tooltip "Available in Stage 6".

### 5. Click-to-jump and cross-lane sync

When the user clicks any marker in any lane:

1. Set `currentMs` to the event's `tMs`.
2. Pause the video (researcher is examining a moment; don't keep playing).
3. Center the visible time window on this `tMs` if it's currently outside.
4. Update the inspector to "Selected event" tab with this event.

When the playhead moves (during playback or manual scrub), update the "Now" tab via `currentMs`.

### 6. Performance: virtualization & throttling

- Each Canvas lane should redraw only when its visible time window changes (zoom/pan/resize), not when `currentMs` ticks. The playhead is a **separate overlay layer** that moves cheaply.
- Lane data is filtered to the current `[panMs, panMs+zoomMs]` range before rendering. For very wide zooms, additionally bin to ≤2× the lane's pixel width.
- Use `requestAnimationFrame` for the playhead update loop, not React re-renders.
- React state for the playhead lives in `useTimelineState`, but the lane's playhead overlay reads it via a ref-based subscription pattern (or `useSyncExternalStore`) to avoid re-rendering all lanes 60 times a second.

### 7. Resolution selector

The header dropdown ("Resolution: medium ▾") triggers a refetch of the timeline endpoint with the new `resolution`. Show a subtle reload indicator. If the user is zoomed in tight, suggest `high` or `raw`; if zoomed out, suggest `low`.

### 8. Empty/missing modalities

If a modality returned an empty array (e.g. no gaze because consent wasn't given for that session), render the lane with a faint "No data for this episode" placeholder rather than hiding it — researchers need to know what's missing, not have it silently disappear.

### 9. Tests

Component tests (Vitest + React Testing Library):

- `EventMarkerLane` renders correct number of markers and fires `onSelect` on click
- `LineSeriesLane` draws path from input data (snapshot test)
- `InspectorPanel` "Now" tab updates when `currentMs` prop changes
- Lane config persists to localStorage and rehydrates on remount
- Click on lane marker pauses video + opens "Selected event" tab

E2E test (Playwright if the project uses it):

- Navigate to an episode trace page
- Click an activity event → playhead moves, video pauses, inspector shows event
- Toggle a lane off → it disappears; reload → still off
- Drag a refresh-gap into view → tooltip explains it

## Acceptance criteria

- [ ] All 15 lanes render with appropriate visualizations from the timeline payload
- [ ] Gaze data visible in inspector mini-map (or as overlay if screen recording exists)
- [ ] Clicking any event marker pauses the video, seeks to the event, and shows it in the inspector
- [ ] Playback at 1× with all lanes visible stays at 60fps on a mid-range laptop
- [ ] Lane order, visibility, and heights persist across reloads
- [ ] Resolution selector triggers refetch and updates lane density
- [ ] No console errors on full episode load with 1+ hour of data
- [ ] Linter, typecheck, all tests pass

## Notes / gotchas

- **Performance is the main risk in this stage.** A 1-hour episode at `medium` resolution has ~3,600 gaze points + 7,200 pupil points + thousands of activity events. Pre-bin client-side after the API response so each lane has a static, zoom-window-derived render set rather than re-filtering on every frame.
- For Canvas lanes, set `canvas.width = clientWidth * devicePixelRatio` and scale the context to avoid blurry rendering on retina displays.
- Don't block the main thread on initial render. If the timeline payload is large, parse and prepare lane data in `requestIdleCallback` or a Web Worker.
- The "screen recording vs webcam recording" question in §3 is real. **Read the actual codebase** to confirm what's recorded before implementing the overlay. If only webcam, simplify to a gaze mini-map.
- For event-style lane markers, group markers within 2px of each other into a single cluster marker labeled with the count — otherwise dense regions become unreadable.
- Tooltip components from the design system, not raw `title=` attributes.
