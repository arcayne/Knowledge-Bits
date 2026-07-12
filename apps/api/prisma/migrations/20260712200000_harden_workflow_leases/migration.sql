ALTER TABLE "public"."Job"
ADD CONSTRAINT "Job_leaseOwner_nonempty"
CHECK ("leaseOwner" IS NULL OR length(btrim("leaseOwner")) > 0);
