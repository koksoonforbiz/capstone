import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlobService } from '../blob/blob.service';
import { PyfeatService } from '../pyfeat/pyfeat.service';
import { Openface3Service } from '../openface3/openface3.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityAction } from '../activity-log/activity-action.enum';
import type { RecordingConfig, RecordingSegment } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { RecordingConfigDto } from './dto/recording-config.dto';
import type { CreateSegmentDto } from './dto/create-segment.dto';
import type { CompleteSegmentDto } from './dto/complete-segment.dto';

@Injectable()
export class RecordingService {
  private readonly logger = new Logger(RecordingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    @Inject(forwardRef(() => PyfeatService))
    private readonly pyfeatService: PyfeatService,
    @Inject(forwardRef(() => Openface3Service))
    private readonly openface3Service: Openface3Service,
    private readonly activityLog: ActivityLogService,
  ) {}

  async getConfig(courseId: string): Promise<RecordingConfig> {
    let config = await this.prisma.recordingConfig.findUnique({
      where: { courseId },
    });
    if (!config) {
      config = await this.prisma.recordingConfig.create({
        data: { courseId, isEnabled: true },
      });
    }
    return config;
  }

  async updateConfig(courseId: string, dto: RecordingConfigDto): Promise<RecordingConfig> {
    // Patch only the fields the caller provided. This lets a focused form
    // (e.g. OpenFace3 settings) update its own subset without clobbering
    // the webcam-recording toggle or vice versa.
    const update: Record<string, unknown> = {};
    if (dto.isEnabled !== undefined) update.isEnabled = dto.isEnabled;
    if (dto.openface3Enabled !== undefined) update.openface3Enabled = dto.openface3Enabled;
    if (dto.openface3ExtractionFps !== undefined)
      update.openface3ExtractionFps = dto.openface3ExtractionFps;
    if (dto.openface3DetectorBackend !== undefined)
      update.openface3DetectorBackend = dto.openface3DetectorBackend;
    if (dto.openface3RunOnNewSegments !== undefined)
      update.openface3RunOnNewSegments = dto.openface3RunOnNewSegments;

    return this.prisma.recordingConfig.upsert({
      where: { courseId },
      update,
      create: {
        courseId,
        isEnabled: dto.isEnabled ?? false,
        ...(dto.openface3Enabled !== undefined && { openface3Enabled: dto.openface3Enabled }),
        ...(dto.openface3ExtractionFps !== undefined && {
          openface3ExtractionFps: dto.openface3ExtractionFps,
        }),
        ...(dto.openface3DetectorBackend !== undefined && {
          openface3DetectorBackend: dto.openface3DetectorBackend,
        }),
        ...(dto.openface3RunOnNewSegments !== undefined && {
          openface3RunOnNewSegments: dto.openface3RunOnNewSegments,
        }),
      },
    });
  }

  async initiateSegment(
    studentId: string,
    dto: CreateSegmentDto,
  ): Promise<{ segmentId: string; uploadUrl: string; minioKey: string }> {
    // SECURITY (cross-student leak hotfix): the client passes `sessionId`
    // and `courseId`, but we MUST verify they belong to the requesting
    // student. Otherwise a stale `sessionStorage['ats_session_id']` (e.g.
    // shared classroom computer, race during logout cleanup) could land
    // someone else's webcam segment in this user's session — and the
    // teacher's retrospective-tracing view would then show another
    // student's video. Confirmed in the wild: 2 mis-bound rows existed
    // before this guard. Reject anything that doesn't match.
    const session = await this.prisma.studentSession.findUnique({
      where: { id: dto.sessionId },
      select: { id: true, userId: true, courseId: true, endedAt: true },
    });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (session.userId !== studentId) {
      throw new ForbiddenException('Session does not belong to the requesting user');
    }
    if (session.courseId !== dto.courseId) {
      throw new BadRequestException("courseId does not match the session's course");
    }
    if (session.endedAt) {
      throw new BadRequestException(
        'Session has already ended; refusing to attach a recording segment',
      );
    }

    const now = new Date(dto.startWallTime);
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr =
      now.toISOString().slice(11, 19).replace(/:/g, '') +
      '-' +
      String(now.getMilliseconds()).padStart(3, '0');
    const filename = `${studentId}_${dto.sessionId}_${dateStr}_${timeStr}_${dto.segmentIndex}.webm`;
    const minioKey = `recordings/${dto.courseId}/${studentId}/${dto.sessionId}/${filename}`;

    const segment = await this.prisma.recordingSegment.create({
      data: {
        studentId,
        sessionId: dto.sessionId,
        courseId: dto.courseId,
        minioKey,
        filename,
        startWallTime: now,
        segmentIndex: dto.segmentIndex,
        mimeType: dto.mimeType || 'video/webm',
        uploadStatus: 'PENDING',
      },
    });

    const uploadUrl = await this.blob.getPresignedUploadUrl({
      key: minioKey,
      contentType: dto.mimeType || 'video/webm',
      expiresIn: 7200, // 2 hours
    });

    return { segmentId: segment.id, uploadUrl, minioKey };
  }

