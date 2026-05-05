/**
 * Unit tests for EpisodeGroupingService.
 *
 * Mocks Prisma; the heuristic logic is the focus, not DB integration.
 * `$transaction(cb)` is mocked to invoke the callback with the same mock,
 * so any tx.* call hits the same fakes that prisma.* would.
 */

import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import { EpisodeGroupingService } from './episode-grouping.service';

const VALID_UUID_V4 = '550e8400-e29b-41d4-a716-446655440000';
const INVALID_UUID = 'not-a-uuid';

function makePrismaMock() {
  const mock = {
    studentSession: {
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    learningEpisode: {
      findUnique: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    episodeAudit: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  // Make $transaction(cb) just run the callback with the same mock acting as `tx`.
  mock.$transaction.mockImplementation(async (cb: (tx: typeof mock) => unknown) => cb(mock));
  return mock;
}

function makeConfig(overrides: Record<string, number> = {}) {
  return {
    get: jest.fn((key: string, fallback?: number) => {
      if (key in overrides) return overrides[key];
      return fallback;
    }),
  } as unknown as ConfigService;
}

function makeService(
  prismaOverrides?: Partial<ReturnType<typeof makePrismaMock>>,
  configOverrides?: Record<string, number>,
) {
  const prisma = makePrismaMock();
  if (prismaOverrides) Object.assign(prisma, prismaOverrides);
  // Default behaviour: every learningEpisode.create returns a new id.
  prisma.learningEpisode.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: (args.data.id as string | undefined) ?? `ep-${Math.random().toString(36).slice(2, 10)}`,
      ...args.data,
      sessionCount: 0,
      totalActiveSecs: 0,
      endedAt: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
  prisma.studentSession.update.mockResolvedValue({});
  prisma.episodeAudit.create.mockResolvedValue({});

  const service = new EpisodeGroupingService(
    prisma as unknown as PrismaService,
    makeConfig(configOverrides),
  );
  return { service, prisma };
}

const baseInput = {
  sessionId: 'sess-1',
  userId: 'user-1',
  courseId: 'course-1',
  startedAt: new Date('2026-01-01T10:00:00Z'),
  userAgent: 'Mozilla/5.0',
  ipAddress: '203.0.113.5',
};

describe('EpisodeGroupingService.assignEpisodeForSession', () => {
  it('creates a new episode for a user with no prior session', async () => {
    const { service, prisma } = makeService();
    prisma.studentSession.findFirst.mockResolvedValue(null); // no prior

    const result = await service.assignEpisodeForSession(baseInput);

    expect(result.method).toBe('auto_heuristic');
    expect(result.confidence).toBe(1.0);
    expect(prisma.learningEpisode.create).toHaveBeenCalledTimes(1);
    expect(prisma.studentSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { episodeId: result.episodeId },
    });
    // Audit: one "created" + one "session_attached"
    const auditCalls = prisma.episodeAudit.create.mock.calls.map((c) => c[0].data.action);
    expect(auditCalls).toEqual(['created', 'session_attached']);
  });

  it('attaches with confidence 0.95 when prior session is <5min old, same UA', async () => {
    const { service, prisma } = makeService();
    prisma.studentSession.findFirst.mockResolvedValue({
      episodeId: 'ep-existing',
      endedAt: new Date('2026-01-01T09:58:00Z'), // 2 min before
      startedAt: new Date('2026-01-01T09:30:00Z'),
      userAgent: baseInput.userAgent,
      ipAddress: '198.51.100.1', // different IP — irrelevant for tight threshold
    });

    const result = await service.assignEpisodeForSession(baseInput);

    expect(result.episodeId).toBe('ep-existing');
    expect(result.method).toBe('auto_heuristic');
    expect(result.confidence).toBe(0.95);
    expect(prisma.learningEpisode.create).not.toHaveBeenCalled();
  });

  it('attaches with confidence 0.75 when prior session is <15min old, same UA AND IP', async () => {
    const { service, prisma } = makeService();
    prisma.studentSession.findFirst.mockResolvedValue({
      episodeId: 'ep-existing',
      endedAt: new Date('2026-01-01T09:50:00Z'), // 10 min before
      startedAt: new Date('2026-01-01T09:30:00Z'),
      userAgent: baseInput.userAgent,
      ipAddress: baseInput.ipAddress,
    });

    const result = await service.assignEpisodeForSession(baseInput);

    expect(result.episodeId).toBe('ep-existing');
    expect(result.confidence).toBe(0.75);
    expect(prisma.learningEpisode.create).not.toHaveBeenCalled();
  });

  it('creates a new episode when 10min gap but UA differs', async () => {
    const { service, prisma } = makeService();
    prisma.studentSession.findFirst.mockResolvedValue({
      episodeId: 'ep-existing',
      endedAt: new Date('2026-01-01T09:50:00Z'),
      startedAt: new Date('2026-01-01T09:30:00Z'),
      userAgent: 'Different UA',
      ipAddress: baseInput.ipAddress,
    });

    const result = await service.assignEpisodeForSession(baseInput);

    expect(result.confidence).toBe(1.0);
    expect(prisma.learningEpisode.create).toHaveBeenCalledTimes(1);
  });

  it('creates a new episode when gap is 30min', async () => {
    const { service, prisma } = makeService();
    prisma.studentSession.findFirst.mockResolvedValue({
      episodeId: 'ep-old',
      endedAt: new Date('2026-01-01T09:30:00Z'), // 30 min before
      startedAt: new Date('2026-01-01T09:00:00Z'),
      userAgent: baseInput.userAgent,
      ipAddress: baseInput.ipAddress,
    });

    const result = await service.assignEpisodeForSession(baseInput);

    expect(result.confidence).toBe(1.0);
    expect(prisma.learningEpisode.create).toHaveBeenCalledTimes(1);
  });

  it('attaches via clientEpisodeId regardless of gap when episode belongs to same user+course', async () => {
    const { service, prisma } = makeService();
    prisma.learningEpisode.findUnique.mockResolvedValue({
      id: VALID_UUID_V4,
      userId: 'user-1',
      courseId: 'course-1',
    });

    const result = await service.assignEpisodeForSession({
      ...baseInput,
      clientEpisodeId: VALID_UUID_V4,
    });

    expect(result.method).toBe('client_episode_id');
    expect(result.confidence).toBeNull();
    expect(result.episodeId).toBe(VALID_UUID_V4);
    expect(prisma.studentSession.findFirst).not.toHaveBeenCalled(); // didn't reach heuristic
  });

  it('falls through to heuristic when clientEpisodeId belongs to a different user', async () => {
    const { service, prisma } = makeService();
    prisma.learningEpisode.findUnique.mockResolvedValue({
      id: VALID_UUID_V4,
      userId: 'someone-else',
      courseId: 'course-1',
    });
    prisma.studentSession.findFirst.mockResolvedValue(null);

    const result = await service.assignEpisodeForSession({
      ...baseInput,
      clientEpisodeId: VALID_UUID_V4,
    });

    expect(result.method).toBe('auto_heuristic');
    expect(result.confidence).toBe(1.0);
    expect(prisma.learningEpisode.create).toHaveBeenCalledTimes(1);
  });

  it('creates an episode with the client-provided UUID when no matching episode exists', async () => {
    const { service, prisma } = makeService();
    prisma.learningEpisode.findUnique.mockResolvedValue(null);

    const result = await service.assignEpisodeForSession({
      ...baseInput,
      clientEpisodeId: VALID_UUID_V4,
    });

    expect(result.method).toBe('client_episode_id');
    expect(result.episodeId).toBe(VALID_UUID_V4);
    expect(prisma.learningEpisode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: VALID_UUID_V4,
          groupingMethod: 'client_episode_id',
        }),
      }),
    );
  });

  it('falls through to heuristic when clientEpisodeId is malformed', async () => {
    const { service, prisma } = makeService();
    prisma.studentSession.findFirst.mockResolvedValue(null);

    const result = await service.assignEpisodeForSession({
      ...baseInput,
      clientEpisodeId: INVALID_UUID,
    });

    expect(result.method).toBe('auto_heuristic');
    expect(prisma.learningEpisode.findUnique).not.toHaveBeenCalled();
  });

  it('respects ConfigService overrides for thresholds', async () => {
    // Override the loose threshold to 30 minutes — a 20-min gap with same UA+IP
    // should now attach via the loose path.
    const { service, prisma } = makeService(undefined, {
      EPISODE_GAP_MIN_LOOSE: 30,
    });
    prisma.studentSession.findFirst.mockResolvedValue({
      episodeId: 'ep-existing',
      endedAt: new Date('2026-01-01T09:40:00Z'), // 20 min before
      startedAt: new Date('2026-01-01T09:00:00Z'),
      userAgent: baseInput.userAgent,
      ipAddress: baseInput.ipAddress,
    });

    const result = await service.assignEpisodeForSession(baseInput);

    expect(result.episodeId).toBe('ep-existing');
    expect(result.confidence).toBe(0.75);
  });

  it('marks backfill assignments with auto_heuristic_backfill', async () => {
    const { service, prisma } = makeService();
    prisma.studentSession.findFirst.mockResolvedValue(null);

    const result = await service.assignEpisodeForSession({
      ...baseInput,
      isBackfill: true,
    });

    expect(result.method).toBe('auto_heuristic_backfill');
  });
});

