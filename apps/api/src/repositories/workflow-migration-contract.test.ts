import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import test from 'node:test';

const migrations = new URL('../../prisma/migrations/', import.meta.url);

function migrationText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`${name}/migration.sql`, migrations)), 'utf8');
}

test('workflow migrations define immutable package identity, review identity, and lease constraints', () => {
  const initial = migrationText('20260712183522_init');
  const hardening = migrationText('20260712200000_harden_workflow_leases');
  const packages = migrationText('20260713130000_bind_reviews_to_packages');

  assert.match(initial, /CREATE TABLE "public"\."Job"/);
  assert.match(initial, /CREATE INDEX "Job_state_availableAt_idx" ON "public"\."Job"\("state", "availableAt"\)/);
  assert.match(initial, /CREATE UNIQUE INDEX "Review_runId_revision_packageChecksum_key"/);
  assert.match(packages, /CREATE TABLE "public"\."PackageVersion"/);
  assert.match(packages, /CREATE UNIQUE INDEX "PackageVersion_runId_revision_packageChecksum_key"/);
  assert.match(packages, /CREATE UNIQUE INDEX "Review_runId_packageChecksum_key"/);
  assert.match(packages, /DROP INDEX "public"\."Review_runId_revision_packageChecksum_key"/);
  assert.match(hardening, /CONSTRAINT "Job_leaseOwner_nonempty"/);
  assert.match(hardening, /length\(btrim\("leaseOwner"\)\) > 0/);
});
