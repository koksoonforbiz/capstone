import { Controller, Get, Post, Patch, Param, Body, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { RecordingService } from './recording.service';
import type { RecordingConfigDto } from './dto/recording-config.dto';
import type { CreateSegmentDto } from './dto/create-segment.dto';
import type { CompleteSegmentDto } from './dto/complete-segment.dto';

interface RequestUser {
  id: string;
  role: string;
}

@Controller('recording')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RecordingController {
  constructor(private readonly recordingService: RecordingService) {}

  // ─── Config (teacher) ─────────────────────────────────

  @Get('config/:courseId')
  @Roles('teacher', 'student')
  getConfig(@Param('courseId') courseId: string) {
    return this.recordingService.getConfig(courseId);
  }

  @Patch('config/:courseId')
  @Roles('teacher')
  updateConfig(@Param('courseId') courseId: string, @Body() dto: RecordingConfigDto) {
    return this.recordingService.updateConfig(courseId, dto);
  }

  // ─── Segments (student) ───────────────────────────────

  @Post('segments/initiate')
  @Roles('student')
  initiateSegment(@Request() req: { user: RequestUser }, @Body() dto: CreateSegmentDto) {
    return this.recordingService.initiateSegment(req.user.id, dto);
  }

  // ─── Multipart streaming (Q3) ─────────────────────────────
  // Same shape as /segments/initiate but creates an S3 multipart upload
  // so 1-second media chunks can be streamed as parts. Eliminates the
  // 50 MB rotation + the in-memory blob accumulation that risked OOMs
  // on long sessions.

  @Post('segments/initiate-multipart')
  @Roles('student')
  initiateMultipartSegment(@Request() req: { user: RequestUser }, @Body() dto: CreateSegmentDto) {
    return this.recordingService.initiateMultipartSegment(req.user.id, dto);
  }

  @Post('segments/:segmentId/part-url')
  @Roles('student')
  getMultipartPartUrl(
    @Request() req: { user: RequestUser },
    @Param('segmentId') segmentId: string,
    @Body() body: { partNumber: number },
  ) {
    return this.recordingService.getMultipartPartUrl(req.user.id, segmentId, body.partNumber);
  }

  @Post('segments/:segmentId/complete-multipart')
  @Roles('student')
  completeMultipartSegment(
    @Request() req: { user: RequestUser },
    @Param('segmentId') segmentId: string,
    @Body()
    body: {
      parts: Array<{ partNumber: number; etag: string; sizeBytes: number }>;
      endWallTime: string;
      durationMs: number;
    },
  ) {
    return this.recordingService.completeMultipartSegment(req.user.id, segmentId, body);
  }

  @Post('segments/:segmentId/abort-multipart')
  @Roles('student')
  abortMultipartSegment(
    @Request() req: { user: RequestUser },
    @Param('segmentId') segmentId: string,
    @Body() body: { error?: string },
  ) {
    return this.recordingService.abortMultipartSegment(req.user.id, segmentId, body.error);
  }

  @Patch('segments/:segmentId/complete')
  @Roles('student')
  completeSegment(
    @Request() req: { user: RequestUser },
    @Param('segmentId') segmentId: string,
    @Body() dto: CompleteSegmentDto,
  ) {
    return this.recordingService.completeSegment(req.user.id, segmentId, dto);
  }

  @Patch('segments/:segmentId/fail')
  @Roles('student')
  failSegment(
    @Request() req: { user: RequestUser },
    @Param('segmentId') segmentId: string,
    @Body() body: { error: string },
  ) {
    return this.recordingService.failSegment(req.user.id, segmentId, body.error);
  }

  // ─── Segments (teacher) ───────────────────────────────

  @Get('segments/:studentId/:courseId')
  @Roles('teacher')
  getSegments(@Param('studentId') studentId: string, @Param('courseId') courseId: string) {
    return this.recordingService.getSegments(studentId, courseId);
  }

  @Get('segments/:segmentId/download')
  @Roles('teacher')
  getDownloadUrl(@Param('segmentId') segmentId: string) {
    return this.recordingService.getDownloadUrl(segmentId);
  }

  // ─── Consent (student) ────────────────────────────────

  @Get('consent/:courseId')
  @Roles('student')
  getConsent(@Request() req: { user: RequestUser }, @Param('courseId') courseId: string) {
    return this.recordingService.getConsent(req.user.id, courseId);
  }

  @Post('consent/:courseId')
  @Roles('student')
  giveConsent(@Request() req: { user: RequestUser }, @Param('courseId') courseId: string) {
    return this.recordingService.giveConsent(req.user.id, courseId);
  }
}
