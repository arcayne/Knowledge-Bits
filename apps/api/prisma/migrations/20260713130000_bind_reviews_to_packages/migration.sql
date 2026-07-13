DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."Review" AS left_review
    INNER JOIN "public"."Review" AS right_review
      ON left_review."runId" = right_review."runId"
      AND left_review."packageChecksum" = right_review."packageChecksum"
      AND left_review."id" < right_review."id"
    WHERE left_review."decision" IS DISTINCT FROM right_review."decision"
      OR left_review."reviewerId" IS DISTINCT FROM right_review."reviewerId"
      OR left_review."comment" IS DISTINCT FROM right_review."comment"
  ) THEN
    RAISE EXCEPTION 'Conflicting historical reviews for the same immutable package';
  END IF;
END $$;

WITH ranked_reviews AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "runId", "packageChecksum"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS duplicate_rank
  FROM "public"."Review"
)
DELETE FROM "public"."Review"
USING ranked_reviews
WHERE "Review"."id" = ranked_reviews."id"
  AND ranked_reviews.duplicate_rank > 1;

DROP INDEX "public"."Review_runId_revision_packageChecksum_key";

CREATE UNIQUE INDEX "Review_runId_packageChecksum_key"
ON "public"."Review"("runId", "packageChecksum");

ALTER TABLE "public"."Artifact"
ADD COLUMN "jobId" TEXT,
ADD COLUMN "stage" TEXT,
ADD COLUMN "action" TEXT;

CREATE INDEX "Artifact_runId_revision_stage_jobId_idx"
ON "public"."Artifact"("runId", "revision", "stage", "jobId");

ALTER TABLE "public"."Artifact"
ADD CONSTRAINT "Artifact_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "public"."Job"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "public"."PackageVersion" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "packageChecksum" TEXT NOT NULL,
  "adapterVersion" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "usageRights" JSONB NOT NULL,
  "content" JSONB NOT NULL,
  "evidence" JSONB NOT NULL,
  "qa" JSONB NOT NULL,
  "artifactInventory" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PackageVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PackageVersion_runId_revision_packageChecksum_key"
ON "public"."PackageVersion"("runId", "revision", "packageChecksum");

CREATE INDEX "PackageVersion_runId_packageChecksum_idx"
ON "public"."PackageVersion"("runId", "packageChecksum");

ALTER TABLE "public"."PackageVersion"
ADD CONSTRAINT "PackageVersion_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "public"."Run"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
