import { randomUUID } from 'crypto';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { TimelineModality, TimelinePayload } from '@ats/shared';
import { TIMELINE_MODALITIES } from '@ats/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { EpisodeTimelineService } from '../episode-timeline/episode-timeline.service';

type ExportFormat = 'csv' | 'jsonl';

interface ExportInput {
  modalities: string[];
  format: ExportFormat;
  includeVideo: boolean;
}

interface ExportFileEntry {
  modality: string;
  key: string;
  signedUrl: string;
  rowCount: number;
  format: ExportFormat;
}

interface ExportManifest {
  exportId: string;
  episodeId: string;
  format: ExportFormat;
  modalities: string[];
  includeVideo: boolean;
  createdAt: string;
  createdBy: { id: string; name: string | null };
  files: ExportFileEntry[];
  videoManifestKey?: string;
  videoManifestSignedUrl?: string;
}

const SIGNED_URL_TTL_SECS = 24 * 60 * 60;

/**
 * Episode-scoped CSV/JSONL export (prompt_retro Stage 6).
 *
 * Writes one file per modality to MinIO under
 *   `log-exports/episodes/{episodeId}/{exportId}/`
 * along with an `episode.json` metadata file and (optionally) a
 * `video_manifest.json` with 24h-TTL signed URLs to all `RecordingSegment`s.
 *
 * The pipeline is synchronous — there's no job-queue infrastructure in
 * this monorepo and the Stage-3 timeline service already runs all lane
 * queries in parallel, so a single API request can produce the full
 * bundle in a few seconds even for hour-long episodes. If exports later
 * become slow (e.g. raw resolution + dozens of sessions), the fix is to
 * lift the timeline-service queries onto a worker queue, not to add a
 * job table here.
 */
@Injectable()
export class EpisodeExportService {
  private readonly logger = new Logger(EpisodeExportService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly timeline: EpisodeTimelineService,
  ) {
    this.s3 = new S3Client({
      endpoint: config.get<string>('MINIO_ENDPOINT', 'http://localhost:9000'),
      region: 'us-east-1',
      credentials: {
        accessKeyId: config.get<string>('MINIO_ACCESS_KEY', 'minioadmin'),
        secretAccessKey: config.get<string>('MINIO_SECRET_KEY', 'minioadmin'),
      },
      forcePathStyle: true,
    });
    this.bucket = config.get<string>('MINIO_LOG_BUCKET', 'student-logs');
  }

  // ─── Bucket bootstrap ───────────────────────────────────────────────────

