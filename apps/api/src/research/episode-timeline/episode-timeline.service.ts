import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  EpisodeListItem,
  EpisodeListResponse,
  EpisodeSummary,
  Resolution,
  TimelineLanes,
  TimelineModality,
  TimelinePayload,
  VideoSegment,
} from '@ats/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../../blob/blob.service';

/**
 * Stage 3 of prompt_retro/. Read-side aggregation for the teacher portal:
 * given a LearningEpisode, return everything needed to render the
 * synchronized multi-modal timeline.
 *
 * Performance notes:
 * - Lane queries run in parallel via Promise.all.
 * - High-volume lanes (gaze, pupil, cursor, AU) downsample on the SQL side
 *   using width_bucket / time-bucket arithmetic.
 * - Event lanes (activity, click, error, ef_detection, dialogue, atRisk,
 *   visibility) are inherently sparse — capped at 10k rows per lane and
 *   reported in `meta.truncatedLanes` if hit.
 * - Video URLs are presigned by the blob service for 1h.
 */

const RAW_CAP = 50_000;
const EVENT_CAP = 10_000;

const RESOLUTION_BUCKETS_MS: Record<Resolution, number | null> = {
  raw: null,
  high: 200,
  medium: 1_000,
  low: 5_000,
};

interface ListOpts {
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

interface TimelineOpts {
  fromMs?: number;
  toMs?: number;
  resolution: Resolution;
  modalities?: TimelineModality[];
}

@Injectable()
export class EpisodeTimelineService {
  private readonly logger = new Logger(EpisodeTimelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
  ) {}

  // ─── List episodes for the picker ─────────────────────────────────────────

