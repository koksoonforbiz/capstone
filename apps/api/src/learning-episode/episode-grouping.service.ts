import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Decides which LearningEpisode a freshly-created StudentSession belongs to.
 *
 * Multiple StudentSession rows can represent a single study sitting (refresh,
 * reconnect, tab reopen). We collapse them into one LearningEpisode using a
 * three-tier signal:
 *
 *   1. clientEpisodeId — strongest signal, set by the browser via the
 *      X-Learning-Episode-Id header (Stage 2). For Stage 1 the parameter
 *      exists but the header isn't yet wired, so this branch is exercised
 *      mainly by tests.
 *   2. auto_heuristic — server-side fallback comparing gap + user-agent
 *      (and IP for the looser threshold) against the most recent prior
 *      session for this user+course.
 *   3. manual — researcher merge/split via the teacher portal (Stage 6,
 *      not implemented here).
 *
 * Every assignment writes an EpisodeAudit row so post-hoc diagnostics can
 * reconstruct exactly how a sitting was assembled.
 */

export type AssignmentMethod =
  | 'client_episode_id'
  | 'auto_heuristic'
  | 'auto_heuristic_backfill'
  | 'manual';

export interface AssignSessionInput {
  sessionId: string;
  userId: string;
  courseId: string;
  startedAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
  /** From X-Learning-Episode-Id header (Stage 2). Optional and best-effort. */
  clientEpisodeId?: string | null;
  /**
   * If `true`, mark the assignment as `auto_heuristic_backfill` instead of
   * `auto_heuristic`. Used by `backfillAllSessions` so historical decisions
   * are distinguishable from live ones.
   */
  isBackfill?: boolean;
}

export interface AssignSessionResult {
  episodeId: string;
  method: AssignmentMethod;
  confidence: number | null;
}

interface BackfillOptions {
  batchSize?: number;
  dryRun?: boolean;
}

