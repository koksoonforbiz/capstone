-- prompt_retro Stage 6: episode soft-delete + audit
-- Soft-deleted episodes survive merges so researcher citations remain
-- resolvable.

ALTER TABLE "learning_episodes"
  ADD COLUMN "deleted_at" TIMESTAMPTZ;

CREATE INDEX "learning_episodes_deleted_at_idx" ON "learning_episodes" ("deleted_at");