  async listEpisodes(
    teacherId: string,
    teacherRole: string,
    courseId: string,
    studentId: string,
    opts: ListOpts = {},
  ): Promise<EpisodeListResponse> {
    await this.assertCourseOwnedByTeacher(teacherId, teacherRole, courseId);

    const where: Prisma.LearningEpisodeWhereInput = {
      userId: studentId,
      courseId,
      ...(opts.from || opts.to
        ? {
            startedAt: {
              ...(opts.from ? { gte: opts.from } : {}),
              ...(opts.to ? { lte: opts.to } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.learningEpisode.count({ where }),
      this.prisma.learningEpisode.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: opts.limit ?? 50,
        skip: opts.offset ?? 0,
        include: {
          sessions: {
            select: { id: true, startedAt: true },
            orderBy: { startedAt: 'asc' },
          },
        },
      }),
    ]);

    if (rows.length === 0) {
      return { total, episodes: [] };
    }

    const episodeIds = rows.map((e) => e.id);
    const sessionIdsByEpisode = new Map<string, string[]>();
    for (const e of rows)
      sessionIdsByEpisode.set(
        e.id,
        e.sessions.map((s) => s.id),
      );
    const allSessionIds = rows.flatMap((e) => e.sessions.map((s) => s.id));

    // Aggregate counts in two queries — faster than per-episode subqueries.
    const [recordingPerSession, atRiskPerEpisode] = await Promise.all([
      allSessionIds.length > 0
        ? this.prisma.recordingSegment.groupBy({
            by: ['sessionId'],
            where: { sessionId: { in: allSessionIds } },
            _count: true,
          })
        : Promise.resolve([]),
      this.countAtRiskByEpisode(episodeIds),
    ]);

    const recordedSessions = new Set(recordingPerSession.map((r) => r.sessionId));

    const items: EpisodeListItem[] = rows.map((e) => {
      const sessionIds = sessionIdsByEpisode.get(e.id) ?? [];
      const hasVideo = sessionIds.some((sid) => recordedSessions.has(sid));
      return {
        id: e.id,
        startedAt: e.startedAt.toISOString(),
        endedAt: e.endedAt ? e.endedAt.toISOString() : null,
        durationMs: e.endedAt ? e.endedAt.getTime() - e.startedAt.getTime() : null,
        totalActiveSecs: e.totalActiveSecs,
        sessionCount: e.sessionCount,
        groupingMethod: e.groupingMethod,
        groupingConfidence: e.groupingConfidence,
        hasVideo,
        flags: {
          atRiskCount: atRiskPerEpisode.get(e.id) ?? 0,
          refreshGapCount: Math.max(0, e.sessionCount - 1),
        },
      };
    });

    return { total, episodes: items };
  }

  // ─── Episode summary (lightweight) ────────────────────────────────────────

  async getSummary(
    teacherId: string,
    teacherRole: string,
    episodeId: string,
  ): Promise<EpisodeSummary> {
    const episode = await this.loadEpisode(episodeId);
    await this.assertCourseOwnedByTeacher(teacherId, teacherRole, episode.courseId);

    const sessionIds = episode.sessions.map((s) => s.id);
    const laneCounts = await this.countPerLane(sessionIds, episodeId);

    return {
      id: episode.id,
      userId: episode.userId,
      courseId: episode.courseId,
      startedAt: episode.startedAt.toISOString(),
      endedAt: episode.endedAt ? episode.endedAt.toISOString() : null,
      durationMs: episode.endedAt ? episode.endedAt.getTime() - episode.startedAt.getTime() : null,
      sessionCount: episode.sessionCount,
      groupingMethod: episode.groupingMethod,
      groupingConfidence: episode.groupingConfidence,
      notes: episode.notes,
      laneCounts,
    };
  }

  // ─── Full timeline payload ────────────────────────────────────────────────

  async getTimeline(
    teacherId: string,
    teacherRole: string,
    episodeId: string,
    opts: TimelineOpts,
  ): Promise<TimelinePayload> {
    const start = Date.now();
    const episode = await this.loadEpisode(episodeId);
    await this.assertCourseOwnedByTeacher(teacherId, teacherRole, episode.courseId);

    const t0 = episode.startedAt.getTime();
    const fromMs = opts.fromMs ?? 0;
    const toMs = opts.toMs ?? (episode.endedAt ? episode.endedAt.getTime() - t0 : Date.now() - t0);

    const fromWall = new Date(t0 + fromMs);
    const toWall = new Date(t0 + toMs);

    const sessionIds = episode.sessions.map((s) => s.id);
    const wantsAll = !opts.modalities || opts.modalities.length === 0;
    const wants = (m: TimelineModality) => wantsAll || opts.modalities!.includes(m);

    const downsampledLanes: string[] = [];
    const truncatedLanes: Array<{ lane: string; capHit: number }> = [];
    const lanes: TimelineLanes = {};

    // Run the lane queries we want, in parallel.
    const tasks: Array<Promise<void>> = [];

    if (wants('activity')) {
      tasks.push(
        this.queryActivity(sessionIds, fromWall, toWall, t0).then((rows) => {
          if (rows.length === EVENT_CAP)
            truncatedLanes.push({ lane: 'activity', capHit: EVENT_CAP });
          lanes.activity = rows;
        }),
      );
    }
    if (wants('gaze')) {
      tasks.push(
        this.queryGaze(sessionIds, fromWall, toWall, t0, opts.resolution).then((rows) => {
          if (opts.resolution !== 'raw') downsampledLanes.push('gaze');
          if (rows.length === RAW_CAP) truncatedLanes.push({ lane: 'gaze', capHit: RAW_CAP });
          lanes.gaze = rows;
        }),
      );
    }
    if (wants('pupil')) {
      tasks.push(
        this.queryPupil(sessionIds, fromWall, toWall, t0, opts.resolution).then((rows) => {
          if (opts.resolution !== 'raw') downsampledLanes.push('pupil');
          if (rows.length === RAW_CAP) truncatedLanes.push({ lane: 'pupil', capHit: RAW_CAP });
          lanes.pupil = rows;
        }),
      );
    }
    if (wants('cursor')) {
      tasks.push(
        this.queryCursor(sessionIds, fromMs + t0, toMs + t0, t0, opts.resolution).then((rows) => {
          if (opts.resolution !== 'raw') downsampledLanes.push('cursor');
          if (rows.length === RAW_CAP) truncatedLanes.push({ lane: 'cursor', capHit: RAW_CAP });
          lanes.cursor = rows;
        }),
      );
    }
    if (wants('click')) {
      tasks.push(
        this.queryClick(sessionIds, fromMs + t0, toMs + t0, t0).then((rows) => {
          if (rows.length === EVENT_CAP) truncatedLanes.push({ lane: 'click', capHit: EVENT_CAP });
          lanes.click = rows;
        }),
      );
    }
    if (wants('scroll')) {
      tasks.push(
        this.queryScroll(sessionIds, fromMs + t0, toMs + t0, t0).then((rows) => {
          if (rows.length === EVENT_CAP) truncatedLanes.push({ lane: 'scroll', capHit: EVENT_CAP });
          lanes.scroll = rows;
        }),
      );
    }
    if (wants('visibility')) {
      tasks.push(
        this.queryVisibility(sessionIds, fromMs + t0, toMs + t0, t0).then((rows) => {
          if (rows.length === EVENT_CAP)
            truncatedLanes.push({ lane: 'visibility', capHit: EVENT_CAP });
          lanes.visibility = rows;
        }),
      );
    }
    if (wants('error')) {
      tasks.push(
        this.queryError(sessionIds, fromMs + t0, toMs + t0, t0).then((rows) => {
          if (rows.length === EVENT_CAP) truncatedLanes.push({ lane: 'error', capHit: EVENT_CAP });
          lanes.error = rows;
        }),
      );
    }
    if (wants('emotion')) {
      tasks.push(
        this.queryEmotion(sessionIds, fromMs + t0, toMs + t0, t0).then((rows) => {
          if (rows.length === RAW_CAP) truncatedLanes.push({ lane: 'emotion', capHit: RAW_CAP });
          lanes.emotion = rows;
        }),
      );
    }
    if (wants('affective_state')) {
      tasks.push(
        this.queryAffective(sessionIds, fromMs + t0, toMs + t0, t0).then((rows) => {
          lanes.affective = rows;
        }),
      );
    }
    if (wants('ef_detection')) {
      tasks.push(
        this.queryEfDetection(sessionIds, fromWall, toWall, t0).then((rows) => {
          if (rows.length === EVENT_CAP)
            truncatedLanes.push({ lane: 'ef_detection', capHit: EVENT_CAP });
          lanes.efDetection = rows;
        }),
      );
    }
    if (wants('derived')) {
      tasks.push(
        this.queryDerived(sessionIds, fromMs + t0, toMs + t0, t0).then((d) => {
          lanes.derived = d;
        }),
      );
    }
    if (wants('at_risk')) {
      tasks.push(
        this.queryAtRisk(sessionIds, fromWall, toWall, t0).then((rows) => {
          if (rows.length === EVENT_CAP) truncatedLanes.push({ lane: 'atRisk', capHit: EVENT_CAP });
          lanes.atRisk = rows;
        }),
      );
    }

    // Sessions metadata (always needed for refresh markers)
    const sessionBoundaries = (() => {
      const sorted = [...episode.sessions].sort(
        (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
      );
      const out = sorted.map((s, i) => {
        const prev = sorted[i - 1];
        const refreshGapMsBefore =
          prev?.endedAt != null ? s.startedAt.getTime() - prev.endedAt.getTime() : null;
        return {
          sessionId: s.id,
          sessionStartMs: s.startedAt.getTime() - t0,
          sessionEndMs: s.endedAt ? s.endedAt.getTime() - t0 : null,
          refreshGapMsBefore,
          userAgent: s.userAgent,
          ipAddress: s.ipAddress,
        };
      });
      return out;
    })();

    // Video segments (always pulled — even if filtered out, we still report
    // segment count). Sign URLs in parallel.
    const videoSegments: VideoSegment[] = wants('video')
      ? await this.queryVideo(sessionIds, fromMs + t0, toMs + t0, t0)
      : [];
    const totalVideoMs = videoSegments.reduce((acc, v) => acc + v.durationMs, 0);

    await Promise.all(tasks);

    const elapsed = Date.now() - start;
    this.logger.debug(
      `episode-timeline ${episodeId} resolution=${opts.resolution} ` +
        `range=[${fromMs},${toMs}] elapsed=${elapsed}ms`,
    );

    return {
      episode: {
        id: episode.id,
        userId: episode.userId,
        courseId: episode.courseId,
        startedAt: episode.startedAt.toISOString(),
        endedAt: episode.endedAt ? episode.endedAt.toISOString() : null,
        durationMs: episode.endedAt
          ? episode.endedAt.getTime() - episode.startedAt.getTime()
          : null,
        sessionCount: episode.sessionCount,
        groupingMethod: episode.groupingMethod,
        groupingConfidence: episode.groupingConfidence,
      },
      sessionBoundaries,
      video: { segments: videoSegments, totalDurationMs: totalVideoMs },
      lanes,
      meta: {
        resolution: opts.resolution,
        requestedRangeMs: { from: fromMs, to: toMs },
        downsampledLanes,
        truncatedLanes,
      },
    };
  }

  // ─── Internal: episode loader + auth ─────────────────────────────────────

  private async loadEpisode(episodeId: string) {
    const episode = await this.prisma.learningEpisode.findUnique({
      where: { id: episodeId },
      include: {
        sessions: {
          select: {
            id: true,
            startedAt: true,
            endedAt: true,
            userAgent: true,
            ipAddress: true,
          },
        },
      },
    });
    if (!episode) throw new NotFoundException(`Episode ${episodeId} not found`);
    return episode;
  }

  private async assertCourseOwnedByTeacher(
    teacherId: string,
    role: string,
    courseId: string,
  ): Promise<void> {
    if (role === 'admin') return;
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { teacherId: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.teacherId !== teacherId) {
      throw new ForbiddenException('Course belongs to another teacher');
    }
  }

  // ─── Internal: lane counts (for the summary endpoint) ─────────────────────

  private async countPerLane(
    sessionIds: string[],
    episodeId: string,
  ): Promise<Record<string, number>> {
    if (sessionIds.length === 0) return {};
    const [
      activity,
      gaze,
      pupil,
      emotion,
      affective,
      efDetection,
      click,
      scroll,
      cursor,
      visibility,
      errors,
      atRisk,
    ] = await Promise.all([
      this.prisma.activityLog.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.webgazerLog.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.pupilSizeLog.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.emotionFrame.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.affectiveStateWindow.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.efDetection.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.click_logs.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.scroll_logs.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.cursor_logs.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.visibility_logs.count({ where: { sessionId: { in: sessionIds } } }),
      this.prisma.error_logs.count({ where: { sessionId: { in: sessionIds } } }),
      this.countAtRiskByEpisode([episodeId]).then((m) => m.get(episodeId) ?? 0),
    ]);
    return {
      activity,
      gaze,
      pupil,
      emotion,
      affective,
      efDetection,
      click,
      scroll,
      cursor,
      visibility,
      error: errors,
      atRisk,
    };
  }

  private async countAtRiskByEpisode(episodeIds: string[]) {
    const map = new Map<string, number>();
    if (episodeIds.length === 0) return map;
    const sessionsToEpisode = await this.prisma.studentSession.findMany({
      where: { episodeId: { in: episodeIds } },
      select: { id: true, episodeId: true },
    });
    if (sessionsToEpisode.length === 0) return map;
    const sessionIds = sessionsToEpisode.map((s) => s.id);
    const flags = await this.prisma.derived_at_risk_flags.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true },
    });
    const epBySession = new Map(sessionsToEpisode.map((s) => [s.id, s.episodeId!]));
    for (const f of flags) {
      const eid = epBySession.get(f.sessionId);
      if (!eid) continue;
      map.set(eid, (map.get(eid) ?? 0) + 1);
    }
    return map;
  }

