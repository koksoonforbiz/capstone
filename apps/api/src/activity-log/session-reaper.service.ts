import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from './session.service';

/**
 * Server-side reaper that auto-closes sessions left orphaned by a crash,
 * lid-close, network drop, or any other path where the client never got
 * to call `/session/close`.
 *
 * The CLIENT-side idle-logout (`useIdleLogout`) is the primary path —
 * it fires at 15 min of user inactivity and triggers a clean
 * /auth/logout → /session/close round-trip. This reaper is the safety
 * net: any session whose newest activity_log is older than IDLE_THRESHOLD
 * AND has no `endedAt` gets closed by the server.
 *
 * Runs every 5 minutes via setInterval (pattern matches the existing
 * grade-completed.poller). Idempotent — no-ops on a fresh DB.
 */

const POLL_INTERVAL_MS = 5 * 60_000; // 5 min
/** Server-side threshold is intentionally LOOSER than the client's 15 min
 *  idle window so a slightly-late client logout doesn't race the reaper.
 *  In practice the client closes sessions cleanly; this only fires on
 *  hard crash / lid-close. */
const IDLE_THRESHOLD_MS = 30 * 60_000; // 30 min

@Injectable()
export class SessionReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionReaperService.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  onModuleInit(): void {
    this.logger.log(
      `Starting session reaper (every ${POLL_INTERVAL_MS / 60_000}min, idle ≥${IDLE_THRESHOLD_MS / 60_000}min)`,
    );
    // First sweep one tick after boot so a fresh dev server doesn't miss
    // the first 5-min window.
    setTimeout(() => {
      this.sweep().catch((err) => this.logger.error('Initial sweep failed', err));
    }, 30_000);
    this.intervalHandle = setInterval(() => {
      this.sweep().catch((err) => this.logger.error('Reaper sweep failed', err));
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Closes any open session whose most recent activity_log is older than
   *  the idle threshold. Sessions with NO logs at all (still in token-only
   *  bootstrapping phase) are closed if they were opened > threshold ago. */
  async sweep(): Promise<{ closed: number }> {
    const cutoff = new Date(Date.now() - IDLE_THRESHOLD_MS);

    // Candidate sessions: open + opened before cutoff (cheap pre-filter).
    const candidates = await this.prisma.studentSession.findMany({
      where: {
        endedAt: null,
        startedAt: { lt: cutoff },
      },
      select: { id: true, startedAt: true },
      take: 500, // bounded sweep, will catch up across iterations
    });
    if (candidates.length === 0) return { closed: 0 };

    // Pull MAX(occurredAt) per candidate. groupBy is the cheapest way.
    const lastActivityRows = await this.prisma.activityLog.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: candidates.map((c) => c.id) } },
      _max: { occurredAt: true },
    });
    const lastBySession = new Map<string, Date | null>(
      lastActivityRows.map((r) => [r.sessionId, r._max.occurredAt]),
    );

    let closed = 0;
    for (const session of candidates) {
      const last = lastBySession.get(session.id) ?? null;
      // If the session has no logs at all AND was opened > threshold ago,
      // close it. Otherwise check the most-recent log's age.
      const idleSince = last ?? session.startedAt;
      if (idleSince < cutoff) {
        try {
          await this.sessionService.closeSession(session.id);
          closed += 1;
        } catch (err) {
          this.logger.warn(
            `Failed to close idle session ${session.id}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }
    }
    if (closed > 0) {
      this.logger.log(`Reaper closed ${closed} idle session(s) (cutoff: ${cutoff.toISOString()})`);
    }
    return { closed };
  }
}
