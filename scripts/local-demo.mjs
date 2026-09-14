#!/usr/bin/env node

import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_COMMANDS = ['setup', 'seed', 'start', 'stop', 'reset', 'status', 'demo'];
export const COMPOSE_PROJECT = 'knowledge-bits-local-demo';
export const COMPOSE_CONTAINER = 'knowledge-bits-local-demo-postgres';
const ENV_FILE_NAME = '.env.demo';
const STATE_DIRECTORY = '.local-demo';
const STATE_FILE_NAME = 'state.json';
const DEFAULT_REVIEW_PORT = 4323;
const DEFAULT_TICK_INTERVAL_MS = 2_000;
const PROCESS_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TERM',
  'PNPM_HOME',
];
const DEMO_CONFIGURATION_NAMES = [
  'ENGINE_DATABASE_URL',
  'TEST_DATABASE_URL',
  'ENGINE_API_TOKEN',
  'ENGINE_REVIEW_TOKEN',
  'ENGINE_WORKER_TOKEN',
  'ENGINE_WORKER_CREDENTIALS',
  'ENGINE_WORKER_LEASE_SECONDS',
  'ENGINE_WORKER_MAX_JOBS_PER_TICK',
  'ENGINE_WORKER_TICK_SECONDS',
  'WORKER_PROVIDER_MODE',
  'WORKER_FIXTURE_DIRECTORY',
  'ARTIFACT_STORAGE_MODE',
  'ARTIFACT_STORAGE_FILESYSTEM_ROOT',
  'ARTIFACT_STORAGE_FILESYSTEM_UPLOAD_BASE_URL',
  'DELIVERY_ADAPTER_MODE',
  'DELIVERY_ADAPTER_FILESYSTEM_ROOT',
  'ENGINE_API_URL',
  'KNOWLEDGE_BITS_REVIEW_URL',
  'REVIEW_PUBLIC_ORIGIN',
  'REVIEW_LOCAL_OPERATOR_ID',
  'ENGINE_API_BASE_URL',
  'KNOWLEDGE_BITS_LOCAL_API_URL',
  'KNOWLEDGE_BITS_DEMO_TICK_INTERVAL_MS',
  'PORT',
];
const FIXTURE_FILES = [
  'collect-sources.json',
  'create-content-story-playbook.json',
  'check-content.json',
  'produce-assets-dual-audio.json',
  'deliver-package.json',
];
const FORBIDDEN_ENV_NAMES = [
  'NUGLET_DATABASE_URL',
  'NUGLET_RUNTIME_DATABASE_URL',
  'NUGLET_DIRECT_DATABASE_URL',
  'NUGLET_SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
  'ENGINE_MIGRATION_DATABASE_URL',
  'ARTIFACT_STORAGE_R2_ACCOUNT_ID',
  'ARTIFACT_STORAGE_R2_BUCKET',
  'ARTIFACT_STORAGE_R2_ACCESS_KEY_ID',
  'ARTIFACT_STORAGE_R2_SECRET_ACCESS_KEY',
  'DELIVERY_ADAPTER_URL',
  'DELIVERY_ADAPTER_TOKEN',
];

export function parseCommand(argv) {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help', approve: false, revise: false };
  }
  if (!DEMO_COMMANDS.includes(command)) throw new Error(`Unknown local-demo command: ${command}`);
  let approve = false;
  let revise = false;
  for (const arg of args) {
    if (arg === '--approve') approve = true;
    else if (arg === '--revise') revise = true;
    else throw new Error(`Unknown local-demo option: ${arg}`);
  }
  if (command !== 'demo' && (approve || revise)) {
    throw new Error(`--approve and --revise are only valid with local-demo demo`);
  }
  return { command, approve, revise };
}

export function demoPaths(root = ROOT) {
  const demoRoot = resolve(root, STATE_DIRECTORY);
  return {
    root: demoRoot,
    state: resolve(demoRoot, STATE_FILE_NAME),
    artifacts: resolve(demoRoot, 'artifacts'),
    logs: resolve(demoRoot, 'logs'),
    brief: resolve(root, 'examples/local-demo/brief.json'),
    source: resolve(root, 'examples/local-demo/source.txt'),
    fixtures: resolve(root, 'apps/worker/src/providers/fixtures'),
  };
}