describe('EpisodeGroupingService.recomputeEpisodeAggregates', () => {
  it('writes summed durationSecs and max endedAt to the episode', async () => {
    const { service, prisma } = makeService();
    prisma.studentSession.findMany.mockResolvedValue([
      {
        startedAt: new Date('2026-01-01T10:00:00Z'),
        endedAt: new Date('2026-01-01T10:30:00Z'),
        durationSecs: 1800,
      },
      {
        startedAt: new Date('2026-01-01T10:35:00Z'),
        endedAt: new Date('2026-01-01T10:50:00Z'),
        durationSecs: 900,
      },
    ]);

    await service.recomputeEpisodeAggregates('ep-1');

    expect(prisma.learningEpisode.update).toHaveBeenCalledWith({
      where: { id: 'ep-1' },
      data: expect.objectContaining({
        sessionCount: 2,
        totalActiveSecs: 2700,
        startedAt: new Date('2026-01-01T10:00:00Z'),
        endedAt: new Date('2026-01-01T10:50:00Z'),
      }),
    });
  });

  it('zeroes aggregates when no sessions remain attached', async () => {
    const { service, prisma } = makeService();
    prisma.studentSession.findMany.mockResolvedValue([]);

    await service.recomputeEpisodeAggregates('ep-empty');

    expect(prisma.learningEpisode.update).toHaveBeenCalledWith({
      where: { id: 'ep-empty' },
      data: { totalActiveSecs: 0, sessionCount: 0, endedAt: null },
    });
  });
});