  // ─── Lane queries ─────────────────────────────────────────────────────────

  private async queryActivity(sessionIds: string[], fromWall: Date, toWall: Date, t0: number) {
    if (sessionIds.length === 0) return [];
    const rows = await this.prisma.activityLog.findMany({
      where: { sessionId: { in: sessionIds }, occurredAt: { gte: fromWall, lte: toWall } },
      orderBy: { occurredAt: 'asc' },
      take: EVENT_CAP,
      select: { sessionId: true, action: true, occurredAt: true, metadata: true },
    });
    return rows.map((r) => ({
      tMs: r.occurredAt.getTime() - t0,
      sessionId: r.sessionId,
      action: r.action,
      metadata: r.metadata,
    }));
  }

  private async queryGaze(
    sessionIds: string[],
    fromWall: Date,
    toWall: Date,
    t0: number,
    res: Resolution,
  ) {
    if (sessionIds.length === 0) return [];
    const bucket = RESOLUTION_BUCKETS_MS[res];
    if (!bucket) {
      const rows = await this.prisma.webgazerLog.findMany({
        where: {
          sessionId: { in: sessionIds },
          timestamp: { gte: fromWall, lte: toWall },
        },
        orderBy: { timestamp: 'asc' },
        take: RAW_CAP,
        select: { timestamp: true, gazeX: true, gazeY: true, confidence: true },
      });
      return rows.map((r) => ({
        tMs: r.timestamp.getTime() - t0,
        x: r.gazeX,
        y: r.gazeY,
        conf: r.confidence,
      }));
    }
    // Bucketed mean — uses the (sessionId, timestamp) index added in this stage.
    const rows = await this.prisma.$queryRaw<
      Array<{ bucket_ms: bigint; mean_x: number; mean_y: number; mean_conf: number | null }>
    >(Prisma.sql`
      SELECT
        (FLOOR(EXTRACT(EPOCH FROM timestamp) * 1000 / ${bucket}) * ${bucket})::bigint AS bucket_ms,
        AVG(gaze_x)::float8 AS mean_x,
        AVG(gaze_y)::float8 AS mean_y,
        AVG(confidence)::float8 AS mean_conf
      FROM webgazer_logs
      WHERE session_id = ANY(${sessionIds}::uuid[])
        AND timestamp >= ${fromWall}
        AND timestamp <= ${toWall}
      GROUP BY bucket_ms
      ORDER BY bucket_ms ASC
      LIMIT ${RAW_CAP}
    `);
    return rows.map((r) => ({
      tMs: Number(r.bucket_ms) - t0,
      x: r.mean_x,
      y: r.mean_y,
      conf: r.mean_conf,
    }));
  }

