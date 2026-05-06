import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma';
import { BlobModule } from '../../blob';
import { AffectiveMappingModule } from '../../affective-mapping/affective-mapping.module';
import { EpisodeTimelineService } from './episode-timeline.service';
import { EpisodeTimelineController } from './episode-timeline.controller';

/**
 * Stage 3 of prompt_retro/. Read-side aggregation API for the teacher portal.
 *
 * - GET /api/research/courses/:courseId/students/:studentId/episodes
 * - GET /api/research/episodes/:id/summary
 * - GET /api/research/episodes/:id/timeline
 *
 * AffectiveMappingModule is imported so we can run the mapping engine
 * compute-on-read for episodes whose OpenFace3 frames haven't been
 * pushed through the (still-not-wired) writer pipeline yet.
 */
@Module({
  imports: [PrismaModule, BlobModule, AffectiveMappingModule],
  controllers: [EpisodeTimelineController],
  providers: [EpisodeTimelineService],
  exports: [EpisodeTimelineService],
})
export class EpisodeTimelineModule {}
