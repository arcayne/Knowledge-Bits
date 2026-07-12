ALTER TABLE "public"."Stage"
ADD COLUMN "revisionAttempt" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "public"."Job"
ADD COLUMN "completionReceipt" JSONB;

CREATE TABLE "public"."WorkflowEffect" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "effectKey" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WorkflowEffect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowEffect_effectKey_key" ON "public"."WorkflowEffect"("effectKey");
CREATE INDEX "WorkflowEffect_runId_createdAt_idx" ON "public"."WorkflowEffect"("runId", "createdAt");

ALTER TABLE "public"."WorkflowEffect"
ADD CONSTRAINT "WorkflowEffect_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