  private async queryPupil(
    sessionIds: string[],
    fromWall: Date,
    toWall: Date,
    t0: number,
    res: Resolution,
  ) {
    if (sessionIds.length === 0) return [];
    const bucket = RESOLUTION_BUCKETS_MS[res];
    if (!bucket) {
      const rows = await this.prisma.pupilSizeLog.findMany({
        where: {
          sessionId: { in: sessionIds },
          timestamp: { gte: fromWall, lte: toWall },
        },
        orderBy: { timestamp: 'asc' },
        take: RAW_CAP,
        select: { timestamp: true, pupilDiameter: true },
      });
      return rows.map((r) => ({
        tMs: r.timestamp.getTime() - t0,
        diameter: r.pupilDiameter,
      }));
    }
    const rows = await this.prisma.$queryRaw<
      Array<{ bucket_ms: bigint; mean_d: number }>
    >(Prisma.sql`
      SELECT
        (FLOOR(EXTRACT(EPOCH FROM timestamp) * 1000 / ${bucket}) * ${bucket})::bigint AS bucket_ms,
        AVG(pupil_diameter)::float8 AS mean_d
      FROM pupil_size_logs
      WHERE session_id = ANY(${sessionIds}::uuid[])
        AND timestamp >= ${fromWall}
        AND timestamp <= ${toWall}
      GROUP BY bucket_ms
      ORDER BY bucket_ms ASC
      LIMIT ${RAW_CAP}
    `);
    return rows.map((r) => ({
      tMs: Number(r.bucket_ms) - t0,
      diameter: r.mean_d,
    }));
  }