export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`Invalid demo environment line: ${line}`);
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function validateDemoEnvironment(env) {
  const forbidden = FORBIDDEN_ENV_NAMES.filter((name) => env[name]?.trim());
  if (forbidden.length) throw new Error(`Demo environment contains production integration settings: ${forbidden.join(', ')}`);
  const required = [
    'ENGINE_DATABASE_URL',
    'TEST_DATABASE_URL',
    'ENGINE_API_TOKEN',
    'ENGINE_REVIEW_TOKEN',
    'ENGINE_WORKER_TOKEN',
    'ENGINE_WORKER_CREDENTIALS',
    'WORKER_PROVIDER_MODE',
    'ARTIFACT_STORAGE_MODE',
    'ARTIFACT_STORAGE_FILESYSTEM_ROOT',
    'ARTIFACT_STORAGE_FILESYSTEM_UPLOAD_BASE_URL',
    'DELIVERY_ADAPTER_MODE',
    'DELIVERY_ADAPTER_FILESYSTEM_ROOT',
    'ENGINE_API_URL',
    'KNOWLEDGE_BITS_REVIEW_URL',
    'REVIEW_PUBLIC_ORIGIN',
    'REVIEW_LOCAL_OPERATOR_ID',
    'ENGINE_API_BASE_URL',
    'KNOWLEDGE_BITS_LOCAL_API_URL',
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Demo environment is missing: ${missing.join(', ')}`);
  if (env.WORKER_PROVIDER_MODE !== 'fixture') throw new Error('Demo environment must use WORKER_PROVIDER_MODE=fixture');
  if (env.ARTIFACT_STORAGE_MODE !== 'filesystem') throw new Error('Demo environment must use filesystem artifact storage');
  if (env.DELIVERY_ADAPTER_MODE !== 'local') throw new Error('Demo environment must use local delivery');
  for (const name of ['ENGINE_DATABASE_URL', 'TEST_DATABASE_URL']) {
    const url = new URL(env[name]);
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error(`${name} must use localhost`);
    if (!url.pathname.toLowerCase().includes('test')) throw new Error(`${name} must name a test database`);
  }
  for (const name of [
    'ARTIFACT_STORAGE_FILESYSTEM_UPLOAD_BASE_URL',
    'ENGINE_API_URL',
    'ENGINE_API_BASE_URL',
    'KNOWLEDGE_BITS_LOCAL_API_URL',
    'KNOWLEDGE_BITS_REVIEW_URL',
    'REVIEW_PUBLIC_ORIGIN',
  ]) {
    const url = new URL(env[name]);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      throw new Error(`${name} must use a localhost HTTP URL`);
    }
  }
  const credentials = JSON.parse(env.ENGINE_WORKER_CREDENTIALS);
  const workerToken = env.ENGINE_WORKER_TOKEN.trim();
  if (!Array.isArray(credentials)
    || !credentials.some((credential) => typeof credential?.token === 'string' && credential.token.trim() === workerToken)) {
    throw new Error('ENGINE_WORKER_TOKEN must match a token in ENGINE_WORKER_CREDENTIALS');
  }
  const capabilities = new Set(credentials.flatMap((credential) => credential.capabilities ?? []));
  for (const capability of ['collect_sources', 'create_content', 'check_content', 'produce_assets', 'deliver_package']) {
    if (!capabilities.has(capability)) throw new Error(`Demo worker is missing capability: ${capability}`);
  }
  return env;
}

export async function loadDemoEnvironment({ root = ROOT, envFile = ENV_FILE_NAME, processEnvironment = process.env } = {}) {
  const filePath = resolve(root, envFile);
  const values = parseEnvFile(await readFile(filePath, 'utf8'));
  const configuredForbidden = FORBIDDEN_ENV_NAMES.filter((name) => values[name]?.trim());
  if (configuredForbidden.length) {
    throw new Error(`Demo environment contains production integration settings: ${configuredForbidden.join(', ')}`);
  }
  const env = { ...minimalProcessEnvironment(processEnvironment), ...values };
  for (const name of FORBIDDEN_ENV_NAMES) delete env[name];
  validateDemoEnvironment(env);
  const paths = demoPaths(root);
  env.ARTIFACT_STORAGE_FILESYSTEM_ROOT = resolve(root, env.ARTIFACT_STORAGE_FILESYSTEM_ROOT);
  env.DELIVERY_ADAPTER_FILESYSTEM_ROOT = resolve(root, env.DELIVERY_ADAPTER_FILESYSTEM_ROOT);
  env.WORKER_FIXTURE_DIRECTORY = resolve(root, env.WORKER_FIXTURE_DIRECTORY);
  env.ENGINE_API_BASE_URL = env.ENGINE_API_BASE_URL?.trim() || env.ENGINE_API_URL;
  env.ENGINE_API_URL = env.ENGINE_API_URL?.trim() || 'http://127.0.0.1:3000';
  env.KNOWLEDGE_BITS_REVIEW_URL = env.KNOWLEDGE_BITS_REVIEW_URL?.trim() || `http://127.0.0.1:${DEFAULT_REVIEW_PORT}`;
  env.REVIEW_PUBLIC_ORIGIN = env.REVIEW_PUBLIC_ORIGIN?.trim() || env.KNOWLEDGE_BITS_REVIEW_URL;
  env.PORT = env.PORT?.trim() || '3000';
  env.KNOWLEDGE_BITS_LOCAL_API_URL = env.KNOWLEDGE_BITS_LOCAL_API_URL?.trim() || env.ENGINE_API_URL;
  env.KNOWLEDGE_BITS_DEMO_ROOT = paths.root;
  return env;
}

export function assertDemoPath(root, candidate) {
  const demoRoot = resolve(root);
  const target = resolve(candidate);
  const pathRelativeToRoot = relative(demoRoot, target);
  if (target === demoRoot || pathRelativeToRoot.startsWith('..') || isAbsolute(pathRelativeToRoot)) {
    throw new Error(`Refusing to modify path outside local demo state: ${target}`);
  }
  return target;
}

export function stateForPaths(paths, state = {}) {
  return {
    version: 1,
    ...state,
    processes: Array.isArray(state.processes) ? state.processes : [],
  };
}

async function main() {
  const parsed = parseCommand(process.argv.slice(2));
  if (parsed.command === 'help') {
    printHelp();
    return;
  }
  const paths = demoPaths(ROOT);
  if (parsed.command === 'stop') {
    await stop(paths);
    return;
  }
  if (parsed.command === 'reset') {
    await reset(paths);
    return;
  }
  const env = await loadDemoEnvironment();
  if (parsed.command === 'setup') await setup(env, paths);
  else if (parsed.command === 'seed') await seed(env, paths);
  else if (parsed.command === 'start') await start(env, paths);
  else if (parsed.command === 'status') await status(env, paths);
  else if (parsed.command === 'demo') await demo(env, paths, parsed);
}

function printHelp() {
  console.log(`Knowledge Bits local demo (PostgreSQL 16, fixture providers)\n\nCommands:\n  setup   Start PostgreSQL and apply the guarded local migration\n  seed    Create the checked-in demo run\n  start   Start the normal API, review app, and fixture worker ticks\n  stop    Stop only processes recorded by the demo state file\n  reset   Stop demo processes and remove only demo database/artifact state\n  status  Report database, API, review, worker, run, and receipt state\n  demo    Start, seed, and wait for review; use --approve explicitly\n          Use demo --revise to regenerate one asset and require reapproval\n\nThe demo never auto-approves a package. Open the printed review URL and approve\nthe exact displayed checksum in the review UI, or pass demo --approve after inspection.`);
}

function composeArgs(args) {
  return ['compose', '--project-name', COMPOSE_PROJECT, '--file', resolve(ROOT, 'compose.yaml'), ...args];
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? ROOT, env: options.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

async function setup(env, paths) {
  await mkdir(paths.root, { recursive: true });
  runCommand('docker', composeArgs(['up', '--detach']));
  await waitForDatabase();
  runCommand('pnpm', ['--filter', '@knowledge-bits/api', 'prisma:migrate'], { env: migrationEnvironment(env) });
  console.log('Local demo database is ready and migrations are applied.');
}

function migrationEnvironment(env) {
  return {
    ...minimalProcessEnvironment(),
    TEST_DATABASE_URL: env.TEST_DATABASE_URL,
  };
}

async function waitForDatabase(timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', COMPOSE_CONTAINER], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim() === 'healthy') return;
    await sleep(1_000);
  }
  throw new Error('Timed out waiting for the local PostgreSQL healthcheck');
}

async function seed(env, paths) {
  await assertExample(paths);
  const state = await readState(paths);
  if (state.runId) {
    const current = await apiJson(env, `/runs/${encodeURIComponent(state.runId)}`, { token: env.ENGINE_API_TOKEN });
    if (current.ok) {
      console.log(`Demo run already seeded: ${state.runId}`);
      console.log(`Review URL: ${reviewUrl(env, state.runId)}`);
      return state.runId;
    }
  }
  const brief = JSON.parse(await readFile(paths.brief, 'utf8'));
  const response = await apiJson(env, '/runs', {
    method: 'POST',
    token: env.ENGINE_API_TOKEN,
    body: {
      title: brief.title,
      locale: brief.locale,
      notebookLmNotebookId: brief.notebookLmNotebookId,
      brief: brief.brief,
    },
  });
  if (!response.ok) throw new Error(`Demo seed failed (${response.status}): ${JSON.stringify(response.body)}`);
  const runId = response.body.id;
  await writeState(paths, stateForPaths(paths, { ...state, runId, seededAt: new Date().toISOString() }));
  console.log(`Demo run ID: ${runId}`);
  console.log(`Review URL: ${reviewUrl(env, runId)}`);
  return runId;
}

async function assertExample(paths) {
  if (!existsSync(paths.brief)) throw new Error(`Checked-in demo brief is missing: ${paths.brief}`);
  if (!existsSync(paths.source)) throw new Error(`Checked-in demo source is missing: ${paths.source}`);
  const missing = FIXTURE_FILES.filter((file) => !existsSync(resolve(paths.fixtures, file)));
  if (missing.length) throw new Error(`Checked-in fixture provider data is missing: ${missing.join(', ')}`);
  const brief = JSON.parse(await readFile(paths.brief, 'utf8'));
  if (brief.brief?.intake?.requestedFormat !== 'story_playbook') throw new Error('Demo brief must request story_playbook intake');
}

async function start(env, paths) {
  const state = await readState(paths);
  const processes = [...state.processes].filter(({ pid }) => processAlive(pid));
  if (!processes.some((entry) => entry.name === 'api')) processes.push(await spawnService('api', 'pnpm', ['--filter', '@knowledge-bits/api', 'exec', 'tsx', 'src/main.ts'], env, paths));
  if (!processes.some((entry) => entry.name === 'review')) {
    processes.push(await spawnService('review', 'pnpm', ['--filter', '@knowledge-bits/review', 'exec', 'astro', 'dev', '--host', '127.0.0.1', '--port', String(DEFAULT_REVIEW_PORT)], env, paths));
  }
  if (!processes.some((entry) => entry.name === 'worker')) {
    processes.push(await spawnService('worker', process.execPath, [fileURLToPath(import.meta.url), 'worker-loop'], env, paths));
  }
  await writeState(paths, stateForPaths(paths, { ...state, processes }));
  console.log(`Local API: ${env.ENGINE_API_URL}`);
  console.log(`Local review: ${env.KNOWLEDGE_BITS_REVIEW_URL}`);
  console.log('Fixture worker ticks are running in the background.');
}

async function spawnService(name, command, args, env, paths) {
  await mkdir(paths.logs, { recursive: true });
  const logPath = resolve(paths.logs, `${name}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(command, args, {
    cwd: ROOT,
    env: subprocessEnvironment(env, process.env, { NODE_ENV: 'development' }),
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();
  return { name, pid: child.pid, startedAt: new Date().toISOString() };
}

async function workerLoop(env, paths) {
  let current;
  let stopping = false;
  const stopChild = () => {
    stopping = true;
    if (current && processAlive(current.pid)) process.kill(current.pid, 'SIGTERM');
  };
  process.once('SIGTERM', stopChild);
  process.once('SIGINT', stopChild);
  while (!stopping) {
    if (await isHealthy(env.ENGINE_API_URL)) {
      current = spawn('pnpm', ['--filter', '@knowledge-bits/worker', 'exec', 'tsx', 'src/index.ts'], {
        cwd: ROOT,
        env: subprocessEnvironment(env, process.env, { NODE_ENV: 'development' }),
        stdio: 'inherit',
      });
      await new Promise((resolveExit) => current.once('close', resolveExit));
      current = undefined;
    }
    if (!stopping) await sleep(Number(env.KNOWLEDGE_BITS_DEMO_TICK_INTERVAL_MS ?? DEFAULT_TICK_INTERVAL_MS));
  }
}

async function stop(paths) {
  const state = await readState(paths);
  for (const entry of state.processes) {
    if (Number.isInteger(entry.pid) && processAlive(entry.pid)) {
      try { process.kill(entry.pid, 'SIGTERM'); } catch { /* Process exited between the check and signal. */ }
    }
  }
  await writeState(paths, stateForPaths(paths, { ...state, processes: [] }));
  console.log('Stopped only processes recorded in .local-demo/state.json.');
}

async function reset(paths) {
  await stop(paths);
  runCommand('docker', composeArgs(['down', '--volumes']));
  assertDemoPath(paths.root, paths.artifacts);
  assertDemoPath(paths.root, paths.logs);
  await rm(paths.artifacts, { recursive: true, force: true });
  await rm(paths.logs, { recursive: true, force: true });
  await rm(paths.state, { force: true });
  console.log('Removed the local demo container, volume, artifacts, receipts, logs, and state only.');
}

async function status(env, paths) {
  const state = await readState(paths);
  const processes = Object.fromEntries(['api', 'review', 'worker'].map((name) => {
    const entry = state.processes.find((candidate) => candidate.name === name);
    return [name, Boolean(entry && processAlive(entry.pid))];
  }));
  const database = await composeStatus();
  const api = await isHealthy(env.ENGINE_API_URL);
  const review = await isHealthy(env.KNOWLEDGE_BITS_REVIEW_URL, '');
  let run = null;
  if (state.runId && api) {
    const response = await apiJson(env, `/runs/${encodeURIComponent(state.runId)}`, { token: env.ENGINE_API_TOKEN });
    if (response.ok) run = {
      id: response.body.id,
      stage: response.body.currentStage,
      revision: response.body.currentRevision,
      packageChecksum: response.body.packageChecksum,
      approvedChecksum: response.body.approvedChecksum,
      reviewStatus: response.body.reviewStatus,
    };
  }
  const receiptFiles = await jsonFiles(resolve(paths.artifacts, 'delivery-receipts'));
  console.log(JSON.stringify({
    database,
    api,
    review,
    worker: processes.worker,
    processes,
    run,
    receipts: { state: receiptFiles.length ? 'present' : 'none', files: receiptFiles },
  }, null, 2));
}

async function composeStatus() {
  const result = spawnSync('docker', composeArgs(['ps', '--format', 'json']), { encoding: 'utf8' });
  if (result.error || result.status !== 0) return 'unavailable';
  const text = result.stdout.trim();
  if (!text) return 'stopped';
  try {
    const value = JSON.parse(text.split(/\r?\n/)[0]);
    return value.Health || value.State || 'running';
  } catch {
    return 'running';
  }
}

export function demoApprovalBody(packageChecksum) {
  return { decision: 'approve', packageChecksum };
}

async function demo(env, paths, options) {
  await setup(env, paths);
  await start(env, paths);
  await waitForService(env.ENGINE_API_URL, 'health');
  const runId = await seed(env, paths);
  let run = await waitForReview(env, runId);
  console.log(`Open the review UI: ${reviewUrl(env, runId)}`);
  console.log(`Review the complete package and approve this exact checksum: ${run.packageChecksum}`);
  if (options.revise) {
    const before = run.packageChecksum;
    const response = await apiJson(env, `/runs/${encodeURIComponent(runId)}/regenerate-media`, {
      method: 'POST',
      token: env.ENGINE_REVIEW_TOKEN,
      reviewer: env.REVIEW_LOCAL_OPERATOR_ID,
      body: { kinds: ['hero'] },
    });
    if (!response.ok) throw new Error(`Demo revision failed (${response.status}): ${JSON.stringify(response.body)}`);
    run = await waitForReview(env, runId, { changedFrom: before });
    console.log(`Revision changed the package checksum from ${before} to ${run.packageChecksum}. Approval is pending again.`);
    console.log(`Approve only the new checksum in the review UI: ${reviewUrl(env, runId)}`);
  }
  if (!options.approve) {
    console.log('No approval was sent. Use the review UI, then run status to observe delivery.');
    return;
  }
  const approval = await apiJson(env, `/runs/${encodeURIComponent(runId)}/review`, {
    method: 'POST',
    token: env.ENGINE_REVIEW_TOKEN,
    reviewer: env.REVIEW_LOCAL_OPERATOR_ID,
    body: demoApprovalBody(run.packageChecksum),
  });
  if (!approval.ok) throw new Error(`Demo approval failed (${approval.status}): ${JSON.stringify(approval.body)}`);
  const receipt = await waitForReceipt(paths, run.packageChecksum);
  console.log(`Approved exact package ${run.packageChecksum}. Local durable receipt: ${receipt}`);
}

async function waitForReview(env, runId, options = {}) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const response = await apiJson(env, `/runs/${encodeURIComponent(runId)}`, { token: env.ENGINE_API_TOKEN });
    if (response.ok) {
      const run = response.body;
      if (run.currentStage === 'human_review' && run.packageChecksum && (!options.changedFrom || run.packageChecksum !== options.changedFrom)) return run;
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for run ${runId} to reach human review`);
}

export async function waitForReceipt(paths, approvedPackageChecksum, timeoutMs = 120_000) {
  if (typeof approvedPackageChecksum !== 'string' || !approvedPackageChecksum) {
    throw new Error('An approved package checksum is required to wait for a local delivery receipt');
  }
  const receiptRoot = resolve(paths.artifacts, 'delivery-receipts');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = await findMatchingReceipt(receiptRoot, approvedPackageChecksum);
    if (receipt) return receipt;
    const remainingMs = timeoutMs - (Date.now() - started);
    if (remainingMs > 0) await sleep(Math.min(1_000, remainingMs));
  }
  throw new Error(`Timed out waiting for the local delivery receipt for package ${approvedPackageChecksum}`);
}

