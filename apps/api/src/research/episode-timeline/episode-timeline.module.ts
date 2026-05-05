import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma';
import { BlobModule } from '../../blob';
import { EpisodeTimelineService } from './episode-timeline.service';
import { EpisodeTimelineController } from './episode-timeline.controller';

/**
 * Stage 3 of prompt_retro/. Read-side aggregation API for the teacher portal.
 *
 * - GET /api/research/courses/:courseId/students/:studentId/episodes
 * - GET /api/research/episodes/:id/summary
 * - GET /api/research/episodes/:id/timeline
 */
@Module({
  imports: [PrismaModule, BlobModule],
  controllers: [EpisodeTimelineController],
  providers: [EpisodeTimelineService],
  exports: [EpisodeTimelineService],
})
export class EpisodeTimelineModule {}
