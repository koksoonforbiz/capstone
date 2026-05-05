import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EpisodeGroupingService } from '../../learning-episode/episode-grouping.service';

/**
 * Episode mutation operations (prompt_retro Stage 6).
 *
 * Researchers need to manually correct the auto-grouper's output: merge
 * episodes that should have been one sitting, split sittings that got
 * incorrectly bundled, detach individual sessions, and add free-text
 * annotations. Every mutation writes an `EpisodeAudit` row and (for
 * merges) soft-deletes the donor episodes so referenced IDs remain
 * resolvable.
 */
@Injectable()
export class EpisodeManagementService {
  private readonly logger = new Logger(EpisodeManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly grouping: EpisodeGroupingService,
  ) {}

  // ─── Merge ──────────────────────────────────────────────────────────────

  async mergeEpisodes(
    actorUserId: string,
    actorRole: string,
    input: { episodeIds: string[]; primaryId?: string; reason?: string },
  ): Promise<{ episodeId: string }> {
    const { episodeIds, primaryId, reason } = input;
    if (!Array.isArray(episodeIds) || episodeIds.length < 2) {
      throw new BadRequestException('At least two episode IDs are required to merge.');
    }
    const unique = [...new Set(episodeIds)];
    if (unique.length < 2) {
      throw new BadRequestException('Episode IDs must be distinct.');
    }
    if (primaryId && !unique.includes(primaryId)) {
      throw new BadRequestException('primaryId must appear in episodeIds.');
    }

    const episodes = await this.prisma.learningEpisode.findMany({
      where: { id: { in: unique }, deletedAt: null },
      include: { sessions: { select: { id: true } } },
    });
    if (episodes.length !== unique.length) {
      throw new NotFoundException('One or more episodes not found (or already merged away).');
    }

    // All episodes must belong to the same user + course.
    const userId = episodes[0]!.userId;
    const courseId = episodes[0]!.courseId;
    const mismatched = episodes.filter((e) => e.userId !== userId || e.courseId !== courseId);
    if (mismatched.length > 0) {
      throw new BadRequestException(
        'All episodes to merge must belong to the same student and course.',
      );
    }

    await this.assertCourseOwnedByTeacher(actorUserId, actorRole, courseId);

    // Pick the primary — explicit, otherwise the earliest-started.
    const primary = primaryId
      ? episodes.find((e) => e.id === primaryId)!
      : episodes.reduce((earliest, e) => (e.startedAt < earliest.startedAt ? e : earliest));

    const donors = episodes.filter((e) => e.id !== primary.id);
    const donorIds = donors.map((d) => d.id);
    const movedSessionIds = donors.flatMap((d) => d.sessions.map((s) => s.id));

    await this.prisma.$transaction(async (tx) => {
      // Reassign all donor sessions to the primary.
      if (movedSessionIds.length > 0) {
        await tx.studentSession.updateMany({
          where: { id: { in: movedSessionIds } },
          data: { episodeId: primary.id },
        });
      }

      // Soft-delete donors.
      await tx.learningEpisode.updateMany({
        where: { id: { in: donorIds } },
        data: { deletedAt: new Date() },
      });

      // Primary becomes manually grouped.
      await tx.learningEpisode.update({
        where: { id: primary.id },
        data: { groupingMethod: 'manual', groupingConfidence: null },
      });

      // Audit: one "merged" entry on the primary.
      await tx.episodeAudit.create({
        data: {
          episodeId: primary.id,
          action: 'merged',
          actorUserId,
          payload: {
            mergedFromIds: donorIds,
            sessionIds: movedSessionIds,
            reason: reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      // Audit: per-donor "session_detached" rows on the donors so the trail
      // stays inspectable even after soft-delete.
      for (const donor of donors) {
        await tx.episodeAudit.create({
          data: {
            episodeId: donor.id,
            action: 'merged_into',
            actorUserId,
            payload: {
              targetEpisodeId: primary.id,
              sessionIds: donor.sessions.map((s) => s.id),
              reason: reason ?? null,
            } as Prisma.InputJsonValue,
          },
        });
      }
    });

    await this.grouping.recomputeEpisodeAggregates(primary.id);

    this.logger.log(
      `Merged ${donors.length} episodes into ${primary.id} (${movedSessionIds.length} sessions moved)`,
    );
    return { episodeId: primary.id };
  }

  // ─── Split ──────────────────────────────────────────────────────────────

  async splitEpisode(
    actorUserId: string,
    actorRole: string,
    episodeId: string,
    input: { splitAtSessionId: string; reason?: string },
  ): Promise<{ primaryId: string; newEpisodeId: string }> {
    const { splitAtSessionId, reason } = input;
    const episode = await this.prisma.learningEpisode.findUnique({
      where: { id: episodeId },
      include: {
        sessions: {
          orderBy: { startedAt: 'asc' },
          select: { id: true, startedAt: true },
        },
      },
    });
    if (!episode || episode.deletedAt) {
      throw new NotFoundException('Episode not found.');
    }
    await this.assertCourseOwnedByTeacher(actorUserId, actorRole, episode.courseId);

    const splitIdx = episode.sessions.findIndex((s) => s.id === splitAtSessionId);
    if (splitIdx < 0) {
      throw new BadRequestException('splitAtSessionId is not a session in this episode.');
    }
    if (splitIdx === 0) {
      throw new BadRequestException(
        'Cannot split at the first session — that would empty the source episode.',
      );
    }

    const movingSessions = episode.sessions.slice(splitIdx);
    const movingIds = movingSessions.map((s) => s.id);
    const newStartedAt = movingSessions[0]!.startedAt;

    let newEpisodeId = '';
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.learningEpisode.create({
        data: {
          userId: episode.userId,
          courseId: episode.courseId,
          startedAt: newStartedAt,
          groupingMethod: 'manual',
          groupingConfidence: null,
          notes: reason ? `Split from ${episode.id}: ${reason}` : null,
        },
        select: { id: true },
      });
      newEpisodeId = created.id;

      await tx.studentSession.updateMany({
        where: { id: { in: movingIds } },
        data: { episodeId: created.id },
      });

      // Source becomes manual too — researcher has touched it.
      await tx.learningEpisode.update({
        where: { id: episode.id },
        data: { groupingMethod: 'manual', groupingConfidence: null },
      });

      await tx.episodeAudit.create({
        data: {
          episodeId: episode.id,
          action: 'split',
          actorUserId,
          payload: {
            splitAtSessionId,
            newEpisodeId: created.id,
            movedSessionIds: movingIds,
            reason: reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.episodeAudit.create({
        data: {
          episodeId: created.id,
          action: 'created_from_split',
          actorUserId,
          payload: {
            sourceEpisodeId: episode.id,
            sessionIds: movingIds,
            reason: reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    });

    await Promise.all([
      this.grouping.recomputeEpisodeAggregates(episode.id),
      this.grouping.recomputeEpisodeAggregates(newEpisodeId),
    ]);

    this.logger.log(
      `Split episode ${episode.id}: ${movingIds.length} sessions moved to new ${newEpisodeId}`,
    );
    return { primaryId: episode.id, newEpisodeId };
  }

  // ─── Detach session ─────────────────────────────────────────────────────

  async detachSession(
    actorUserId: string,
    actorRole: string,
    episodeId: string,
    input: { sessionId: string; targetEpisodeId?: string; reason?: string },
  ): Promise<{ sourceEpisodeId: string; targetEpisodeId: string }> {
    const { sessionId, targetEpisodeId, reason } = input;
    const source = await this.prisma.learningEpisode.findUnique({
      where: { id: episodeId },
      include: { sessions: { select: { id: true, startedAt: true } } },
    });
    if (!source || source.deletedAt) {
      throw new NotFoundException('Source episode not found.');
    }
    await this.assertCourseOwnedByTeacher(actorUserId, actorRole, source.courseId);

    const session = source.sessions.find((s) => s.id === sessionId);
    if (!session) {
      throw new BadRequestException('Session is not in the source episode.');
    }
    if (source.sessions.length === 1) {
      throw new BadRequestException(
        'Cannot detach the only session — the source episode would be empty.',
      );
    }

    let target: { id: string } | null = null;
    if (targetEpisodeId) {
      const t = await this.prisma.learningEpisode.findUnique({
        where: { id: targetEpisodeId },
      });
      if (!t || t.deletedAt) {
        throw new NotFoundException('Target episode not found.');
      }
      if (t.userId !== source.userId || t.courseId !== source.courseId) {
        throw new BadRequestException('Target episode must belong to the same student and course.');
      }
      target = { id: t.id };
    }

    await this.prisma.$transaction(async (tx) => {
      let targetId = target?.id;
      if (!targetId) {
        const created = await tx.learningEpisode.create({
          data: {
            userId: source.userId,
            courseId: source.courseId,
            startedAt: session.startedAt,
            groupingMethod: 'manual',
            groupingConfidence: null,
            notes: reason ? `Detached from ${source.id}: ${reason}` : null,
          },
          select: { id: true },
        });
        targetId = created.id;
        target = { id: targetId };
      }

      await tx.studentSession.update({
        where: { id: sessionId },
        data: { episodeId: targetId! },
      });

      // Source becomes manual.
      await tx.learningEpisode.update({
        where: { id: source.id },
        data: { groupingMethod: 'manual', groupingConfidence: null },
      });

      await tx.episodeAudit.create({
        data: {
          episodeId: source.id,
          action: 'session_detached',
          actorUserId,
          payload: {
            sessionId,
            targetEpisodeId: targetId,
            reason: reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.episodeAudit.create({
        data: {
          episodeId: targetId!,
          action: 'session_attached',
          actorUserId,
          payload: {
            sessionId,
            sourceEpisodeId: source.id,
            reason: reason ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    });

    await Promise.all([
      this.grouping.recomputeEpisodeAggregates(source.id),
      this.grouping.recomputeEpisodeAggregates(target!.id),
    ]);

    this.logger.log(`Detached session ${sessionId} from ${source.id} → ${target!.id}`);
    return { sourceEpisodeId: source.id, targetEpisodeId: target!.id };
  }

  // ─── Annotate ───────────────────────────────────────────────────────────

  async annotateEpisode(
    actorUserId: string,
    actorRole: string,
    episodeId: string,
    notes: string,
  ): Promise<{ id: string; notes: string }> {
    if (typeof notes !== 'string') {
      throw new BadRequestException('notes must be a string.');
    }
    if (notes.length > 10_000) {
      throw new BadRequestException('notes too long (max 10000 chars).');
    }
    const episode = await this.prisma.learningEpisode.findUnique({
      where: { id: episodeId },
      select: { id: true, courseId: true, notes: true, deletedAt: true },
    });
    if (!episode || episode.deletedAt) {
      throw new NotFoundException('Episode not found.');
    }
    await this.assertCourseOwnedByTeacher(actorUserId, actorRole, episode.courseId);

    const previous = episode.notes;
    await this.prisma.$transaction(async (tx) => {
      await tx.learningEpisode.update({
        where: { id: episodeId },
        data: { notes },
      });
      await tx.episodeAudit.create({
        data: {
          episodeId,
          action: 'annotated',
          actorUserId,
          payload: {
            previous,
            length: notes.length,
          } as Prisma.InputJsonValue,
        },
      });
    });

    return { id: episodeId, notes };
  }

  // ─── Audit history ──────────────────────────────────────────────────────

  async getAudit(
    actorUserId: string,
    actorRole: string,
    episodeId: string,
  ): Promise<
    Array<{
      id: string;
      action: string;
      actor: { id: string; name: string } | null;
      payload: unknown;
      createdAt: string;
    }>
  > {
    const episode = await this.prisma.learningEpisode.findUnique({
      where: { id: episodeId },
      select: { courseId: true },
    });
    if (!episode) throw new NotFoundException('Episode not found.');
    await this.assertCourseOwnedByTeacher(actorUserId, actorRole, episode.courseId);

    const rows = await this.prisma.episodeAudit.findMany({
      where: { episodeId },
      orderBy: { createdAt: 'asc' },
    });
    const actorIds = [
      ...new Set(rows.map((r) => r.actorUserId).filter((id): id is string => !!id)),
    ];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, { id: a.id, name: a.name }]));

    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actorUserId ? (actorMap.get(r.actorUserId) ?? null) : null,
      payload: r.payload,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ─── Internal: ownership ────────────────────────────────────────────────

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
}
