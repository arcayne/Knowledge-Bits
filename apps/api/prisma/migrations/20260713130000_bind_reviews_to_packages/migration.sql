DROP INDEX "public"."Review_runId_revision_packageChecksum_key";

CREATE UNIQUE INDEX "Review_runId_packageChecksum_key"
ON "public"."Review"("runId", "packageChecksum");

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
