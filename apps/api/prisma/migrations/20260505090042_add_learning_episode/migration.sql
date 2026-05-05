-- AlterTable
ALTER TABLE "student_sessions" ADD COLUMN     "episode_id" UUID;

-- CreateTable
CREATE TABLE "learning_episodes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "total_active_secs" INTEGER NOT NULL DEFAULT 0,
    "session_count" INTEGER NOT NULL DEFAULT 0,
    "grouping_method" TEXT NOT NULL,
    "grouping_confidence" DOUBLE PRECISION,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "learning_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "episode_audits" (
    "id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" UUID,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "episode_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learning_episodes_user_id_course_id_started_at_idx" ON "learning_episodes"("user_id", "course_id", "started_at");

-- CreateIndex
CREATE INDEX "learning_episodes_course_id_started_at_idx" ON "learning_episodes"("course_id", "started_at");

-- CreateIndex
CREATE INDEX "episode_audits_episode_id_created_at_idx" ON "episode_audits"("episode_id", "created_at");

-- CreateIndex
CREATE INDEX "student_sessions_episode_id_idx" ON "student_sessions"("episode_id");

-- AddForeignKey
ALTER TABLE "student_sessions" ADD CONSTRAINT "student_sessions_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "learning_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_episodes" ADD CONSTRAINT "learning_episodes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_episodes" ADD CONSTRAINT "learning_episodes_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_audits" ADD CONSTRAINT "episode_audits_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "learning_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
