import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inventoryLicenses,
  isUnintendedIgnoredPath,
  runReleaseCheck,
  scanReachableHistory,
  scanText,
} from './public-release-check.mjs';

test('secret scanner accepts examples and reports common credential shapes without values', () => {
  const safe = [
    'DATABASE_URL=postgresql://postgres:password@db.example.test:5432/example',
    'API_TOKEN=${API_TOKEN}',
    'PRIVATE_KEY=<set outside the repository>',
    'https://example.test/docs',
  ].join('\n');
  assert.deepEqual(scanText(safe, 'safe.env'), []);

  const jwt = ['ey', 'J', 'A'.repeat(20), '.', 'B'.repeat(20), '.', 'C'.repeat(20)].join('');
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const findings = scanText([
    `AUTH_${'TOKEN'}=${jwt}`,
    `SIGNING_${'PRIVATE_KEY'}=${privateKey}`,
    `${['SERVICE', 'PASSWORD'].join('_')}=${'s' + 'uper-secret-value'}`,
    `${['AWS', 'ACCESS', 'KEY_ID'].join('_')}=${'AKIA' + 'A'.repeat(16)}`,
  ].join('\n'), 'candidate.env');

  assert.ok(findings.some(({ label }) => label === 'JWT-shaped credential'));
  assert.ok(findings.some(({ label }) => label === 'private-key material'));
  assert.ok(findings.some(({ label }) => /PASSWORD assignment/.test(label)));
  assert.ok(findings.some(({ label }) => label === 'AWS access key'));
  assert.doesNotMatch(JSON.stringify(findings), /uper-secret|AKIA/);
});

test('credential URL detection stays independent from assignment-like words', () => {
  const unsafe = ['https://account:', 'not-a-placeholder@example.test/docs?query=credential#fragment'].join('');
  const findings = scanText(`const password = "${unsafe}";\n`, 'candidate.js');
  assert.deepEqual(findings, [{ source: 'candidate.js', line: 1, label: 'credential-bearing URL' }]);

  assert.deepEqual(scanText('postgresql://runtime-user:password@127.0.0.1:${port}/demo?schema=public', 'local.test'), []);
  const safe = ['https://user:', 'password@example.test/docs'].join('');
  const unsafeSecond = ['https://user:', 'not-a-placeholder@example.test/docs'].join('');
  assert.deepEqual(scanText(`${safe} ${unsafeSecond}`, 'multiple.test'), [
    { source: 'multiple.test', line: 1, label: 'credential-bearing URL' },
  ]);
});

test('lowercase variables and object keys are ignored by the generic assignment detector', () => {
  const findings = scanText([
    'const token = "not-a-placeholder";',
    'const password = "not-a-placeholder";',
    'const config = { token: "not-a-placeholder", password: "not-a-placeholder", TOKEN: "not-a-placeholder" };',
  ].join('\n'), 'candidate.js');
  assert.deepEqual(findings, []);
});

test('standalone sensitive assignment names are detected without returning values', () => {
  const names = ['API_KEY', 'TOKEN', 'PASSWORD', 'PRIVATE_KEY', 'SECRET', 'ACCESS_KEY', 'CLIENT_SECRET', 'AUTHORIZATION'];
  const findings = scanText(names.map((name) => `${name}=not-a-placeholder`).join('\n'), 'candidate.env');
  for (const name of names) assert.ok(findings.some(({ label }) => label === `${name} assignment`), name);
  const multiSegment = scanText(`${['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_')}=not-a-placeholder\n${['AWS', 'ACCESS', 'KEY', 'ID'].join('_')}=not-a-placeholder`, 'candidate.env');
  assert.ok(multiSegment.some(({ label }) => /AWS_SECRET_ACCESS_KEY assignment/.test(label)));
  assert.ok(multiSegment.some(({ label }) => /AWS_ACCESS_KEY_ID assignment/.test(label)));
  assert.ok(scanText(`${['CLIENT', 'SECRET'].join('_')}="not a placeholder"`, 'candidate.env').some(({ label }) => label === 'CLIENT_SECRET assignment'));
  assert.doesNotMatch(JSON.stringify(findings), /not-a-placeholder/);
});

test('JWT findings are not suppressed by fixture or test wording', () => {
  const jwt = ['ey', 'J', 'A'.repeat(20), '.', 'B'.repeat(20), '.', 'C'.repeat(20)].join('');
  const findings = scanText(`// test fixture\nvalue=${jwt}`, 'candidate.js');
  assert.deepEqual(findings, [{ source: 'candidate.js', line: 2, label: 'JWT-shaped credential' }]);
});

test('ignored local environment, session, cache, and agent paths are rejected while generated dependencies are allowed', () => {
  for (const path of ['.env', '.env.local', '.local-supervisor/state.json', '.codex-work/notes', '.pi/session', '.tmp/file', 'tmp/scratch.txt', '.worktrees/branch']) {
    assert.equal(isUnintendedIgnoredPath(path), true, path);
  }
  for (const path of ['.env.example', '.env.demo.example', 'node_modules/pkg/index.js', 'dist/index.js', '.turbo/cache/file']) {
    assert.equal(isUnintendedIgnoredPath(path), false, path);
  }
  assert.equal(isUnintendedIgnoredPath('recipes/nuglet-example.md'), false);
});

