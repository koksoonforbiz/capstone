import { z } from 'zod';

/**
 * Research / Retrospective-Tracing timeline schemas (prompt_retro Stage 3).
 *
 * Shared between the NestJS controller (response shape contract) and the
 * React teacher-portal (parsed at the boundary, then rendered on lanes).
 *
 * The single contract here is `tMs` (episode-relative milliseconds).
 * The frontend should never have to convert wall-clock to relative time —
 * the server computes it on the way out.
 */

// ─── Episode list (picker) ──────────────────────────────────────────────────

export const EpisodeListItemSchema = z.object({
  id: z.string(),
  startedAt: z.string(), // ISO
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  totalActiveSecs: z.number(),
  sessionCount: z.number(),
  groupingMethod: z.string(),
  groupingConfidence: z.number().nullable(),
  hasVideo: z.boolean(),
  /** Researcher-supplied notes (Stage 6) — surfaced in the picker as a tooltip. */
  notes: z.string().nullable(),
  flags: z.object({
    atRiskCount: z.number(),
    refreshGapCount: z.number(),
  }),
});
export type EpisodeListItem = z.infer<typeof EpisodeListItemSchema>;

export const EpisodeListResponseSchema = z.object({
  total: z.number(),
  episodes: z.array(EpisodeListItemSchema),
});
export type EpisodeListResponse = z.infer<typeof EpisodeListResponseSchema>;

// ─── Episode summary (lightweight, for the picker tooltip / inspector) ──────

export const EpisodeLaneCountsSchema = z.record(z.string(), z.number());
export type EpisodeLaneCounts = z.infer<typeof EpisodeLaneCountsSchema>;

export const EpisodeSummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  courseId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  sessionCount: z.number(),
  groupingMethod: z.string(),
  groupingConfidence: z.number().nullable(),
  notes: z.string().nullable(),
  laneCounts: EpisodeLaneCountsSchema,
});
export type EpisodeSummary = z.infer<typeof EpisodeSummarySchema>;

// ─── Full timeline payload ──────────────────────────────────────────────────

export const ResolutionSchema = z.enum(['raw', 'high', 'medium', 'low']);
export type Resolution = z.infer<typeof ResolutionSchema>;

export const SessionBoundarySchema = z.object({
  sessionId: z.string(),
  sessionStartMs: z.number(),
  sessionEndMs: z.number().nullable(),
  refreshGapMsBefore: z.number().nullable(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
});
export type SessionBoundary = z.infer<typeof SessionBoundarySchema>;

export const VideoSegmentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  minioKey: z.string(),
  signedUrl: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  durationMs: z.number(),
  fileSizeBytes: z.number().nullable(),
});
export type VideoSegment = z.infer<typeof VideoSegmentSchema>;

// Lane row schemas — one per modality. Kept narrow on purpose; consumers
// pick what they render.

export const ActivityRowSchema = z.object({
  tMs: z.number(),
  sessionId: z.string(),
  action: z.string(),
  metadata: z.unknown().nullable(),
});

export const GazeRowSchema = z.object({
  tMs: z.number(),
  x: z.number(),
  y: z.number(),
  conf: z.number().nullable(),
});

export const PupilRowSchema = z.object({
  tMs: z.number(),
  diameter: z.number(),
});

export const EmotionRowSchema = z.object({
  tMs: z.number(),
  dominant: z.string().nullable(),
  scores: z.record(z.string(), z.number().nullable()),
});

export const AuRowSchema = z.object({
  tMs: z.number(),
  aus: z.record(z.string(), z.number().nullable()),
});

export const AffectiveWindowSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  engagement: z.number(),
  boredom: z.number(),
  confusion: z.number(),
  frustration: z.number(),
  dominantState: z.string(),
});

export const DerivedWindowSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  score: z.number(),
});

export const AtRiskRowSchema = z.object({
  tMs: z.number(),
  riskLevel: z.string(),
  reasons: z.unknown(),
});

