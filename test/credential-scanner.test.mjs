import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scanner = fileURLToPath(new URL('../scripts/scan-forbidden-credentials.mjs', import.meta.url));
const projectRef = 'abcdefghijklmnopqrst';

test('scanner rejects direct and pooled Supabase PostgreSQL hosts under arbitrary variable names', async (t) => {
  const directHost = ['db', projectRef, 'supabase', 'co'].join('.');
  const poolerHost = ['aws-0-eu-west-1', 'pooler', 'supabase', 'com'].join('.');
  const repository = await createRepository(t, {
    'direct.env': `ANY_NAME=postgresql://postgres:password@${directHost}:5432/postgres\n`,
    'pooled.txt': `custom_connection=postgres://postgres.${projectRef}:password@${poolerHost}:6543/postgres\n`,
  });

  const result = runScanner(repository);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /direct\.env:1 Supabase PostgreSQL host/);
  assert.match(result.stderr, /pooled\.txt:1 Supabase PostgreSQL host/);
});

test('scanner permits sanitized non-Supabase PostgreSQL and example URLs', async (t) => {
  const repository = await createRepository(t, {
    'safe.env': [
      'ENGINE_DATABASE_URL=postgresql://postgres:password@db.example.test:5432/knowledge_bits',
      'DOCUMENTATION_URL=https://supabase.example.test/project',
      '',
    ].join('\n'),
  });

  const result = runScanner(repository);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Credential scan passed/);
});

test('scanner fails closed when a candidate file cannot be read', async (t) => {
  const repository = await createRepository(t, { 'unreadable.env': 'SAFE=value\n' });
  const candidate = join(repository, 'unreadable.env');
  await chmod(candidate, 0o000);
  t.after(() => chmod(candidate, 0o600).catch(() => {}));

  const result = runScanner(repository);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreadable\.env.*could not be read/i);
});

async function createRepository(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-bits-scanner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
  execFileSync('git', ['add', '.'], { cwd: directory });
  return directory;
}

function runScanner(cwd) {
  return spawnSync(process.execPath, [scanner], { cwd, encoding: 'utf8' });
}
