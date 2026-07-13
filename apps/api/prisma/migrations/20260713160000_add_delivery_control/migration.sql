ALTER TABLE "public"."Delivery"
ADD COLUMN "packageVersionId" TEXT;

UPDATE "public"."Delivery" AS delivery
SET "packageVersionId" = (
  SELECT candidate."id"
  FROM "public"."PackageVersion" AS candidate
  WHERE candidate."runId" = delivery."runId"
    AND candidate."packageChecksum" = delivery."packageChecksum"
  ORDER BY candidate."revision" DESC, candidate."createdAt" DESC
  LIMIT 1
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."Delivery" WHERE "packageVersionId" IS NULL) THEN
    RAISE EXCEPTION 'Historical delivery does not match an immutable package version';
  END IF;
END $$;

ALTER TABLE "public"."Delivery"
ALTER COLUMN "packageVersionId" SET NOT NULL,
ADD CONSTRAINT "Delivery_packageVersionId_fkey"
  FOREIGN KEY ("packageVersionId") REFERENCES "public"."PackageVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Delivery_runId_packageChecksum_key"
ON "public"."Delivery"("runId", "packageChecksum");

CREATE INDEX "Delivery_packageVersionId_idx"
ON "public"."Delivery"("packageVersionId");