  private async queryCursor(
    sessionIds: string[],
    fromWallMs: number,
    toWallMs: number,
    t0: number,
    res: Resolution,
  ) {
    if (sessionIds.length === 0) return [];
    const bucket = RESOLUTION_BUCKETS_MS[res];
    if (!bucket) {
      const rows = await this.prisma.cursor_logs.findMany({
        where: {
          sessionId: { in: sessionIds },
          timestamp: { gte: BigInt(fromWallMs), lte: BigInt(toWallMs) },
        },
        orderBy: { timestamp: 'asc' },
        take: RAW_CAP,
        select: { timestamp: true, x: true, y: true, pageUrl: true },
      });
      return rows.map((r) => ({
        tMs: Number(r.timestamp) - t0,
        x: r.x,
        y: r.y,
        pageUrl: r.pageUrl,
      }));
    }
    // cursor_logs.sessionId is `text` (added in the schema-drift recovery
    // migration), not uuid — don't cast or the raw query bombs with
    // `operator does not exist: text = uuid`.
    const rows = await this.prisma.$queryRaw<
      Array<{ bucket_ms: bigint; mean_x: number; mean_y: number; page_url: string }>
    >(Prisma.sql`
      SELECT
        (FLOOR("timestamp" / ${bucket}) * ${bucket})::bigint AS bucket_ms,
        AVG(x)::float8 AS mean_x,
        AVG(y)::float8 AS mean_y,
        MODE() WITHIN GROUP (ORDER BY "pageUrl") AS page_url
      FROM cursor_logs
      WHERE "sessionId" = ANY(${sessionIds}::text[])
        AND "timestamp" >= ${fromWallMs}
        AND "timestamp" <= ${toWallMs}
      GROUP BY bucket_ms
      ORDER BY bucket_ms ASC
      LIMIT ${RAW_CAP}
    `);
    return rows.map((r) => ({
      tMs: Number(r.bucket_ms) - t0,
      x: r.mean_x,
      y: r.mean_y,
      pageUrl: r.page_url,
    }));
  }