test('history scan finds a removed credential-shaped value without returning it', async (t) => {
  const repository = await temporaryRepository(t);
  const value = ['gh', 'p_', 'A'.repeat(25)].join('');
  await writeFile(join(repository, 'old.env'), `${['OLD', 'TOKEN'].join('_')}=${value}\n`);
  execFileSync('git', ['add', 'old.env'], { cwd: repository });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository });
  execFileSync('git', ['rm', '--quiet', 'old.env'], { cwd: repository });
  execFileSync('git', ['commit', '--quiet', '-m', 'remove-fixture'], { cwd: repository });

  const result = scanReachableHistory(repository);
  assert.equal(result.available, true);
  assert.ok(result.findings.some(({ label, source }) => label === 'GitHub token' && source.startsWith('history:')));
  assert.doesNotMatch(JSON.stringify(result), /ghp_|AAAA/);
});

test('release check rejects a force-added tracked path that matches an ignored local path policy', async (t) => {
  const repository = await temporaryRepository(t);
  await writeFile(join(repository, '.gitignore'), '.tmp/\n');
  await mkdir(join(repository, '.tmp'), { recursive: true });
  await writeFile(join(repository, '.tmp', 'forced.txt'), 'safe\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: repository });
  execFileSync('git', ['add', '--force', '.tmp/forced.txt'], { cwd: repository });
  execFileSync('git', ['commit', '--quiet', '-m', 'force-added-fixture'], { cwd: repository });

  const result = await runReleaseCheck(repository, { includeHistory: false });
  assert.ok(result.candidate.tracked.includes('.tmp/forced.txt'));
  assert.deepEqual(result.unintended, ['.tmp/forced.txt']);
  assert.equal(result.passed, false);
});

test('release check reports untracked candidate paths and fails unintended ignored paths', async (t) => {
  const repository = await temporaryRepository(t);
  await writeFile(join(repository, '.gitignore'), '.env\n');
  await writeFile(join(repository, 'candidate.txt'), 'safe\n');
  await writeFile(join(repository, '.env'), 'DO_NOT_READ=local\n');
  const result = await runReleaseCheck(repository, { includeHistory: false });
  assert.deepEqual(result.candidate.untracked, ['.gitignore', 'candidate.txt']);
  assert.deepEqual(result.unintended, ['.env']);
  assert.equal(result.passed, false);
});

test('license inventory includes the root package importer without inventing metadata', async (t) => {
  const repository = await temporaryRepository(t);
  await writeFile(join(repository, 'package.json'), JSON.stringify({
    name: 'fixture-root', version: '1.0.0', dependencies: { 'root-dependency': '1.0.0' },
  }));
  await mkdir(join(repository, 'node_modules', 'root-dependency'), { recursive: true });
  await writeFile(join(repository, 'node_modules', 'root-dependency', 'package.json'), JSON.stringify({ name: 'root-dependency', version: '1.0.0', license: 'MIT' }));

  const report = await inventoryLicenses(repository);
  const root = report.importers.find(({ name }) => name === 'fixture-root');
  assert.equal(root.file, join(repository, 'package.json'));
  assert.equal(root.license, null);
  assert.equal(report.dependencies.find(({ package: name, name: dependency }) => name === 'fixture-root' && dependency === 'root-dependency').license, 'MIT');
  assert.ok(report.missing.includes('fixture-root (root importer)'));
});

test('license inventory enumerates workspace dependencies and distinguishes missing from unresolved metadata', async (t) => {
  const repository = await temporaryRepository(t);
  await writeFile(join(repository, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  await mkdir(join(repository, 'apps', 'demo'), { recursive: true });
  await mkdir(join(repository, 'node_modules', 'resolved-package'), { recursive: true });
  await mkdir(join(repository, 'node_modules', 'missing-license'), { recursive: true });
  await writeFile(join(repository, 'apps', 'demo', 'package.json'), JSON.stringify({
    name: '@fixture/demo', version: '1.0.0', dependencies: {
      'resolved-package': '1.0.0', 'missing-license': '1.0.0', 'not-installed': '1.0.0',
    },
  }));
  await writeFile(join(repository, 'node_modules', 'resolved-package', 'package.json'), JSON.stringify({ name: 'resolved-package', version: '1.0.0', license: 'MIT' }));
  await writeFile(join(repository, 'node_modules', 'missing-license', 'package.json'), JSON.stringify({ name: 'missing-license', version: '1.0.0' }));

  const report = await inventoryLicenses(repository);
  assert.deepEqual(report.workspacePackages.map(({ name }) => name), ['@fixture/demo']);
  assert.equal(report.dependencies.find(({ name }) => name === 'resolved-package').license, 'MIT');
  assert.ok(report.missing.includes('missing-license'));
  assert.ok(report.unresolved.includes('not-installed'));
});

test('history scan reports shallow and unavailable repositories instead of claiming full inspection', async (t) => {
  const repository = await temporaryRepository(t);
  await writeFile(join(repository, 'fixture.txt'), 'safe\n');
  execFileSync('git', ['add', 'fixture.txt'], { cwd: repository });
  execFileSync('git', ['commit', '--quiet', '-m', 'history-fixture'], { cwd: repository });
  const shallow = await mkdtemp(join(tmpdir(), 'knowledge-bits-public-release-shallow-'));
  t.after(() => rm(shallow, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${repository}`, shallow]);

  const shallowResult = scanReachableHistory(shallow);
  assert.equal(shallowResult.available, false);
  assert.equal(scanReachableHistory(join(shallow, 'missing')).available, false);
});

async function temporaryRepository(t) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-bits-public-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: directory });
  return directory;
}
