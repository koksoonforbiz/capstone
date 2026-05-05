-- CreateIndex
CREATE INDEX "pupil_size_logs_session_id_timestamp_idx" ON "pupil_size_logs"("session_id", "timestamp");

-- CreateIndex
CREATE INDEX "recording_segments_session_id_start_wall_time_idx" ON "recording_segments"("session_id", "start_wall_time");

-- CreateIndex
CREATE INDEX "webgazer_logs_session_id_timestamp_idx" ON "webgazer_logs"("session_id", "timestamp");