  private async queryClick(sessionIds: string[], fromWallMs: number, toWallMs: number, t0: number) {
    if (sessionIds.length === 0) return [];
    const rows = await this.prisma.click_logs.findMany({
      where: {
        sessionId: { in: sessionIds },
        timestamp: { gte: BigInt(fromWallMs), lte: BigInt(toWallMs) },
      },
      orderBy: { timestamp: 'asc' },
      take: EVENT_CAP,
      select: { timestamp: true, x: true, y: true, pageUrl: true, elementSelector: true },
    });
    return rows.map((r) => ({
      tMs: Number(r.timestamp) - t0,
      x: r.x,
      y: r.y,
      pageUrl: r.pageUrl,
      elementSelector: r.elementSelector ?? null,
    }));
  }

  private async queryScroll(
    sessionIds: string[],
    fromWallMs: number,
    toWallMs: number,
    t0: number,
  ) {
    if (sessionIds.length === 0) return [];
    const rows = await this.prisma.scroll_logs.findMany({
      where: {
        sessionId: { in: sessionIds },
        timestamp: { gte: BigInt(fromWallMs), lte: BigInt(toWallMs) },
      },
      orderBy: { timestamp: 'asc' },
      take: EVENT_CAP,
      select: { timestamp: true, scrollY: true, scrollPercent: true, pageUrl: true },
    });
    return rows.map((r) => ({
      tMs: Number(r.timestamp) - t0,
      scrollY: r.scrollY,
      scrollPercent: r.scrollPercent,
      pageUrl: r.pageUrl,
    }));
  }

  private async queryVisibility(
    sessionIds: string[],
    fromWallMs: number,
    toWallMs: number,
    t0: number,
  ) {
    if (sessionIds.length === 0) return [];
    const rows = await this.prisma.visibility_logs.findMany({
      where: {
        sessionId: { in: sessionIds },
        timestamp: { gte: BigInt(fromWallMs), lte: BigInt(toWallMs) },
      },
      orderBy: { timestamp: 'asc' },
      take: EVENT_CAP,
      select: { timestamp: true, visibleState: true, hiddenDurationMs: true },
    });
    return rows.map((r) => ({
      tMs: Number(r.timestamp) - t0,
      visibleState: r.visibleState,
      hiddenDurationMs: r.hiddenDurationMs ?? null,
    }));
  }