async function findMatchingReceipt(receiptRoot, approvedPackageChecksum) {
  const files = await jsonFiles(receiptRoot);
  for (const file of files) {
    try {
      const receipt = JSON.parse(await readFile(resolve(receiptRoot, file), 'utf8'));
      if (receipt?.packageChecksum === approvedPackageChecksum) return resolve(receiptRoot, file);
    } catch {
      // Ignore incomplete or unrelated files while waiting for the approved receipt.
    }
  }
  return undefined;
}

async function apiJson(env, path, options = {}) {
  const headers = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.reviewer) headers['x-knowledge-bits-reviewer'] = options.reviewer;
  try {
    const response = await fetch(new URL(path.replace(/^\/+/, ''), `${env.ENGINE_API_URL.replace(/\/$/, '')}/`), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForService(url, endpoint = 'health', timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isHealthy(url, endpoint)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for local service: ${url}`);
}

async function isHealthy(url, endpoint = 'health') {
  try {
    const response = await fetch(new URL(endpoint, `${url.replace(/\/$/, '')}/`), { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function reviewUrl(env, runId) {
  return `${env.KNOWLEDGE_BITS_REVIEW_URL.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}`;
}

async function readState(paths) {
  try { return stateForPaths(paths, JSON.parse(await readFile(paths.state, 'utf8'))); }
  catch (error) {
    if (error?.code === 'ENOENT') return stateForPaths(paths);
    throw error;
  }
}

async function writeState(paths, state) {
  await mkdir(paths.root, { recursive: true });
  const temporary = `${paths.state}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stateForPaths(paths, state), null, 2)}\n`, { flag: 'w' });
  await rename(temporary, paths.state);
}

async function jsonFiles(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

export function subprocessEnvironment(env, processEnvironment = process.env, overrides = {}) {
  return {
    ...minimalProcessEnvironment(processEnvironment),
    ...Object.fromEntries(DEMO_CONFIGURATION_NAMES
      .filter((name) => env[name] !== undefined)
      .map((name) => [name, env[name]])),
    ...overrides,
  };
}

function minimalProcessEnvironment(source = process.env) {
  return Object.fromEntries(PROCESS_ENV_ALLOWLIST
    .filter((name) => source[name] !== undefined)
    .map((name) => [name, source[name]]));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  if (process.argv[2] === 'worker-loop') {
    loadDemoEnvironment().then((env) => workerLoop(env, demoPaths(ROOT))).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  } else {
    main().catch((error) => {
      console.error(`local-demo: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
  }
}
