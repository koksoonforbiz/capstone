import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ResolutionSchema,
  TIMELINE_MODALITIES,
  type Resolution,
  type TimelineModality,
} from '@ats/shared';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { EpisodeTimelineService } from './episode-timeline.service';

interface RequestUser {
  id: string;
  role: string;
}

/**
 * GET endpoints for the Retrospective-Tracing teacher portal (prompt_retro
 * Stage 3). All routes are read-only; mutation comes in Stage 6.
 *
 * Authorization: teacher must own the course (or be admin). Enforced inside
 * the service so the controller stays thin.
 */
@Controller('research')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EpisodeTimelineController {
  constructor(private readonly service: EpisodeTimelineService) {}

  // GET /api/research/courses/:courseId/students/:studentId/episodes
  @Get('courses/:courseId/students/:studentId/episodes')
  @Roles('teacher', 'admin')
  async listEpisodes(
    @Param('courseId') courseId: string,
    @Param('studentId') studentId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Request() req?: { user: RequestUser },
  ) {
    return this.service.listEpisodes(req!.user.id, req!.user.role, courseId, studentId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  // GET /api/research/episodes/:id/summary
  @Get('episodes/:id/summary')
  @Roles('teacher', 'admin')
  async getSummary(@Param('id') id: string, @Request() req: { user: RequestUser }) {
    return this.service.getSummary(req.user.id, req.user.role, id);
  }

  // GET /api/research/episodes/:id/timeline
  @Get('episodes/:id/timeline')
  @Roles('teacher', 'admin')
  async getTimeline(
    @Param('id') id: string,
    @Request() req: { user: RequestUser },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('resolution') resolution?: string,
    @Query('modalities') modalities?: string,
  ) {
    const parsedResolution: Resolution = resolution ? this.parseResolution(resolution) : 'medium';

    const parsedModalities: TimelineModality[] | undefined = modalities
      ? this.parseModalities(modalities)
      : undefined;

    return this.service.getTimeline(req.user.id, req.user.role, id, {
      fromMs: from !== undefined ? this.parseInt(from, 'from') : undefined,
      toMs: to !== undefined ? this.parseInt(to, 'to') : undefined,
      resolution: parsedResolution,
      modalities: parsedModalities,
    });
  }

  // ─── parsing helpers ────────────────────────────────────────────────────

  private parseResolution(value: string): Resolution {
    const result = ResolutionSchema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        `Invalid resolution "${value}". Must be one of: raw, high, medium, low.`,
      );
    }
    return result.data;
  }

  private parseModalities(value: string): TimelineModality[] {
    const parts = value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const valid = TIMELINE_MODALITIES as readonly string[];
    const invalid = parts.filter((p) => !valid.includes(p));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid modalities: ${invalid.join(', ')}. Valid: ${TIMELINE_MODALITIES.join(', ')}.`,
      );
    }
    return parts as TimelineModality[];
  }

  private parseInt(value: string, name: string): number {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) {
      throw new BadRequestException(`Invalid ${name}="${value}" — must be a number`);
    }
    return n;
  }
}
