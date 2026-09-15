import type { JobClaim } from '@knowledge-bits/contracts';

import type { WorkerEngineClient } from './engine-client.js';

export interface TickExecutor {
  execute(job: JobClaim): Promise<void>;
}

export interface WorkerTickOptions {
  client: Pick<WorkerEngineClient, 'claim'>;
  executor: TickExecutor;
  leaseSeconds: number;
  maxJobs: number;
  maxDurationMs: number;
  preferredRunId?: string;
  now?: () => number;
}

export interface WorkerTickResult {
  runId: string | null;
  jobsProcessed: number;
  stoppedBecause: 'no_eligible_job' | 'job_limit' | 'time_limit';
}

export async function runWorkerTick(options: WorkerTickOptions): Promise<WorkerTickResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let runId = options.preferredRunId;
  let jobsProcessed = 0;

  while (jobsProcessed < options.maxJobs) {
    if (now() - startedAt >= options.maxDurationMs) {
      return { runId: runId ?? null, jobsProcessed, stoppedBecause: 'time_limit' };
    }

    const job = await options.client.claim(options.leaseSeconds, runId);
    if (!job) {
      return { runId: runId ?? null, jobsProcessed, stoppedBecause: 'no_eligible_job' };
    }

    runId ??= job.packageId;
    await options.executor.execute(job);
    jobsProcessed += 1;
  }

  return { runId: runId ?? null, jobsProcessed, stoppedBecause: 'job_limit' };
}
