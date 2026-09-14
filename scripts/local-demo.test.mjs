import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertDemoPath,
  demoApprovalBody,
  demoPaths,
  loadDemoEnvironment,
  parseCommand,
  parseEnvFile,
  subprocessEnvironment,
  validateDemoEnvironment,
  waitForReceipt,
} from './local-demo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function demoEnvironment() {
  return {
    ENGINE_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55432/knowledge_bits_test',
    TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55432/knowledge_bits_test',
    ENGINE_API_TOKEN: 'local-api',
    ENGINE_REVIEW_TOKEN: 'local-review',
    ENGINE_WORKER_TOKEN: 'local-worker',
    ENGINE_WORKER_CREDENTIALS: JSON.stringify([{
      token: 'local-worker',
      workerId: 'local-worker',
      capabilities: ['collect_sources', 'create_content', 'check_content', 'produce_assets', 'deliver_package'],
    }]),
    WORKER_PROVIDER_MODE: 'fixture',
    ARTIFACT_STORAGE_MODE: 'filesystem',
    ARTIFACT_STORAGE_FILESYSTEM_ROOT: '.local-demo/artifacts',
    ARTIFACT_STORAGE_FILESYSTEM_UPLOAD_BASE_URL: 'http://127.0.0.1:3000',
    DELIVERY_ADAPTER_MODE: 'local',
    DELIVERY_ADAPTER_FILESYSTEM_ROOT: '.local-demo/artifacts',
    ENGINE_API_URL: 'http://127.0.0.1:3000',
    ENGINE_API_BASE_URL: 'http://127.0.0.1:3000',
    KNOWLEDGE_BITS_LOCAL_API_URL: 'http://127.0.0.1:3000',
    KNOWLEDGE_BITS_REVIEW_URL: 'http://127.0.0.1:4323',
    REVIEW_PUBLIC_ORIGIN: 'http://127.0.0.1:4323',
    REVIEW_LOCAL_OPERATOR_ID: 'local-demo-reviewer',
  };
}

test('parses the bounded local-demo command surface and rejects unknown options', () => {
  assert.deepEqual(parseCommand(['setup']), { command: 'setup', approve: false, revise: false });
  assert.deepEqual(parseCommand(['demo']), { command: 'demo', approve: false, revise: false });
  assert.deepEqual(parseCommand(['demo', '--approve', '--revise']), { command: 'demo', approve: true, revise: true });
  assert.throws(() => parseCommand(['status', '--approve']), /only valid with local-demo demo/);
  assert.throws(() => parseCommand(['unknown']), /Unknown local-demo command/);
});

test('builds the contract-compatible payload for explicit demo approval', () => {
  assert.deepEqual(demoApprovalBody('sha256:demo-package'), {
    decision: 'approve',
    packageChecksum: 'sha256:demo-package',
  });
});

test('parses shell-style demo env assignments without adding dotenv', () => {
  assert.deepEqual(parseEnvFile("A=one\nexport B='two words'\n# comment\n"), { A: 'one', B: 'two words' });
});

test('rejects production integration settings and incomplete worker capabilities', () => {
  assert.throws(() => validateDemoEnvironment({ ...demoEnvironment(), DELIVERY_ADAPTER_URL: 'https://production.invalid' }), /production integration/);
  assert.throws(() => validateDemoEnvironment({ ...demoEnvironment(), ENGINE_API_URL: 'https://provider.invalid' }), /localhost HTTP URL/);
  assert.throws(() => validateDemoEnvironment({ ...demoEnvironment(), ENGINE_WORKER_CREDENTIALS: JSON.stringify([{ token: 'local-worker', workerId: 'x', capabilities: ['create_content'] }]) }), /missing capability/);
  assert.throws(() => validateDemoEnvironment({ ...demoEnvironment(), ENGINE_WORKER_TOKEN: 'wrong-token' }), /must match a token/);
});

test('does not pass inherited production settings to the demo environment', async () => {
  const loaded = await loadDemoEnvironment({
    root,
    envFile: '.env.demo.example',
    processEnvironment: { DELIVERY_ADAPTER_URL: 'https://production.invalid', ENGINE_MIGRATION_DATABASE_URL: 'postgresql://production.invalid/db' },
  });
  assert.equal(loaded.DELIVERY_ADAPTER_URL, undefined);
  assert.equal(loaded.ENGINE_MIGRATION_DATABASE_URL, undefined);
});

test('subprocess environment keeps only harmless runtime values and demo configuration', () => {
  const child = subprocessEnvironment(
    { ...demoEnvironment(), PARENT_PROVIDER: 'should-not-pass' },
    {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      PI_PROVIDER: 'google-vertex',
      GOOGLE_APPLICATION_CREDENTIALS: '/secret/credentials.json',
      ENGINE_API_TOKEN: 'parent-token',
    },
  );
  assert.equal(child.PATH, '/safe/bin');
  assert.equal(child.HOME, '/safe/home');
  assert.equal(child.ENGINE_API_TOKEN, 'local-api');
  assert.equal(child.PI_PROVIDER, undefined);
  assert.equal(child.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(child.PARENT_PROVIDER, undefined);
});

test('waits for a receipt with the approved package checksum', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'knowledge-bits-local-demo-'));
  const receiptRoot = join(rootPath, 'artifacts', 'delivery-receipts');
  const paths = { artifacts: join(rootPath, 'artifacts') };
  try {
    await mkdir(receiptRoot, { recursive: true });
    await writeFile(join(receiptRoot, 'older.json'), JSON.stringify({ packageChecksum: 'sha256:older-package' }));
    await assert.rejects(waitForReceipt(paths, 'sha256:approved-package', 1), /approved-package/);
    await writeFile(join(receiptRoot, 'approved.json'), JSON.stringify({ packageChecksum: 'sha256:approved-package' }));
    assert.equal(await waitForReceipt(paths, 'sha256:approved-package'), join(receiptRoot, 'approved.json'));
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test('scopes reset targets below the local demo state directory', () => {
  const paths = demoPaths(root);
  assert.equal(assertDemoPath(paths.root, paths.artifacts), paths.artifacts);
  assert.equal(assertDemoPath(paths.root, resolve(paths.root, 'artifacts', 'delivery-receipts')), resolve(paths.root, 'artifacts', 'delivery-receipts'));
  assert.throws(() => assertDemoPath(paths.root, root), /outside local demo state/);
  assert.throws(() => assertDemoPath(paths.root, resolve(root, 'README.md')), /outside local demo state/);
});

test('checked-in demo example references bundled fixture provider data', async () => {
  const paths = demoPaths(root);
  const brief = JSON.parse(await readFile(paths.brief, 'utf8'));
  assert.equal(brief.brief.intake.requestedFormat, 'story_playbook');
  assert.match(await readFile(paths.source, 'utf8'), /fixture/i);
  for (const file of ['collect-sources.json', 'create-content-story-playbook.json', 'check-content.json', 'produce-assets-dual-audio.json', 'deliver-package.json']) {
    assert.ok((await readFile(resolve(paths.fixtures, file), 'utf8')).length > 0, file);
  }
});
