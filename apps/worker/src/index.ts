import { HttpEngineClient } from './engine-client.js';
import { WorkerExecutor } from './executor.js';
import { composeWorkerProviders } from './runtime.js';
import { runWorkerTick } from './tick.js';

const baseUrl = requiredEnvironment('ENGINE_API_BASE_URL');
const workerToken = requiredEnvironment('ENGINE_WORKER_TOKEN');
const leaseSeconds = positiveInteger('ENGINE_WORKER_LEASE_SECONDS', process.env.ENGINE_WORKER_LEASE_SECONDS ?? '90');
const maxJobs = positiveInteger('ENGINE_WORKER_MAX_JOBS_PER_TICK', process.env.ENGINE_WORKER_MAX_JOBS_PER_TICK ?? '6');
const maxDurationSeconds = positiveInteger(
  'ENGINE_WORKER_TICK_SECONDS',
  process.env.ENGINE_WORKER_TICK_SECONDS ?? '2700',
);

const client = new HttpEngineClient({ baseUrl, workerToken });
const executor = new WorkerExecutor({ client, providers: composeWorkerProviders({ env: process.env, engineClient: client }) });
const tickStartedAt = Date.now();
console.log(JSON.stringify({
  event: 'worker_tick_started',
  at: new Date(tickStartedAt).toISOString(),
  maxJobs,
  maxDurationSeconds,
  preferredRunId: optionalUuidEnvironment('ENGINE_WORKER_PREFERRED_RUN_ID') ?? null,
}));
const result = await runWorkerTick({
  client,
  executor,
  leaseSeconds,
  maxJobs,
  maxDurationMs: maxDurationSeconds * 1_000,
  preferredRunId: optionalUuidEnvironment('ENGINE_WORKER_PREFERRED_RUN_ID'),
});
console.log(JSON.stringify({
  event: 'worker_tick_completed',
  at: new Date().toISOString(),
  durationMs: Date.now() - tickStartedAt,
  ...result,
}));

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function optionalUuidEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}
