import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CONSTRUCTS } from '../detection/constructs';

/**
 * StudentSession ids are UUIDs (`uuid()` from Prisma); DialogueSession
 * ids are cuids (`cuid()`). The two spaces are disjoint, so the
 * format alone is enough to tell which kind of id was passed.
 *
 * The teacher's live chat-thread dashboard passes a DialogueSession.id
 * (it's scoped to one chat); the SessionTimelinePage passes a
 * StudentSession.id (it's scoped to one login session, possibly
 * spanning multiple chats). Routing on id-format means both views can
 * share the endpoint without an explicit query param.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isStudentSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSessionDashboard(sessionId: string, rollingN: number) {
    const isStudentSession = isStudentSessionId(sessionId);

    // Build the EF-detection scope filter. For StudentSession.id we
    // query on the new `studentSessionId` column populated by the
    // dialogue → text-mining wiring; for DialogueSession.id we query
    // on the original `sessionId` column.
    const efScope = isStudentSession
      ? ({ studentSessionId: sessionId } as const)
      : ({ sessionId } as const);

    // Count of user messages that drove EF processing in this scope.
    // For DialogueSession.id we can count dialogue_messages directly;
    // for StudentSession.id we count distinct messageIds across the
    // EF detections (each user message produces a fan-out of one row
    // per construct, dedupe to get the message count).
    const totalUserMessages = isStudentSession
      ? (
          await this.prisma.efDetection.findMany({
            where: { studentSessionId: sessionId },
            select: { messageId: true },
            distinct: ['messageId'],
          })
        ).length
      : await this.prisma.dialogueMessage.count({
          where: { sessionId, role: 'USER' },
        });

    const constructs: Record<string, unknown> = {};

    for (const c of CONSTRUCTS) {
      const allDetections = await this.prisma.efDetection.findMany({
        where: { ...efScope, constructKey: c.key, label: { notIn: ['error', 'pending'] } },
        orderBy: { createdAt: 'desc' },
      });

      const latest = allDetections[0] ?? null;
      const rollingSlice = allDetections.slice(0, rollingN);
      const sessionSlice = allDetections;

      const disabled = allDetections.length === 0 && totalUserMessages > 0;
      const errorCount = await this.prisma.efDetection.count({
        where: { ...efScope, constructKey: c.key, label: 'error' },
      });
      const pendingCount = await this.prisma.efDetection.count({
        where: { ...efScope, constructKey: c.key, label: 'pending' },
      });

      let rolling: unknown;
      let session: unknown;

      if (c.labelType === 'binary') {
        rolling = {
          positiveRate: computeRate(rollingSlice, 'positive'),
          n: rollingSlice.length,
        };
        session = {
          positiveRate: computeRate(sessionSlice, 'positive'),
          n: sessionSlice.length,
        };
      } else if (c.labelType === 'ordinal') {
        rolling = {
          distribution: computeDistribution(rollingSlice, ['low', 'medium', 'high']),
          n: rollingSlice.length,
        };
        session = {
          distribution: computeDistribution(sessionSlice, ['low', 'medium', 'high']),
          n: sessionSlice.length,
        };
      } else {
        rolling = {
          onTaskRate: computeRate(rollingSlice, 'on-task'),
          n: rollingSlice.length,
        };
        session = {
          onTaskRate: computeRate(sessionSlice, 'on-task'),
          n: sessionSlice.length,
        };
      }

      constructs[c.key] = {
        displayName: c.displayName,
        labelType: c.labelType,
        feasibility: c.feasibility,
        warning: c.warning,
        disabled,
        latest: latest
          ? {
              messageId: latest.messageId,
              label: latest.label,
              confidence: latest.confidence,
              rationale: latest.rationale,
              createdAt: latest.createdAt,
            }
          : null,
        rolling,
        session,
        errorCount,
        pendingCount,
      };
    }

    return { rollingN, totalUserMessages, constructs };
  }

  async getDetections(
    sessionId: string,
    filters: { constructKey?: string; label?: string; cursor?: string; limit: number },
  ) {
    // Same routing logic as `getSessionDashboard`: UUID → student-
    // session scope, cuid → dialogue-session scope.
    const where: Record<string, unknown> = isStudentSessionId(sessionId)
      ? { studentSessionId: sessionId }
      : { sessionId };
    if (filters.constructKey) where.constructKey = filters.constructKey;
    if (filters.label) where.label = filters.label;
    if (filters.cursor) where.id = { lt: filters.cursor };

    const items = await this.prisma.efDetection.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filters.limit + 1,
    });

    const hasMore = items.length > filters.limit;
    if (hasMore) items.pop();

    // Join message content
    const messageIds = [...new Set(items.map((i) => i.messageId))];
    const messages = await this.prisma.dialogueMessage.findMany({
      where: { id: { in: messageIds } },
      select: { id: true, content: true },
    });
    const messageMap = new Map(messages.map((m) => [m.id, m.content]));

    return {
      items: items.map((i) => ({
        id: i.id,
        messageId: i.messageId,
        messageContent: (messageMap.get(i.messageId) ?? '').slice(0, 280),
        constructKey: i.constructKey,
        label: i.label,
        confidence: i.confidence,
        severity: i.severity,
        rationale: i.rationale,
        warning: i.warning,
        createdAt: i.createdAt,
        model: i.model,
        promptVersion: i.promptVersion,
      })),
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
    };
  }

  async getStudentDashboard(studentId: string, courseId: string | undefined, rollingN: number) {
    const where: Record<string, unknown> = { studentId };
    if (courseId) where.courseId = courseId;

    const totalDetections = await this.prisma.efDetection.count({ where });
    if (totalDetections === 0) {
      return { rollingN, totalUserMessages: 0, constructs: {} };
    }

    const totalUserMessages = await this.prisma.dialogueMessage.count({
      where: {
        role: 'USER',
        session: { studentId, ...(courseId ? { courseId } : {}) },
      },
    });

    const constructs: Record<string, unknown> = {};

    for (const c of CONSTRUCTS) {
      const allDetections = await this.prisma.efDetection.findMany({
        where: { ...where, constructKey: c.key, label: { notIn: ['error', 'pending'] } },
        orderBy: { createdAt: 'desc' },
      });

      const latest = allDetections[0] ?? null;
      const rollingSlice = allDetections.slice(0, rollingN);

      let rolling: unknown;
      let session: unknown;

      if (c.labelType === 'binary') {
        rolling = { positiveRate: computeRate(rollingSlice, 'positive'), n: rollingSlice.length };
        session = { positiveRate: computeRate(allDetections, 'positive'), n: allDetections.length };
      } else if (c.labelType === 'ordinal') {
        rolling = {
          distribution: computeDistribution(rollingSlice, ['low', 'medium', 'high']),
          n: rollingSlice.length,
        };
        session = {
          distribution: computeDistribution(allDetections, ['low', 'medium', 'high']),
          n: allDetections.length,
        };
      } else {
        rolling = { onTaskRate: computeRate(rollingSlice, 'on-task'), n: rollingSlice.length };
        session = { onTaskRate: computeRate(allDetections, 'on-task'), n: allDetections.length };
      }

      constructs[c.key] = {
        displayName: c.displayName,
        labelType: c.labelType,
        feasibility: c.feasibility,
        warning: c.warning,
        disabled: false,
        latest: latest
          ? {
              messageId: latest.messageId,
              label: latest.label,
              confidence: latest.confidence,
              rationale: latest.rationale,
              createdAt: latest.createdAt,
            }
          : null,
        rolling,
        session,
      };
    }

    return { rollingN, totalUserMessages, constructs };
  }
}

function computeRate(detections: Array<{ label: string }>, positiveLabel: string): number {
  if (detections.length === 0) return 0;
  const count = detections.filter((d) => d.label === positiveLabel).length;
  return Math.round((count / detections.length) * 100) / 100;
}

function computeDistribution(
  detections: Array<{ label: string }>,
  labels: string[],
): Record<string, number> {
  const total = detections.length || 1;
  const dist: Record<string, number> = {};
  for (const l of labels) {
    dist[l] = Math.round((detections.filter((d) => d.label === l).length / total) * 100) / 100;
  }
  return dist;
}