  private async queryError(sessionIds: string[], fromWallMs: number, toWallMs: number, t0: number) {
    if (sessionIds.length === 0) return [];
    const rows = await this.prisma.error_logs.findMany({
      where: {
        sessionId: { in: sessionIds },
        timestamp: { gte: BigInt(fromWallMs), lte: BigInt(toWallMs) },
      },
      orderBy: { timestamp: 'asc' },
      take: EVENT_CAP,
      select: { timestamp: true, errorMessage: true, pageUrl: true, errorType: true },
    });
    return rows.map((r) => ({
      tMs: Number(r.timestamp) - t0,
      errorMessage: r.errorMessage,
      pageUrl: r.pageUrl ?? null,
      errorType: r.errorType ?? null,
    }));
  }

  private async queryEmotion(
    sessionIds: string[],
    fromWallMs: number,
    toWallMs: number,
    t0: number,
  ) {
    if (sessionIds.length === 0) return [];
    const rows = await this.prisma.emotionFrame.findMany({
      where: {
        sessionId: { in: sessionIds },
        frameWallMs: { gte: BigInt(fromWallMs), lte: BigInt(toWallMs) },
        faceDetected: true,
      },
      orderBy: { frameWallMs: 'asc' },
      take: RAW_CAP,
      select: {
        frameWallMs: true,
        dominantEmotion: true,
        pHappiness: true,
        pSadness: true,
        pSurprise: true,
        pFear: true,
        pAnger: true,
        pDisgust: true,
        pContempt: true,
        pNeutral: true,
      },
    });
    return rows.map((r) => ({
      tMs: Number(r.frameWallMs) - t0,
      dominant: r.dominantEmotion,
      scores: {
        happiness: r.pHappiness,
        sadness: r.pSadness,
        surprise: r.pSurprise,
        fear: r.pFear,
        anger: r.pAnger,
        disgust: r.pDisgust,
        contempt: r.pContempt,
        neutral: r.pNeutral,
      },
    }));
  }

  private async queryAffective(
    sessionIds: string[],
    fromWallMs: number,
    toWallMs: number,
    t0: number,
  ) {
    if (sessionIds.length === 0) return [];
    const rows = await this.prisma.affectiveStateWindow.findMany({
      where: {
        sessionId: { in: sessionIds },
        windowStartWallMs: { gte: BigInt(fromWallMs), lte: BigInt(toWallMs) },
      },
      orderBy: { windowStartWallMs: 'asc' },
      take: RAW_CAP,
      select: {
        windowStartWallMs: true,
        windowEndWallMs: true,
        engagement: true,
        boredom: true,
        confusion: true,
        frustration: true,
        dominantState: true,
      },
    });
    return rows.map((r) => ({
      startMs: Number(r.windowStartWallMs) - t0,
      endMs: Number(r.windowEndWallMs) - t0,
      engagement: r.engagement,
      boredom: r.boredom,
      confusion: r.confusion,
      frustration: r.frustration,
      dominantState: r.dominantState,
    }));
  }

  private async queryEfDetection(sessionIds: string[], fromWall: Date, toWall: Date, t0: number) {
    if (sessionIds.length === 0) return [];
    const rows = await this.prisma.efDetection.findMany({
      where: {
        sessionId: { in: sessionIds },
        createdAt: { gte: fromWall, lte: toWall },
        label: { not: 'pending' },
      },
      orderBy: { createdAt: 'asc' },
      take: EVENT_CAP,
      select: {
        createdAt: true,
        messageId: true,
        constructKey: true,
        label: true,
        confidence: true,
        severity: true,
        rationale: true,
      },
    });
    return rows.map((r) => ({
      tMs: r.createdAt.getTime() - t0,
      messageId: r.messageId,
      constructKey: r.constructKey,
      label: r.label,
      confidence: r.confidence,
      severity: r.severity,
      rationale: r.rationale,
    }));
  }

