import assert from 'node:assert/strict';
import test from 'node:test';

import type { JobClaim } from '@knowledge-bits/contracts';

import { runWorkerTick } from './tick.js';

const firstRunId = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('processes consecutive stages for one run in a single tick', async () => {
  const jobs = [job('research', 1), job('create', 2), job('check', 3), job('produce_assets', 4)];
  const preferredRunIds: Array<string | undefined> = [];
  const executed: string[] = [];

  const result = await runWorkerTick({
    client: {
      async claim(_leaseSeconds, preferredRunId) {
        preferredRunIds.push(preferredRunId);
        return jobs.shift() ?? null;
      },
    },
    executor: { async execute(claim) { executed.push(claim.stage); } },
    leaseSeconds: 90,
    maxJobs: 6,
    maxDurationMs: 60_000,
  });

  assert.deepEqual(executed, ['research', 'create', 'check', 'produce_assets']);
  assert.deepEqual(preferredRunIds, [undefined, firstRunId, firstRunId, firstRunId, firstRunId]);
  assert.deepEqual(result, { runId: firstRunId, jobsProcessed: 4, stoppedBecause: 'no_eligible_job' });
});

test('does not claim beyond the configured job budget', async () => {
  let claims = 0;
  const result = await runWorkerTick({
    client: { async claim() { claims += 1; return job('research', claims); } },
    executor: { async execute() {} },
    leaseSeconds: 90,
    maxJobs: 2,
    maxDurationMs: 60_000,
  });

  assert.equal(claims, 2);
  assert.equal(result.jobsProcessed, 2);
  assert.equal(result.stoppedBecause, 'job_limit');
});

test('can target one run from the first claim', async () => {
  const preferredRunId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const preferredRunIds: Array<string | undefined> = [];
  const result = await runWorkerTick({
    client: {
      async claim(_leaseSeconds, runId) {
        preferredRunIds.push(runId);
        return null;
      },
    },
    executor: { async execute() {} },
    leaseSeconds: 90,
    maxJobs: 2,
    maxDurationMs: 60_000,
    preferredRunId,
  });

  assert.deepEqual(preferredRunIds, [preferredRunId]);
  assert.deepEqual(result, { runId: preferredRunId, jobsProcessed: 0, stoppedBecause: 'no_eligible_job' });
});

function job(stage: JobClaim['stage'], attempt: number): JobClaim {
  return {
    jobId: `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`,
    packageId: firstRunId,
    stage,
    claimedBy: 'local-worker',
    claimedAt: '2026-07-22T10:00:00.000Z',
    leaseExpiresAt: '2026-07-22T10:01:30.000Z',
    executionDeadlineAt: '2026-07-22T10:20:00.000Z',
    attempt,
    revision: 1,
    input: {},
  };
}