export const EfDetectionRowSchema = z.object({
  tMs: z.number(),
  messageId: z.string(),
  constructKey: z.string(),
  label: z.string(),
  confidence: z.number().nullable(),
  severity: z.number().nullable(),
  rationale: z.string().nullable(),
});

export const ClickRowSchema = z.object({
  tMs: z.number(),
  x: z.number(),
  y: z.number(),
  pageUrl: z.string(),
  elementSelector: z.string().nullable(),
});

export const ScrollRowSchema = z.object({
  tMs: z.number(),
  scrollY: z.number(),
  scrollPercent: z.number(),
  pageUrl: z.string(),
});

export const CursorRowSchema = z.object({
  tMs: z.number(),
  x: z.number(),
  y: z.number(),
  pageUrl: z.string(),
});

export const VisibilityRowSchema = z.object({
  tMs: z.number(),
  visibleState: z.string(),
  hiddenDurationMs: z.number().nullable(),
});

export const ErrorRowSchema = z.object({
  tMs: z.number(),
  errorMessage: z.string(),
  pageUrl: z.string().nullable(),
  errorType: z.string().nullable(),
});

/**
 * One marker per chat message (USER or ASSISTANT) sent during the
 * episode's time window. Lets researchers correlate dialogue rhythm
 * with biometric and EF-detection lanes on the same x-axis.
 */
export const DialogueRowSchema = z.object({
  tMs: z.number(),
  messageId: z.string(),
  role: z.string(), // 'USER' | 'ASSISTANT'
  contentSnippet: z.string(),
  dialogueSessionId: z.string(),
});

export const TimelineLanesSchema = z.object({
  activity: z.array(ActivityRowSchema).optional(),
  gaze: z.array(GazeRowSchema).optional(),
  pupil: z.array(PupilRowSchema).optional(),
  emotion: z.array(EmotionRowSchema).optional(),
  au: z.array(AuRowSchema).optional(),
  affective: z.array(AffectiveWindowSchema).optional(),
  derived: z
    .object({
      engagement: z.array(DerivedWindowSchema),
      cognitiveLoad: z.array(DerivedWindowSchema),
    })
    .optional(),
  atRisk: z.array(AtRiskRowSchema).optional(),
  efDetection: z.array(EfDetectionRowSchema).optional(),
  click: z.array(ClickRowSchema).optional(),
  scroll: z.array(ScrollRowSchema).optional(),
  cursor: z.array(CursorRowSchema).optional(),
  visibility: z.array(VisibilityRowSchema).optional(),
  error: z.array(ErrorRowSchema).optional(),
  dialogue: z.array(DialogueRowSchema).optional(),
});
export type TimelineLanes = z.infer<typeof TimelineLanesSchema>;

export const TimelinePayloadSchema = z.object({
  episode: z.object({
    id: z.string(),
    userId: z.string(),
    courseId: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    sessionCount: z.number(),
    groupingMethod: z.string(),
    groupingConfidence: z.number().nullable(),
    /** Researcher-supplied notes (Stage 6). */
    notes: z.string().nullable(),
  }),
  sessionBoundaries: z.array(SessionBoundarySchema),
  video: z.object({
    segments: z.array(VideoSegmentSchema),
    totalDurationMs: z.number(),
  }),
  lanes: TimelineLanesSchema,
  meta: z.object({
    resolution: ResolutionSchema,
    requestedRangeMs: z.object({ from: z.number(), to: z.number() }),
    downsampledLanes: z.array(z.string()),
    truncatedLanes: z.array(z.object({ lane: z.string(), capHit: z.number() })),
  }),
});
export type TimelinePayload = z.infer<typeof TimelinePayloadSchema>;

/** Allowed values for the `modalities` query-param. */
export const TIMELINE_MODALITIES = [
  'activity',
  'video',
  'gaze',
  'pupil',
  'emotion',
  'au',
  'derived',
  'ef_detection',
  'click',
  'scroll',
  'cursor',
  'visibility',
  'error',
  'affective_state',
  'at_risk',
  'dialogue',
] as const;
export type TimelineModality = (typeof TIMELINE_MODALITIES)[number];
