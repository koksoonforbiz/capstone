import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MappingEngineService } from './mapping-engine.service';
import { DEFAULT_MAPPING } from '@ats/shared';
import type { MappingRuleSet } from '@ats/shared';

@Injectable()
export class AffectiveMappingService {
  private readonly logger = new Logger(AffectiveMappingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: MappingEngineService,
  ) {}

  async getConfig(courseId: string) {
    let config = await this.prisma.affectiveMappingConfig.findUnique({
      where: { courseId },
    });
    if (!config) {
      config = await this.prisma.affectiveMappingConfig.create({
        data: {
          courseId,
          rules: DEFAULT_MAPPING as any,
        },
      });
    }
    return config;
  }

  async updateConfig(
    courseId: string,
    data: {
      windowSeconds?: number;
      strideSeconds?: number;
      minFramesPerWindow?: number;
      rules?: MappingRuleSet;
    },
    updatedById: string,
  ) {
    const existing = await this.getConfig(courseId);

    await this.prisma.affectiveMappingConfigHistory.create({
      data: {
        configId: existing.id,
        version: existing.version,
        windowSeconds: existing.windowSeconds,
        strideSeconds: existing.strideSeconds,
        minFramesPerWindow: existing.minFramesPerWindow,
        rules: existing.rules as any,
        changedById: updatedById,
      },
    });

    return this.prisma.affectiveMappingConfig.update({
      where: { courseId },
      data: {
        windowSeconds: data.windowSeconds ?? existing.windowSeconds,
        strideSeconds: data.strideSeconds ?? existing.strideSeconds,
        minFramesPerWindow: data.minFramesPerWindow ?? existing.minFramesPerWindow,
        rules: data.rules ? (data.rules as any) : (existing.rules as any),
        version: existing.version + 1,
        updatedById,
      },
    });
  }

  async resetToDefaults(courseId: string, updatedById: string) {
    return this.updateConfig(
      courseId,
      {
        windowSeconds: 30,
        strideSeconds: 10,
        minFramesPerWindow: 5,
        rules: DEFAULT_MAPPING,
      },
      updatedById,
    );
  }

  async getConfigHistory(courseId: string) {
    const config = await this.getConfig(courseId);
    return this.prisma.affectiveMappingConfigHistory.findMany({
      where: { configId: config.id },
      orderBy: { version: 'desc' },
    });
  }

  async getWindows(filters: {
    sessionId?: string;
    courseId?: string;
    from?: string;
    to?: string;
    configVersion?: number;
    limit?: number;
  }) {
    // If the caller scoped to one session, make sure its windows have
    // been computed at least once. Compute-on-read so single-session
    // views don't go stale relative to the live OpenFace3 pipeline.
    if (filters.sessionId) {
      await this.ensureWindowsForSession(filters.sessionId).catch((err) =>
        this.logger.warn(`ensureWindowsForSession ${filters.sessionId} failed: ${err}`),
      );
    }

    const where: Record<string, unknown> = {};
    if (filters.sessionId) where.sessionId = filters.sessionId;
    if (filters.courseId) where.courseId = filters.courseId;
    if (filters.configVersion) where.configVersion = filters.configVersion;
    if (filters.from || filters.to) {
      where.windowStartWallMs = {};
      if (filters.from) (where.windowStartWallMs as any).gte = BigInt(filters.from);
      if (filters.to) (where.windowStartWallMs as any).lte = BigInt(filters.to);
    }

    return this.prisma.affectiveStateWindow.findMany({
      where,
      orderBy: { windowStartWallMs: 'asc' },
      take: Math.min(filters.limit ?? 1000, 5000),
    });
  }

  async getSessionSummary(sessionId: string) {
    // Ensure the windows exist before summarising. Without this, a
    // session whose OpenFace3 frames were just written but never
    // pulled through the (still-not-wired) affective writer pipeline
    // would always summarise to zeros — that's what made the user's
    // SessionEmotionTab appear empty even though emotion_frames had
    // hundreds of rows.
    await this.ensureWindowsForSession(sessionId).catch((err) =>
      this.logger.warn(`ensureWindowsForSession ${sessionId} failed: ${err}`),
    );

    const windows = await this.prisma.affectiveStateWindow.findMany({
      where: { sessionId },
      orderBy: { windowStartWallMs: 'asc' },
    });

    if (windows.length === 0) return { totalWindows: 0, states: {} };

    const n = windows.length;
    const meanEngagement = windows.reduce((s, w) => s + w.engagement, 0) / n;
    const meanBoredom = windows.reduce((s, w) => s + w.boredom, 0) / n;
    const meanConfusion = windows.reduce((s, w) => s + w.confusion, 0) / n;
    const meanFrustration = windows.reduce((s, w) => s + w.frustration, 0) / n;

    const dominantCounts: Record<string, number> = {};
    for (const w of windows) {
      dominantCounts[w.dominantState] = (dominantCounts[w.dominantState] ?? 0) + 1;
    }

    return {
      totalWindows: n,
      means: {
        engagement: Math.round(meanEngagement * 1000) / 1000,
        boredom: Math.round(meanBoredom * 1000) / 1000,
        confusion: Math.round(meanConfusion * 1000) / 1000,
        frustration: Math.round(meanFrustration * 1000) / 1000,
      },
      dominantCounts,
      timeInState: Object.fromEntries(
        Object.entries(dominantCounts).map(([k, v]) => [k, Math.round((v / n) * 100)]),
      ),
    };
  }