interface BackfillResult {
  /** Number of sessions that received an episodeId during this run. */
  assigned: number;
  /** Number of new LearningEpisode rows created. */
  created: number;
  /** Number of sessions that were already assigned and skipped. */
  skipped: number;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class EpisodeGroupingService {
  private readonly logger = new Logger(EpisodeGroupingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Pick or create an episode for the given session. If the session already
   * has `episodeId` set the existing value wins (idempotent).
   *
   * The two prisma operations (find-or-create episode + update session) run
   * inside a single transaction — partial state is worse than a brief lock.
   */
  async assignEpisodeForSession(input: AssignSessionInput): Promise<AssignSessionResult> {
    return this.prisma.$transaction(async (tx) => {
      const decision = await this.decideEpisode(tx, input);

      // Always update the session row, then journal the decision.
      await tx.studentSession.update({
        where: { id: input.sessionId },
        data: { episodeId: decision.episodeId },
      });

      await tx.episodeAudit.create({
        data: {
          episodeId: decision.episodeId,
          action: 'session_attached',
          actorUserId: null,
          payload: {
            sessionId: input.sessionId,
            method: decision.method,
            confidence: decision.confidence,
            startedAt: input.startedAt.toISOString(),
            userAgent: input.userAgent ?? null,
            ipAddress: input.ipAddress ?? null,
          } satisfies Prisma.InputJsonValue,
        },
      });

      return decision;
    });
  }

  /**
   * Walk every StudentSession with `episodeId IS NULL` in `(userId, courseId,
   * startedAt ASC)` order and apply the same heuristic the live path uses
   * — but with the `auto_heuristic_backfill` method label so historical
   * decisions are distinguishable.
   *
   * Idempotent: rows that already have `episodeId` are skipped.
   */
  async backfillAllSessions(opts: BackfillOptions = {}): Promise<BackfillResult> {
    const batchSize = opts.batchSize ?? 500;
    const dryRun = opts.dryRun ?? false;

    let assigned = 0;
    let created = 0;
    let skipped = 0;
    let lastId: string | null = null;

    // eslint-disable-next-line no-constant-condition -- termination handled by `break` when batch < batchSize
    while (true) {
      const where: Prisma.StudentSessionWhereInput = {
        episodeId: null,
        courseId: { not: null },
        ...(lastId ? { id: { gt: lastId } } : {}),
      };
      const batch = await this.prisma.studentSession.findMany({
        where,
        orderBy: [{ id: 'asc' }],
        take: batchSize,
        select: {
          id: true,
          userId: true,
          courseId: true,
          startedAt: true,
          userAgent: true,
          ipAddress: true,
          episodeId: true,
        },
      });
      if (batch.length === 0) break;

      // Re-sort within the batch by (user, course, startedAt) so the
      // heuristic sees consecutive sessions of a sitting in order. The DB
      // sort is by id (for cursor), but the heuristic depends on temporal
      // proximity per user+course.
      const ordered = [...batch].sort((a, b) => {
        if (a.userId !== b.userId) return a.userId.localeCompare(b.userId);
        if (a.courseId !== b.courseId) return (a.courseId ?? '').localeCompare(b.courseId ?? '');
        return a.startedAt.getTime() - b.startedAt.getTime();
      });

      for (const s of ordered) {
        if (s.episodeId) {
          skipped += 1;
          continue;
        }
        if (!s.courseId) {
          // Courseless sessions can't be grouped — skip.
          skipped += 1;
          continue;
        }
        if (dryRun) {
          assigned += 1;
          continue;
        }
        const result = await this.assignEpisodeForSession({
          sessionId: s.id,
          userId: s.userId,
          courseId: s.courseId,
          startedAt: s.startedAt,
          userAgent: s.userAgent,
          ipAddress: s.ipAddress,
          isBackfill: true,
        });
        assigned += 1;
        if (result.method !== 'client_episode_id') {
          // We can tell whether a new episode was created by checking if
          // sessionCount transitioned from 0 to 1 — but checking the audit
          // we just wrote is simpler:
          const audit = await this.prisma.episodeAudit.findFirst({
            where: { episodeId: result.episodeId, action: 'created' },
            select: { id: true },
          });
          if (audit) {
            const recent = await this.prisma.episodeAudit.findFirst({
              where: { episodeId: result.episodeId, action: 'created' },
              orderBy: { createdAt: 'desc' },
            });
            if (recent && audit.id === recent.id) {
              created += 1;
            }
          }
        }
      }

      lastId = batch[batch.length - 1]!.id;
      this.logger.log(
        `[backfill] processed ${ordered.length} sessions (assigned=${assigned} created=${created} skipped=${skipped})`,
      );
      if (batch.length < batchSize) break;
    }

    if (!dryRun) {
      // Recompute aggregates for every episode we touched. Cheap because
      // the count is bounded by `created` + sessions we re-attached.
      const recompute = await this.prisma.learningEpisode.findMany({
        select: { id: true },
      });
      for (const ep of recompute) {
        await this.recomputeEpisodeAggregates(ep.id);
      }
    }

    return { assigned, created, skipped };
  }

  /**
   * Recompute totalActiveSecs / sessionCount / endedAt / startedAt from the
   * sessions currently attached to this episode. Idempotent and cheap (one
   * indexed query + one update).
   */
  async recomputeEpisodeAggregates(episodeId: string): Promise<void> {
    const sessions = await this.prisma.studentSession.findMany({
      where: { episodeId },
      select: { startedAt: true, endedAt: true, durationSecs: true },
    });

    if (sessions.length === 0) {
      // No sessions left — episode is empty. Don't delete (audit history may
      // still reference it); just zero the aggregates.
      await this.prisma.learningEpisode.update({
        where: { id: episodeId },
        data: { totalActiveSecs: 0, sessionCount: 0, endedAt: null },
      });
      return;
    }

    const startedAt = sessions.reduce(
      (min, s) => (s.startedAt < min ? s.startedAt : min),
      sessions[0]!.startedAt,
    );
    const endedAt = sessions.reduce<Date | null>((max, s) => {
      if (!s.endedAt) return max;
      if (!max) return s.endedAt;
      return s.endedAt > max ? s.endedAt : max;
    }, null);
    const totalActiveSecs = sessions.reduce((sum, s) => sum + (s.durationSecs ?? 0), 0);

    await this.prisma.learningEpisode.update({
      where: { id: episodeId },
      data: {
        startedAt,
        endedAt,
        totalActiveSecs,
        sessionCount: sessions.length,
      },
    });
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /**
   * Returns the chosen episode's id + method/confidence WITHOUT mutating the
   * session (the caller does that). May create a new episode if none of the
   * heuristic checks find a match.
   */
  private async decideEpisode(
    tx: Prisma.TransactionClient,
    input: AssignSessionInput,
  ): Promise<AssignSessionResult> {
    // 1. clientEpisodeId path.
    if (input.clientEpisodeId && UUID_V4_RE.test(input.clientEpisodeId)) {
      const candidate = await tx.learningEpisode.findUnique({
        where: { id: input.clientEpisodeId },
        select: { id: true, userId: true, courseId: true },
      });
      if (candidate) {
        if (candidate.userId !== input.userId) {
          this.logger.warn(
            `clientEpisodeId ${input.clientEpisodeId} belongs to a different user; ignoring`,
          );
          // fall through to heuristic
        } else if (candidate.courseId !== input.courseId) {
          // Different course on same user — treat as a new sitting; fall
          // through to heuristic so we don't merge across course contexts.
        } else {
          return {
            episodeId: candidate.id,
            method: 'client_episode_id',
            confidence: null,
          };
        }
      } else {
        // The client provided a UUID that doesn't exist server-side yet.
        // Create the episode WITH that id so client/server stay aligned.
        const episode = await this.createEpisode(tx, {
          id: input.clientEpisodeId,
          userId: input.userId,
          courseId: input.courseId,
          startedAt: input.startedAt,
          method: 'client_episode_id',
          confidence: null,
        });
        return {
          episodeId: episode.id,
          method: 'client_episode_id',
          confidence: null,
        };
      }
    }

    // 2. auto_heuristic — find the most recent prior session for this
    //    user+course and decide whether to attach to its episode.
    const tightMin = this.config.get<number>('EPISODE_GAP_MIN_TIGHT', 5);
    const looseMin = this.config.get<number>('EPISODE_GAP_MIN_LOOSE', 15);

    const prior = await tx.studentSession.findFirst({
      where: {
        userId: input.userId,
        courseId: input.courseId,
        episodeId: { not: null },
        startedAt: { lt: input.startedAt },
        id: { not: input.sessionId },
      },
      orderBy: { startedAt: 'desc' },
      select: {
        episodeId: true,
        endedAt: true,
        startedAt: true,
        userAgent: true,
        ipAddress: true,
      },
    });

    const method: AssignmentMethod = input.isBackfill
      ? 'auto_heuristic_backfill'
      : 'auto_heuristic';

    if (prior?.episodeId) {
      // Use endedAt if known, otherwise use the prior session's startedAt
      // as a conservative anchor.
      const priorEndMs = (prior.endedAt ?? prior.startedAt).getTime();
      const gapMin = (input.startedAt.getTime() - priorEndMs) / 60_000;
      const sameUa = !!prior.userAgent && prior.userAgent === input.userAgent;
      const sameIp = !!prior.ipAddress && prior.ipAddress === input.ipAddress;

      if (gapMin >= 0 && gapMin < tightMin && sameUa) {
        return { episodeId: prior.episodeId, method, confidence: 0.95 };
      }
      if (gapMin >= 0 && gapMin < looseMin && sameUa && sameIp) {
        return { episodeId: prior.episodeId, method, confidence: 0.75 };
      }
    }

    // 3. New episode (high confidence it's a new sitting).
    const episode = await this.createEpisode(tx, {
      userId: input.userId,
      courseId: input.courseId,
      startedAt: input.startedAt,
      method,
      confidence: 1.0,
    });
    return { episodeId: episode.id, method, confidence: 1.0 };
  }

  private async createEpisode(
    tx: Prisma.TransactionClient,
    args: {
      id?: string;
      userId: string;
      courseId: string;
      startedAt: Date;
      method: AssignmentMethod;
      confidence: number | null;
    },
  ) {
    const episode = await tx.learningEpisode.create({
      data: {
        ...(args.id ? { id: args.id } : {}),
        userId: args.userId,
        courseId: args.courseId,
        startedAt: args.startedAt,
        groupingMethod: args.method,
        groupingConfidence: args.confidence,
      },
    });
    await tx.episodeAudit.create({
      data: {
        episodeId: episode.id,
        action: 'created',
        actorUserId: null,
        payload: {
          method: args.method,
          confidence: args.confidence,
          seedSessionStartedAt: args.startedAt.toISOString(),
        } satisfies Prisma.InputJsonValue,
      },
    });
    return episode;
  }
}