  /** Lazily create the `MINIO_LOG_BUCKET` if it doesn't exist yet. The
   *  hotfix that uncovered this: the bucket was never provisioned in dev
   *  so every export was failing with NoSuchBucket. Mirrors BlobService's
   *  ensureBucket pattern. Idempotent + cheap — single HeadBucket call. */
  private bucketReadyPromise: Promise<void> | null = null;
  private ensureBucket(): Promise<void> {
    if (!this.bucketReadyPromise) {
      this.bucketReadyPromise = (async () => {
        try {
          await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
        } catch (err: unknown) {
          const status =
            (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0;
          if (status === 404 || status === 403) {
            this.logger.log(`Creating MinIO bucket "${this.bucket}" (was missing).`);
            try {
              await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
            } catch (createErr: unknown) {
              // Another concurrent createExport may have created it — re-head.
              try {
                await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
              } catch {
                this.bucketReadyPromise = null; // allow retry next time
                throw createErr;
              }
            }
          } else {
            this.bucketReadyPromise = null;
            throw err;
          }
        }
      })();
    }
    return this.bucketReadyPromise;
  }

  // ─── Create export ──────────────────────────────────────────────────────

  async createExport(
    actorUserId: string,
    actorRole: string,
    episodeId: string,
    input: ExportInput,
  ): Promise<ExportManifest> {
    if (!['csv', 'jsonl'].includes(input.format)) {
      throw new Error(`Invalid format: ${input.format}`);
    }
    await this.ensureBucket();
    const episode = await this.loadEpisodeOwned(actorUserId, actorRole, episodeId);

    // Always pull at raw resolution — exports should not silently downsample.
    const modalities = this.normalizeModalities(input.modalities);
    const payload = await this.timeline.getTimeline(actorUserId, actorRole, episodeId, {
      resolution: 'raw',
      modalities,
    });

    const exportId = randomUUID();
    const prefix = `log-exports/episodes/${episodeId}/${exportId}`;

    // Write per-lane files.
    const files: ExportFileEntry[] = [];
    const lanes = payload.lanes;
    const laneEntries: Array<[string, unknown[]]> = [];

    if (modalities.includes('activity')) laneEntries.push(['activity', lanes.activity ?? []]);
    if (modalities.includes('gaze')) laneEntries.push(['gaze', lanes.gaze ?? []]);
    if (modalities.includes('pupil')) laneEntries.push(['pupil', lanes.pupil ?? []]);
    if (modalities.includes('emotion')) laneEntries.push(['emotion', lanes.emotion ?? []]);
    if (modalities.includes('au')) laneEntries.push(['au', lanes.au ?? []]);
    if (modalities.includes('affective_state'))
      laneEntries.push(['affective_state', lanes.affective ?? []]);
    if (modalities.includes('derived')) {
      laneEntries.push(['derived_engagement', lanes.derived?.engagement ?? []]);
      laneEntries.push(['derived_cognitive_load', lanes.derived?.cognitiveLoad ?? []]);
    }
    if (modalities.includes('at_risk')) laneEntries.push(['at_risk', lanes.atRisk ?? []]);
    if (modalities.includes('ef_detection'))
      laneEntries.push(['ef_detection', lanes.efDetection ?? []]);
    if (modalities.includes('click')) laneEntries.push(['click', lanes.click ?? []]);
    if (modalities.includes('scroll')) laneEntries.push(['scroll', lanes.scroll ?? []]);
    if (modalities.includes('cursor')) laneEntries.push(['cursor', lanes.cursor ?? []]);
    if (modalities.includes('visibility')) laneEntries.push(['visibility', lanes.visibility ?? []]);
    if (modalities.includes('error')) laneEntries.push(['error', lanes.error ?? []]);

    for (const [modality, rows] of laneEntries) {
      const ext = input.format === 'csv' ? 'csv' : 'jsonl';
      const key = `${prefix}/${modality}.${ext}`;
      const body = input.format === 'csv' ? this.toCsv(rows) : this.toJsonl(rows);
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType:
            input.format === 'csv'
              ? 'text/csv; charset=utf-8'
              : 'application/x-ndjson; charset=utf-8',
        }),
      );
      const url = await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: SIGNED_URL_TTL_SECS },
      );
      files.push({
        modality,
        key,
        signedUrl: url,
        rowCount: rows.length,
        format: input.format,
      });
    }

    // Write episode.json with metadata + sessions + audit summary.
    const audits = await this.prisma.episodeAudit.findMany({
      where: { episodeId },
      orderBy: { createdAt: 'asc' },
    });
    const episodeMeta = {
      episode: payload.episode,
      sessionBoundaries: payload.sessionBoundaries,
      meta: payload.meta,
      audits: audits.map((a) => ({
        action: a.action,
        actorUserId: a.actorUserId,
        payload: a.payload,
        createdAt: a.createdAt.toISOString(),
      })),
      notes: episode.notes,
    };
    const metaKey = `${prefix}/episode.json`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: metaKey,
        Body: JSON.stringify(episodeMeta, null, 2),
        ContentType: 'application/json',
      }),
    );
    const metaUrl = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: metaKey }),
      { expiresIn: SIGNED_URL_TTL_SECS },
    );
    files.push({
      modality: 'episode_metadata',
      key: metaKey,
      signedUrl: metaUrl,
      rowCount: 1,
      format: 'jsonl' as ExportFormat,
    });

    // Optional video manifest.
    let videoManifestKey: string | undefined;
    let videoManifestSignedUrl: string | undefined;
    if (input.includeVideo) {
      const videoManifest = await this.buildVideoManifest(payload);
      videoManifestKey = `${prefix}/video_manifest.json`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: videoManifestKey,
          Body: JSON.stringify(videoManifest, null, 2),
          ContentType: 'application/json',
        }),
      );
      videoManifestSignedUrl = await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: videoManifestKey }),
        { expiresIn: SIGNED_URL_TTL_SECS },
      );
    }

    // Build + persist the manifest itself, so future GET /exports can list
    // them by reading manifests.
    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { id: true, name: true },
    });
    const manifest: ExportManifest = {
      exportId,
      episodeId,
      format: input.format,
      modalities,
      includeVideo: input.includeVideo,
      createdAt: new Date().toISOString(),
      createdBy: { id: actorUserId, name: actor?.name ?? null },
      files,
      videoManifestKey,
      videoManifestSignedUrl,
    };
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${prefix}/manifest.json`,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: 'application/json',
      }),
    );

    this.logger.log(
      `Exported episode ${episodeId} → ${prefix} (${files.length} files, video=${input.includeVideo})`,
    );
    return manifest;
  }

  // ─── List previous exports ──────────────────────────────────────────────

  async listExports(
    actorUserId: string,
    actorRole: string,
    episodeId: string,
  ): Promise<
    Array<{
      exportId: string;
      createdAt: string;
      format: ExportFormat;
      modalities: string[];
      includeVideo: boolean;
      fileCount: number;
      manifestSignedUrl: string;
    }>
  > {
    await this.loadEpisodeOwned(actorUserId, actorRole, episodeId);
    await this.ensureBucket();

    const prefix = `log-exports/episodes/${episodeId}/`;
    const list = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );
    const manifestKeys = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => !!k && k.endsWith('/manifest.json'));

    const manifests = await Promise.all(
      manifestKeys.map(async (key) => {
        try {
          const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
          const body = await obj.Body?.transformToString();
          if (!body) return null;
          const m = JSON.parse(body) as ExportManifest;
          const url = await getSignedUrl(
            this.s3,
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
            { expiresIn: SIGNED_URL_TTL_SECS },
          );
          return {
            exportId: m.exportId,
            createdAt: m.createdAt,
            format: m.format,
            modalities: m.modalities,
            includeVideo: m.includeVideo,
            fileCount: m.files.length,
            manifestSignedUrl: url,
          };
        } catch (err) {
          this.logger.warn(`Failed to load manifest ${key}: ${(err as Error).message}`);
          return null;
        }
      }),
    );
    return manifests
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private normalizeModalities(input: string[]): TimelineModality[] {
    const valid = TIMELINE_MODALITIES as readonly string[];
    const filtered = input.filter((m) => valid.includes(m));
    if (filtered.length === 0) {
      // Default to "everything except video" — video is opt-in via includeVideo.
      return TIMELINE_MODALITIES.filter((m) => m !== 'video') as TimelineModality[];
    }
    return filtered as TimelineModality[];
  }

  private async loadEpisodeOwned(actorUserId: string, actorRole: string, episodeId: string) {
    const episode = await this.prisma.learningEpisode.findUnique({
      where: { id: episodeId },
      select: {
        id: true,
        userId: true,
        courseId: true,
        notes: true,
        deletedAt: true,
        course: { select: { teacherId: true } },
      },
    });
    if (!episode || episode.deletedAt) {
      throw new NotFoundException('Episode not found.');
    }
    if (actorRole !== 'admin' && episode.course.teacherId !== actorUserId) {
      throw new ForbiddenException('Episode belongs to another teacher.');
    }
    return episode;
  }

  private async buildVideoManifest(payload: TimelinePayload) {
    return {
      episodeId: payload.episode.id,
      generatedAt: new Date().toISOString(),
      ttlSeconds: SIGNED_URL_TTL_SECS,
      segments: payload.video.segments.map((s) => ({
        id: s.id,
        sessionId: s.sessionId,
        minioKey: s.minioKey,
        signedUrl: s.signedUrl,
        startMs: s.startMs,
        endMs: s.endMs,
        durationMs: s.durationMs,
        fileSizeBytes: s.fileSizeBytes,
      })),
      totalDurationMs: payload.video.totalDurationMs,
    };
  }

  // ─── Format helpers ─────────────────────────────────────────────────────

  private toJsonl(rows: unknown[]): string {
    return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  }

  /**
   * Naive flat-CSV from an array of plain objects. Handles nested
   * objects/arrays by JSON-stringifying that single cell. Escapes quotes
   * + commas + newlines per RFC 4180.
   */
  private toCsv(rows: unknown[]): string {
    if (rows.length === 0) return '';
    const allKeys = new Set<string>();
    for (const r of rows) {
      if (r && typeof r === 'object') {
        for (const k of Object.keys(r as Record<string, unknown>)) allKeys.add(k);
      }
    }
    const headers = Array.from(allKeys);
    const escape = (cell: unknown): string => {
      if (cell === null || cell === undefined) return '';
      const s = typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
      if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const lines: string[] = [];
    lines.push(headers.map((h) => escape(h)).join(','));
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      lines.push(headers.map((h) => escape(row[h])).join(','));
    }
    return lines.join('\n') + '\n';
  }
}