  private async queryDerived(
    sessionIds: string[],
    fromWallMs: number,
    toWallMs: number,
    t0: number,
  ) {
    if (sessionIds.length === 0) return { engagement: [], cognitiveLoad: [] };
    const [engagement, cognitiveLoad] = await Promise.all([
      this.prisma.derived_engagement.findMany({
        where: {
          sessionId: { in: sessionIds },
          windowStartMs: { gte: BigInt(fromWallMs), lte: BigInt(toWallMs) },
        },
        orderBy: { windowStartMs: 'asc' },
        take: RAW_CAP,
        select: { windowStartMs: true, windowEndMs: true, engagementScore: true },
      }),
      this.prisma.derived_cognitive_load.findMany({
        where: {
          sessionId: { in: sessionIds },
          windowStartMs: { gte: BigInt(fromWallMs), lte: BigInt(toWallMs) },
        },
        orderBy: { windowStartMs: 'asc' },
        take: RAW_CAP,
        select: { windowStartMs: true, windowEndMs: true, cognitiveLoadIndex: true },
      }),
    ]);
    return {
      engagement: engagement.map((r) => ({
        startMs: Number(r.windowStartMs) - t0,
        endMs: Number(r.windowEndMs) - t0,
        score: r.engagementScore,
      })),
      cognitiveLoad: cognitiveLoad.map((r) => ({
        startMs: Number(r.windowStartMs) - t0,
        endMs: Number(r.windowEndMs) - t0,
        score: r.cognitiveLoadIndex,
      })),
    };
  }

  private async queryAtRisk(sessionIds: string[], fromWall: Date, toWall: Date, t0: number) {
    if (sessionIds.length === 0) return [];
    // derived_at_risk_flags.flaggedAt is bigint epoch-ms, not a timestamp.
    const fromMs = BigInt(fromWall.getTime());
    const toMs = BigInt(toWall.getTime());
    const rows = await this.prisma.derived_at_risk_flags.findMany({
      where: {
        sessionId: { in: sessionIds },
        flaggedAt: { gte: fromMs, lte: toMs },
      },
      orderBy: { flaggedAt: 'asc' },
      take: EVENT_CAP,
      select: { flaggedAt: true, riskLevel: true, reasons: true },
    });
    return rows.map((r) => ({
      tMs: Number(r.flaggedAt) - t0,
      riskLevel: r.riskLevel,
      reasons: r.reasons,
    }));
  }

  private async queryVideo(
    sessionIds: string[],
    fromWallMs: number,
    toWallMs: number,
    t0: number,
  ): Promise<VideoSegment[]> {
    if (sessionIds.length === 0) return [];
    const segments = await this.prisma.recordingSegment.findMany({
      where: {
        sessionId: { in: sessionIds },
        startWallTime: { gte: new Date(fromWallMs), lte: new Date(toWallMs) },
        uploadStatus: 'COMPLETED',
      },
      orderBy: { startWallTime: 'asc' },
      select: {
        id: true,
        sessionId: true,
        minioKey: true,
        startWallTime: true,
        endWallTime: true,
        durationMs: true,
        fileSizeBytes: true,
      },
    });

    // Sign URLs in parallel.
    const signed = await Promise.all(
      segments.map(async (s) => ({
        id: s.id,
        sessionId: s.sessionId,
        minioKey: s.minioKey,
        signedUrl: await this.blob.getPresignedDownloadUrl({
          key: s.minioKey,
          expiresIn: 3600,
        }),
        startMs: s.startWallTime.getTime() - t0,
        endMs: s.endWallTime
          ? s.endWallTime.getTime() - t0
          : s.startWallTime.getTime() - t0 + (s.durationMs ?? 0),
        durationMs:
          s.durationMs ?? (s.endWallTime ? s.endWallTime.getTime() - s.startWallTime.getTime() : 0),
        fileSizeBytes: s.fileSizeBytes,
      })),
    );
    return signed;
  }
}
