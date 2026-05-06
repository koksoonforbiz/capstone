import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma';
import { RagModule } from '../rag';
import { ActivityLogModule } from '../activity-log';
import { LearningInterventionsController } from './learning-interventions.controller';
import { LearningInterventionsService } from './learning-interventions.service';

@Module({
  // RagModule is imported because it also provides LlmService (the
  // shared LLM client). The service intentionally does NOT inject
  // `RagService` — see learning-interventions.service.ts. Dialogue-based
  // learning grounds only on each student's own uploaded materials
  // (`student_rag_chunks`), never on the teacher's course-level corpus
  // (`document_chunks`).
  imports: [PrismaModule, RagModule, ActivityLogModule],
  controllers: [LearningInterventionsController],
  providers: [LearningInterventionsService],
  exports: [LearningInterventionsService],
})
export class LearningInterventionsModule {}
