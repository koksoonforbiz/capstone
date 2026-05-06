-- Adds studentSessionId to ef_detections so the retrospective tracing
-- timeline aggregator (which keys every lane by StudentSession.id) can
-- surface EF detections alongside activity logs / gaze / video. The
-- existing sessionId column continues to hold DialogueSession.id and
-- powers the live teacher dashboard.

ALTER TABLE "ef_detections" ADD COLUMN "studentSessionId" TEXT;

CREATE INDEX "ef_detections_studentSessionId_constructKey_created_at_idx"
  ON "ef_detections" ("studentSessionId", "constructKey", "created_at");
