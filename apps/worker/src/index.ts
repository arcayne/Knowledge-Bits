import { HttpEngineClient } from './engine-client.js';
import { WorkerExecutor } from './executor.js';
import { FixtureProvider } from './providers/fixture.js';

const baseUrl = requiredEnvironment('ENGINE_API_BASE_URL');
const workerToken = requiredEnvironment('ENGINE_WORKER_TOKEN');
const leaseSeconds = positiveInteger(process.env.ENGINE_WORKER_LEASE_SECONDS ?? '90');

const client = new HttpEngineClient({ baseUrl, workerToken });
const executor = new WorkerExecutor({ client, providers: [new FixtureProvider()] });
const job = await client.claim(leaseSeconds);

if (job) await executor.execute(job);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('ENGINE_WORKER_LEASE_SECONDS must be a positive integer');
  }
  return parsed;
}