  async completeSegment(
    studentId: string,
    segmentId: string,
    dto: CompleteSegmentDto,
  ): Promise<RecordingSegment> {
    const segment = await this.prisma.recordingSegment.findUnique({
      where: { id: segmentId },
    });
    if (!segment) throw new NotFoundException('Segment not found');
    if (segment.studentId !== studentId) {
      // Defense-in-depth — initiate now refuses cross-user attaches, but
      // belt-and-braces in case a future code path ever creates segments
      // with a wrong studentId.
      throw new ForbiddenException('Segment does not belong to the requesting user');
    }

    const updated = await this.prisma.recordingSegment.update({
      where: { id: segmentId },
      data: {
        uploadStatus: 'COMPLETED',
        endWallTime: new Date(dto.endWallTime),
        durationMs: dto.durationMs,
        fileSizeBytes: dto.fileSizeBytes,
      },
    });

    this.logger.log(
      `Segment ${segmentId} completed: ${updated.filename} (${dto.fileSizeBytes} bytes, ${dto.durationMs}ms)`,
    );

    // Log activity
    this.activityLog.record({
      sessionId: updated.sessionId,
      userId: updated.studentId,
      action: ActivityAction.RECORDING_SEGMENT_UPLOADED,
      courseId: updated.courseId,
      metadata: { segmentId, fileSizeBytes: dto.fileSizeBytes, durationMs: dto.durationMs },
    });

    // If py-feat is enabled for this course, auto-enqueue a processing job
    try {
      const pyfeatConfig = await this.pyfeatService.getConfig(updated.courseId);
      if (pyfeatConfig.isEnabled) {
        const job = await this.pyfeatService.enqueueJob({
          studentId: updated.studentId,
          sessionId: updated.sessionId,
          courseId: updated.courseId,
          sourceMinioKey: updated.minioKey,
          clipStartWallTime: updated.startWallTime.toISOString(),
        });
        await this.prisma.recordingSegment.update({
          where: { id: updated.id },
          data: { pyfeatJobId: job.id },
        });
        this.logger.log(`Auto-enqueued py-feat job ${job.id} for segment ${segmentId}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to enqueue py-feat job for segment ${segmentId}: ${err}`);
    }

    // Enqueue OpenFace 3 if enabled for this course
    try {
      const recordingConfig = await this.getConfig(updated.courseId);
      if (recordingConfig.openface3Enabled && recordingConfig.openface3RunOnNewSegments) {
        await this.openface3Service.enqueueJob({
          recordingSegmentId: updated.id,
          sessionId: updated.sessionId,
          studentId: updated.studentId,
          courseId: updated.courseId,
          minioKey: updated.minioKey,
          segmentStartWallMs: updated.startWallTime.getTime(),
          extractionFps: recordingConfig.openface3ExtractionFps,
          detectorBackend: recordingConfig.openface3DetectorBackend,
        });
      } else {
        this.logger.debug(
          `openface3.enqueue.skipped: course=${updated.courseId} enabled=${recordingConfig.openface3Enabled} autoRun=${recordingConfig.openface3RunOnNewSegments}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Failed to enqueue OpenFace 3 job for segment ${segmentId}: ${err}`);
    }

    return updated;
  }

  // ─── Multipart streaming (Q3) ────────────────────────────────────────────

  /**
   * Q3 streaming-recording. Same ownership validation as `initiateSegment`,
   * but creates a multipart upload instead of a single presigned PUT —
   * the client streams 1-second media chunks as parts so the recording
   * is durable in MinIO within seconds of capture, with no in-memory
   * accumulation cap and no 50 MB rotation.
   */
  async initiateMultipartSegment(
    studentId: string,
    dto: CreateSegmentDto,
  ): Promise<{ segmentId: string; uploadId: string; minioKey: string }> {
    // Same cross-student-leak guard as the single-PUT path.
    const session = await this.prisma.studentSession.findUnique({
      where: { id: dto.sessionId },
      select: { id: true, userId: true, courseId: true, endedAt: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== studentId) {
      throw new ForbiddenException('Session does not belong to the requesting user');
    }
    if (session.courseId !== dto.courseId) {
      throw new BadRequestException("courseId does not match the session's course");
    }
    if (session.endedAt) {
      throw new BadRequestException(
        'Session has already ended; refusing to attach a recording segment',
      );
    }

    const now = new Date(dto.startWallTime);
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr =
      now.toISOString().slice(11, 19).replace(/:/g, '') +
      '-' +
      String(now.getMilliseconds()).padStart(3, '0');
    const filename = `${studentId}_${dto.sessionId}_${dateStr}_${timeStr}_${dto.segmentIndex}.webm`;
    const minioKey = `recordings/${dto.courseId}/${studentId}/${dto.sessionId}/${filename}`;
    const contentType = dto.mimeType || 'video/webm';

    const { uploadId } = await this.blob.createMultipartUpload({
      key: minioKey,
      contentType,
    });

    const segment = await this.prisma.recordingSegment.create({
      data: {
        studentId,
        sessionId: dto.sessionId,
        courseId: dto.courseId,
        minioKey,
        filename,
        startWallTime: now,
        segmentIndex: dto.segmentIndex,
        mimeType: contentType,
        uploadStatus: 'PENDING',
        multipartUploadId: uploadId,
        multipartParts: [] as unknown as Prisma.InputJsonValue,
      },
    });

    return { segmentId: segment.id, uploadId, minioKey };
  }

  /** Sign a presigned `UploadPart` URL the client can PUT a single part to.
   *  Each part must be ≥5 MB except the last (S3 multipart spec); the
   *  client buffers chunks until that threshold to keep parts well-formed. */
  async getMultipartPartUrl(
    studentId: string,
    segmentId: string,
    partNumber: number,
  ): Promise<{ uploadUrl: string }> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new BadRequestException('partNumber must be an integer in [1, 10000]');
    }
    const segment = await this.prisma.recordingSegment.findUnique({
      where: { id: segmentId },
      select: {
        studentId: true,
        minioKey: true,
        multipartUploadId: true,
        uploadStatus: true,
      },
    });
    if (!segment) throw new NotFoundException('Segment not found');
    if (segment.studentId !== studentId) {
      throw new ForbiddenException('Segment does not belong to the requesting user');
    }
    if (!segment.multipartUploadId) {
      throw new BadRequestException('Segment was not initialised as a multipart upload');
    }
    if (segment.uploadStatus !== 'PENDING') {
      throw new BadRequestException(
        `Cannot upload parts to a segment in state ${segment.uploadStatus}`,
      );
    }
    const uploadUrl = await this.blob.getPresignedUploadPartUrl({
      key: segment.minioKey,
      uploadId: segment.multipartUploadId,
      partNumber,
      expiresIn: 7200,
    });
    return { uploadUrl };
  }

  /** Finalize a multipart segment. Body carries the parts list (numbers
   *  + ETags from each UploadPart response) plus duration / size. */
  async completeMultipartSegment(
    studentId: string,
    segmentId: string,
    dto: {
      parts: Array<{ partNumber: number; etag: string; sizeBytes: number }>;
      endWallTime: string;
      durationMs: number;
    },
  ): Promise<RecordingSegment> {
    if (!Array.isArray(dto.parts) || dto.parts.length === 0) {
      throw new BadRequestException(
        'parts list must contain at least one part to complete the multipart upload',
      );
    }
    const segment = await this.prisma.recordingSegment.findUnique({
      where: { id: segmentId },
    });
    if (!segment) throw new NotFoundException('Segment not found');
    if (segment.studentId !== studentId) {
      throw new ForbiddenException('Segment does not belong to the requesting user');
    }
    if (!segment.multipartUploadId) {
      throw new BadRequestException('Segment was not initialised as a multipart upload');
    }
    if (segment.uploadStatus !== 'PENDING') {
      throw new BadRequestException(`Cannot complete a segment in state ${segment.uploadStatus}`);
    }

    await this.blob.completeMultipartUpload({
      key: segment.minioKey,
      uploadId: segment.multipartUploadId,
      parts: dto.parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
    });

    const totalBytes = dto.parts.reduce((s, p) => s + (p.sizeBytes || 0), 0);
    const updated = await this.prisma.recordingSegment.update({
      where: { id: segmentId },
      data: {
        uploadStatus: 'COMPLETED',
        endWallTime: new Date(dto.endWallTime),
        durationMs: dto.durationMs,
        fileSizeBytes: totalBytes,
        multipartParts: dto.parts as unknown as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Multipart segment ${segmentId} completed: ${updated.filename} (${dto.parts.length} parts, ${totalBytes} bytes, ${dto.durationMs}ms)`,
    );

    await this.runPostCompletionHooks(updated, totalBytes, dto.durationMs);
    return updated;
  }

  /** Abort an in-progress multipart upload. Called when the client gives
   *  up on a session (recorder error, navigation away). The MinIO object
   *  + part data are dropped; the DB row stays for audit. */
  async abortMultipartSegment(studentId: string, segmentId: string, error?: string): Promise<void> {
    const segment = await this.prisma.recordingSegment.findUnique({
      where: { id: segmentId },
      select: {
        studentId: true,
        minioKey: true,
        multipartUploadId: true,
      },
    });
    if (!segment) throw new NotFoundException('Segment not found');
    if (segment.studentId !== studentId) {
      throw new ForbiddenException('Segment does not belong to the requesting user');
    }
    if (segment.multipartUploadId) {
      await this.blob.abortMultipartUpload({
        key: segment.minioKey,
        uploadId: segment.multipartUploadId,
      });
    }
    await this.prisma.recordingSegment.update({
      where: { id: segmentId },
      data: { uploadStatus: 'FAILED' },
    });
    this.logger.warn(`Multipart segment ${segmentId} aborted${error ? `: ${error}` : ''}`);
  }

  /** Side effects shared by both single-PUT (`completeSegment`) and
   *  streaming (`completeMultipartSegment`) finalization paths. */
  private async runPostCompletionHooks(
    segment: RecordingSegment,
    fileSizeBytes: number,
    durationMs: number,
  ): Promise<void> {
    void this.activityLog.record({
      sessionId: segment.sessionId,
      userId: segment.studentId,
      action: ActivityAction.RECORDING_SEGMENT_UPLOADED,
      courseId: segment.courseId,
      metadata: { segmentId: segment.id, fileSizeBytes, durationMs },
    });

    try {
      const pyfeatConfig = await this.pyfeatService.getConfig(segment.courseId);
      if (pyfeatConfig.isEnabled) {
        const job = await this.pyfeatService.enqueueJob({
          studentId: segment.studentId,
          sessionId: segment.sessionId,
          courseId: segment.courseId,
          sourceMinioKey: segment.minioKey,
          clipStartWallTime: segment.startWallTime.toISOString(),
        });
        await this.prisma.recordingSegment.update({
          where: { id: segment.id },
          data: { pyfeatJobId: job.id },
        });
        this.logger.log(`Auto-enqueued py-feat job ${job.id} for segment ${segment.id}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to enqueue py-feat job for segment ${segment.id}: ${err}`);
    }

    try {
      const recordingConfig = await this.getConfig(segment.courseId);
      if (recordingConfig.openface3Enabled && recordingConfig.openface3RunOnNewSegments) {
        await this.openface3Service.enqueueJob({
          recordingSegmentId: segment.id,
          sessionId: segment.sessionId,
          studentId: segment.studentId,
          courseId: segment.courseId,
          minioKey: segment.minioKey,
          segmentStartWallMs: segment.startWallTime.getTime(),
          extractionFps: recordingConfig.openface3ExtractionFps,
          detectorBackend: recordingConfig.openface3DetectorBackend,
        });
      }
    } catch (err) {
      this.logger.warn(`Failed to enqueue OpenFace 3 job for segment ${segment.id}: ${err}`);
    }
  }

  async failSegment(studentId: string, segmentId: string, error: string): Promise<void> {
    const existing = await this.prisma.recordingSegment.findUnique({
      where: { id: segmentId },
      select: { studentId: true },
    });
    if (!existing) throw new NotFoundException('Segment not found');
    if (existing.studentId !== studentId) {
      throw new ForbiddenException('Segment does not belong to the requesting user');
    }
    const segment = await this.prisma.recordingSegment.update({
      where: { id: segmentId },
      data: { uploadStatus: 'FAILED' },
    });
    this.logger.warn(`Segment ${segmentId} failed: ${error}`);

    this.activityLog.record({
      sessionId: segment.sessionId,
      userId: segment.studentId,
      action: ActivityAction.RECORDING_UPLOAD_FAILED,
      courseId: segment.courseId,
      metadata: { segmentId, error },
    });
  }

  async getSegments(studentId: string, courseId: string): Promise<RecordingSegment[]> {
    return this.prisma.recordingSegment.findMany({
      where: { studentId, courseId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getDownloadUrl(segmentId: string): Promise<string> {
    const segment = await this.prisma.recordingSegment.findUnique({
      where: { id: segmentId },
    });
    if (!segment) throw new NotFoundException('Segment not found');

    return this.blob.getPresignedDownloadUrl({
      key: segment.minioKey,
      expiresIn: 3600,
    });
  }

  // ─── Consent ──────────────────────────────────────────

  async getConsent(studentId: string, courseId: string): Promise<boolean> {
    const consent = await this.prisma.recordingConsent.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    return consent?.accepted ?? false;
  }

  async giveConsent(studentId: string, courseId: string): Promise<void> {
    await this.prisma.recordingConsent.upsert({
      where: { studentId_courseId: { studentId, courseId } },
      update: { accepted: true },
      create: { studentId, courseId, accepted: true },
    });
  }
}
