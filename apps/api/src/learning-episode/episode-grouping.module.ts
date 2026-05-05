import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma';
import { EpisodeGroupingService } from './episode-grouping.service';

/**
 * Stage 1 of the prompt_retro/ feature pack. Provides the service that
 * groups freshly-created StudentSession rows into LearningEpisode records.
 *
 * Hooked into apps/api/src/activity-log/session.service.ts via DI — see
 * SessionService.openSession / closeSession.
 */
@Module({
  imports: [PrismaModule, ConfigModule],
  providers: [EpisodeGroupingService],
  exports: [EpisodeGroupingService],
})
export class LearningEpisodeModule {}
