-- Q3: streaming multipart upload for webcam recording.
-- Existing single-PUT segments keep both columns NULL and continue to
-- work via the legacy initiate/complete paths. New segments use
-- CreateMultipartUpload + UploadPart + CompleteMultipartUpload so each
-- 1-second media chunk is durably persisted within seconds of capture
-- (no 50 MB rotation, no full-session blob accumulation).

ALTER TABLE "recording_segments"
  ADD COLUMN "multipart_upload_id" TEXT,
  ADD COLUMN "multipart_parts" JSONB;
