import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma';
import { LearningEpisodeModule } from '../../learning-episode/episode-grouping.module';
import { EpisodeTimelineModule } from '../episode-timeline/episode-timeline.module';
import { EpisodeManagementService } from './episode-management.service';
import { EpisodeExportService } from './episode-export.service';
import { EpisodeManagementController } from './episode-management.controller';

/**
 * Stage 6 of prompt_retro/. Mutation + export endpoints for the
 * Retrospective-Tracing teacher portal.
 *
 * - POST /api/research/episodes/merge
 * - POST /api/research/episodes/:id/split
 * - POST /api/research/episodes/:id/detach-session
 * - POST /api/research/episodes/:id/annotate
 * - GET  /api/research/episodes/:id/audit
 * - POST /api/research/episodes/:id/export
 * - GET  /api/research/episodes/:id/exports
 */
@Module({
  imports: [PrismaModule, LearningEpisodeModule, EpisodeTimelineModule],
  controllers: [EpisodeManagementController],
  providers: [EpisodeManagementService, EpisodeExportService],
})
export class EpisodeManagementModule {}
