import { Body, Controller, Get, Param, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { EpisodeManagementService } from './episode-management.service';
import { EpisodeExportService } from './episode-export.service';

interface RequestUser {
  id: string;
  role: string;
}

/**
 * Mutation endpoints for the Retrospective-Tracing teacher portal
 * (prompt_retro Stage 6). All routes require the requesting user to own
 * the course (admin bypasses ownership but is still recorded in the audit
 * trail).
 */
@Controller('research')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EpisodeManagementController {
  constructor(
    private readonly service: EpisodeManagementService,
    private readonly exportSvc: EpisodeExportService,
  ) {}

  // POST /api/research/episodes/merge
  @Post('episodes/merge')
  @Roles('teacher', 'admin')
  async merge(
    @Body() body: { episodeIds: string[]; primaryId?: string; reason?: string },
    @Request() req: { user: RequestUser },
  ) {
    return this.service.mergeEpisodes(req.user.id, req.user.role, body);
  }

  // POST /api/research/episodes/:id/split
  @Post('episodes/:id/split')
  @Roles('teacher', 'admin')
  async split(
    @Param('id') id: string,
    @Body() body: { splitAtSessionId: string; reason?: string },
    @Request() req: { user: RequestUser },
  ) {
    return this.service.splitEpisode(req.user.id, req.user.role, id, body);
  }

  // POST /api/research/episodes/:id/detach-session
  @Post('episodes/:id/detach-session')
  @Roles('teacher', 'admin')
  async detach(
    @Param('id') id: string,
    @Body() body: { sessionId: string; targetEpisodeId?: string; reason?: string },
    @Request() req: { user: RequestUser },
  ) {
    return this.service.detachSession(req.user.id, req.user.role, id, body);
  }

  // POST /api/research/episodes/:id/annotate
  @Post('episodes/:id/annotate')
  @Roles('teacher', 'admin')
  async annotate(
    @Param('id') id: string,
    @Body() body: { notes: string },
    @Request() req: { user: RequestUser },
  ) {
    return this.service.annotateEpisode(req.user.id, req.user.role, id, body.notes);
  }

  // GET /api/research/episodes/:id/audit
  @Get('episodes/:id/audit')
  @Roles('teacher', 'admin')
  async audit(@Param('id') id: string, @Request() req: { user: RequestUser }) {
    return this.service.getAudit(req.user.id, req.user.role, id);
  }

  // POST /api/research/episodes/:id/export
  @Post('episodes/:id/export')
  @Roles('teacher', 'admin')
  async createExport(
    @Param('id') id: string,
    @Body()
    body: { modalities: string[]; format: 'csv' | 'jsonl'; includeVideo: boolean },
    @Request() req: { user: RequestUser },
  ) {
    return this.exportSvc.createExport(req.user.id, req.user.role, id, body);
  }

  // GET /api/research/episodes/:id/exports
  @Get('episodes/:id/exports')
  @Roles('teacher', 'admin')
  async listExports(@Param('id') id: string, @Request() req: { user: RequestUser }) {
    return this.exportSvc.listExports(req.user.id, req.user.role, id);
  }
}
