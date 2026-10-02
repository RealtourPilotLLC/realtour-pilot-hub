-- PREPARED ONLY. Do not apply to production without the authorized release,
-- verified migration state and current backup coverage. Existing rows stay null;
-- no backfill, historical release/deadline alteration, seed or reset.
ALTER TABLE "ReviewSubmission"
  ADD COLUMN IF NOT EXISTS "portalPublicationRequiredAt" TIMESTAMP(3);
