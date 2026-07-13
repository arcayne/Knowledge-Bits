ALTER TABLE "public"."Delivery"
ADD COLUMN "packageVersionId" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."Delivery" AS delivery
    WHERE NOT EXISTS (
      SELECT 1
      FROM "public"."PackageVersion" AS candidate
      WHERE candidate."runId" = delivery."runId"
        AND candidate."packageChecksum" = delivery."packageChecksum"
    )
  ) THEN
    RAISE EXCEPTION 'Historical delivery does not match an immutable package version';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."Delivery" AS delivery
    WHERE (
      SELECT COUNT(*)
      FROM "public"."PackageVersion" AS candidate
      WHERE candidate."runId" = delivery."runId"
        AND candidate."packageChecksum" = delivery."packageChecksum"
    ) > 1
  ) THEN
    RAISE EXCEPTION 'Ambiguous historical delivery package version match';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "public"."Delivery" AS left_delivery
    INNER JOIN "public"."Delivery" AS right_delivery
      ON left_delivery."runId" = right_delivery."runId"
      AND left_delivery."packageChecksum" = right_delivery."packageChecksum"
      AND left_delivery."id" < right_delivery."id"
    WHERE left_delivery."target" IS DISTINCT FROM right_delivery."target"
      OR left_delivery."state" IS DISTINCT FROM right_delivery."state"
      OR left_delivery."attempts" IS DISTINCT FROM right_delivery."attempts"
      OR left_delivery."response" IS DISTINCT FROM right_delivery."response"
      OR left_delivery."nextAttemptAt" IS DISTINCT FROM right_delivery."nextAttemptAt"
      OR NOT (
        (
          left_delivery."state" = 'queued'
          AND left_delivery."attempts" = 0
          AND left_delivery."response" IS NULL
        )
        OR NULLIF(left_delivery."response"->>'externalId', '') IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Conflicting historical deliveries for the same immutable package';
  END IF;
END $$;

-- Equivalent duplicates have identical operational fields and are either
-- untouched queued rows or share a persisted external ID. Keep the earliest
-- created row, breaking ties by ID, and repoint historical job payloads to it.
WITH ranked_deliveries AS (
  SELECT
    "id",
    FIRST_VALUE("id") OVER (
      PARTITION BY "runId", "packageChecksum"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS canonical_id,
    ROW_NUMBER() OVER (
      PARTITION BY "runId", "packageChecksum"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS duplicate_rank
  FROM "public"."Delivery"
)
UPDATE "public"."Job"
SET "input" = jsonb_set("Job"."input", '{deliveryId}', to_jsonb(ranked_deliveries.canonical_id), false)
FROM ranked_deliveries
WHERE ranked_deliveries.duplicate_rank > 1
  AND "Job"."input"->>'deliveryId' = ranked_deliveries."id";

WITH ranked_deliveries AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "runId", "packageChecksum"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS duplicate_rank
  FROM "public"."Delivery"
)
DELETE FROM "public"."Delivery"
USING ranked_deliveries
WHERE "Delivery"."id" = ranked_deliveries."id"
  AND ranked_deliveries.duplicate_rank > 1;

UPDATE "public"."Delivery" AS delivery
SET "packageVersionId" = candidate."id"
FROM "public"."PackageVersion" AS candidate
WHERE candidate."runId" = delivery."runId"
  AND candidate."packageChecksum" = delivery."packageChecksum";

ALTER TABLE "public"."Delivery"
ALTER COLUMN "packageVersionId" SET NOT NULL,
ADD CONSTRAINT "Delivery_packageVersionId_fkey"
  FOREIGN KEY ("packageVersionId") REFERENCES "public"."PackageVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Delivery_runId_packageChecksum_key"
ON "public"."Delivery"("runId", "packageChecksum");

CREATE INDEX "Delivery_packageVersionId_idx"
ON "public"."Delivery"("packageVersionId");