  async getCourseOverview(courseId: string) {
    const students = await this.prisma.user.findMany({
      where: {
        enrollments: { some: { courseId, status: 'ACTIVE' } },
      },
      select: { id: true, name: true },
    });

    const results = await Promise.all(
      students.map(async (student) => {
        const windows = await this.prisma.affectiveStateWindow.findMany({
          where: { userId: student.id, courseId },
        });

        const n = windows.length || 1;
        const dominantCounts: Record<string, number> = {};
        for (const w of windows) {
          dominantCounts[w.dominantState] = (dominantCounts[w.dominantState] ?? 0) + 1;
        }

        return {
          studentId: student.id,
          studentName: student.name,
          totalWindows: windows.length,
          pctEngagement: Math.round(((dominantCounts['engagement'] ?? 0) / n) * 100),
          pctBoredom: Math.round(((dominantCounts['boredom'] ?? 0) / n) * 100),
          pctConfusion: Math.round(((dominantCounts['confusion'] ?? 0) / n) * 100),
          pctFrustration: Math.round(((dominantCounts['frustration'] ?? 0) / n) * 100),
        };
      }),
    );

    return results;
  }

  /**
   * Idempotently materialise the affective_state_windows for a given
   * StudentSession.
   *
   * The "real" pipeline that owns this is missing — the OpenFace3
   * worker writes emotion_frames, but no service runs the mapping
   * engine on the resulting frames. This method bridges the gap by
   * computing windows on the first read after the frames are
   * available, and persisting them so subsequent reads / exports /
   * retro-tracing all hit the table directly.
   *
   * Returns the number of windows newly inserted (0 if either windows
   * already exist for this session, or there are no emotion frames to
   * compute from yet).
   */
  async ensureWindowsForSession(sessionId: string): Promise<number> {
    const existing = await this.prisma.affectiveStateWindow.count({
      where: { sessionId },
    });
    if (existing > 0) return 0;

    const frames = await this.prisma.emotionFrame.findMany({
      where: { sessionId },
      orderBy: { frameWallMs: 'asc' },
      select: {
        userId: true,
        courseId: true,
        frameWallMs: true,
        faceDetected: true,
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
    if (frames.length === 0) return 0;

    // Resolve courseId from the first frame and load (or auto-create)
    // the course's mapping config — this is the same path the
    // controller's `GET /windows/:courseId` hits, just without the
    // round-trip.
    const courseId = frames[0]!.courseId;
    const userId = frames[0]!.userId;
    const config = await this.getConfig(courseId);
    const ruleSet = config.rules as unknown as MappingRuleSet;
    const windowMs = config.windowSeconds * 1000;
    const strideMs = config.strideSeconds * 1000;

    const startMs = Number(frames[0]!.frameWallMs);
    const endMs = Number(frames[frames.length - 1]!.frameWallMs);

    const toInsert: Prisma.AffectiveStateWindowCreateManyInput[] = [];
    for (let wStart = startMs; wStart + windowMs <= endMs + strideMs; wStart += strideMs) {
      const wEnd = wStart + windowMs;
      const inWindow = frames.filter((f) => {
        const t = Number(f.frameWallMs);
        return t >= wStart && t < wEnd;
      });
      if (inWindow.length === 0) continue;

      const result = this.engine.computeWindow(inWindow, ruleSet, config.minFramesPerWindow);
      if (!result) continue;

      toInsert.push({
        sessionId,
        userId,
        courseId,
        configId: config.id,
        configVersion: config.version,
        windowStartWallMs: BigInt(wStart),
        windowEndWallMs: BigInt(wEnd),
        framesInWindow: inWindow.length,
        framesWithFace: inWindow.filter((f) => f.faceDetected).length,
        engagement: result.engagement,
        boredom: result.boredom,
        confusion: result.confusion,
        frustration: result.frustration,
        dominantState: result.dominantState,
      });
    }

    if (toInsert.length === 0) return 0;
    const inserted = await this.prisma.affectiveStateWindow.createMany({
      data: toInsert,
      skipDuplicates: true,
    });
    this.logger.log(
      `compute-on-read: inserted ${inserted.count} affective windows for session=${sessionId} course=${courseId}`,
    );
    return inserted.count;
  }

  async preview(
    courseId: string,
    sessionId: string,
    rules: MappingRuleSet,
    windowSeconds: number,
    strideSeconds: number,
    minFramesPerWindow: number,
  ) {
    const frames = await this.prisma.emotionFrame.findMany({
      where: { sessionId, courseId },
      orderBy: { frameWallMs: 'asc' },
    });

    if (frames.length === 0) return [];

    const startMs = Number(frames[0]!.frameWallMs);
    const endMs = Number(frames[frames.length - 1]!.frameWallMs);
    const windowMs = windowSeconds * 1000;
    const strideMs = strideSeconds * 1000;

    const results: Array<{
      windowStartWallMs: number;
      windowEndWallMs: number;
      engagement: number;
      boredom: number;
      confusion: number;
      frustration: number;
      dominantState: string;
    }> = [];

    for (let wStart = startMs; wStart + windowMs <= endMs + strideMs; wStart += strideMs) {
      const wEnd = wStart + windowMs;
      const windowFrames = frames.filter((f) => {
        const t = Number(f.frameWallMs);
        return t >= wStart && t < wEnd;
      });

      const result = this.engine.computeWindow(windowFrames, rules, minFramesPerWindow);
      if (result) {
        results.push({
          windowStartWallMs: wStart,
          windowEndWallMs: wEnd,
          engagement: result.engagement,
          boredom: result.boredom,
          confusion: result.confusion,
          frustration: result.frustration,
          dominantState: result.dominantState,
        });
      }
    }

    return results;
  }
}
