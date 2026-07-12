ALTER TABLE "public"."Run"
ADD COLUMN "packageChecksum" TEXT,
ADD COLUMN "approvedChecksum" TEXT,
ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'pending';
