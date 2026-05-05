import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ActivityLogService } from './activity-log.service';
import { SessionService } from './session.service';
import { SessionReaperService } from './session-reaper.service';
import { LogExportService } from './log-export.service';
import { ActivityLogController } from './activity-log.controller';
import { LearningEpisodeModule } from '../learning-episode/episode-grouping.module';

@Module({
  imports: [ConfigModule, LearningEpisodeModule],
  controllers: [ActivityLogController],
  providers: [ActivityLogService, SessionService, SessionReaperService, LogExportService],
  exports: [ActivityLogService, SessionService],
})
export class ActivityLogModule {}
