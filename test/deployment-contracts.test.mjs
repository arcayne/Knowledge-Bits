import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);

test('required Quality workflow covers pull requests and independently reproduces root checks', async () => {
  const workflow = await readFile(new URL('.github/workflows/quality.yml', repositoryRoot), 'utf8');
  const packageJson = await readJson('package.json');

  assert.match(workflow, /^name:\s*Quality$/m);
  assert.match(workflow, /^\s{2}pull_request:\s*$/m);
  assert.match(workflow, /^\s{2}push:\s*$/m);
  assert.match(workflow, /^\s{6}- main\s*$/m);
  assert.match(workflow, /^permissions:\s*\n\s{2}contents:\s*read$/m);
  assert.match(workflow, /^\s{8}run:\s*pnpm install --frozen-lockfile$/m);
  assert.match(workflow, /^\s{8}run:\s*pnpm typecheck$/m);
  assert.match(workflow, /^\s{8}run:\s*pnpm test$/m);
  assert.match(workflow, /^\s{8}run:\s*pnpm build$/m);
  assert.match(workflow, /^\s{8}run:\s*pnpm --filter @knowledge-bits\/review exec playwright install --with-deps chromium$/m);
  assert.match(workflow, /^\s{8}run:\s*timeout 180s docker pull postgres:16-alpine$/m);
  assert.match(packageJson.scripts.test, /pnpm test:workspace/);
  assert.doesNotMatch(packageJson.scripts.test, /turbo run test/);
});

test('historical PR baseline follows the fixed 20-PR pilot contract', async () => {
  const csv = await readFile(new URL('docs/engineering/pr-baseline.csv', repositoryRoot), 'utf8');
  const rows = csv.trim().split(/\r?\n/).map((line) => line.split(','));
  const expectedHeader = [
    'date', 'repository', 'pr', 'change_area', 'risk_tier', 'builder_agent', 'reviewer_agent',
    'automated_checks', 'preview_verified', 'human_minutes', 'merged', 'accepted',
    'corrective_pr_within_48h', 'failure_category', 'notes',
  ];
  const changeAreas = new Set([
    'local_runtime', 'intake_and_similarity', 'review_routing', 'shorts_prompt_and_rendering',
    'infographic_pipeline', 'artifact_regeneration', 'review_auth', 'review_dashboard',
    'review_artifacts', 'delivery_contract',
  ]);
  const riskTiers = new Set(['Green', 'Yellow', 'Orange', 'Red']);
  const correctiveValues = new Set(['inferred_yes', 'no_observed_in_sample', 'unknown']);
  const failureCategories = new Set([
    'Specification', 'Model', 'Environment', 'Tooling', 'Architecture', 'Review', 'none_observed',
  ]);

  assert.deepEqual(rows[0], expectedHeader);
  assert.equal(rows.length, 21, 'baseline must contain one header plus exactly 20 PR rows');
  assert.deepEqual(rows.slice(1).map((row) => row[2]), Array.from({ length: 20 }, (_, index) => `#${index + 31}`));

  for (const row of rows.slice(1)) {
    assert.equal(row.length, expectedHeader.length, `row ${row[2]} must have ${expectedHeader.length} fields`);
    assert.match(row[0], /^2026-\d{2}-\d{2}$/);
    assert.equal(row[1], 'arcayne/Knowledge-Bits');
    assert.ok(changeAreas.has(row[3]), `unexpected change_area in ${row[2]}`);
    assert.ok(riskTiers.has(row[4]), `unexpected risk_tier in ${row[2]}`);
    assert.equal(row[5], 'unrecorded_codex_branch');
    assert.equal(row[6], 'none_recorded');
    assert.equal(row[7], 'vercel_status_only_no_actions');
    assert.equal(row[8], 'unknown');
    assert.equal(row[9], 'unknown');
    assert.equal(row[10], 'true');
    assert.equal(row[11], 'unknown');
    assert.ok(correctiveValues.has(row[12]), `unexpected corrective value in ${row[2]}`);
    assert.ok(failureCategories.has(row[13]), `unexpected failure category in ${row[2]}`);
    assert.match(row[14], /^open_to_merge_seconds=\d+;/);
  }
});

test('API app exposes a catch-all Hono Vercel function from its documented root', async () => {
  const rootPackageJson = await readJson('package.json');
  const config = await readJson('apps/api/vercel.json');
  const packageJson = await readJson('apps/api/package.json');
  const entrypoint = await readFile(new URL('apps/api/api/index.js', repositoryRoot), 'utf8');
  const catchAllEntrypoint = await readFile(new URL('apps/api/api/[...path].js', repositoryRoot), 'utf8');
  const handler = await readFile(new URL('apps/api/api/handler.js', repositoryRoot), 'utf8');

  assert.equal(config.framework, null);
  assert.equal(config.installCommand, 'pnpm install --frozen-lockfile');
  assert.equal(config.buildCommand, 'pnpm build');
  assert.equal(config.functions['api/handler.js'].includeFiles, 'apps/api/dist/**');
  assert.match(rootPackageJson.scripts.postinstall, /--filter @knowledge-bits\/api build/);
  assert.deepEqual(config.rewrites, [
    {
      source: '/api/(.*)',
      destination: '/api/handler.js',
    },
  ]);
  assert.match(packageJson.scripts.build, /tsc -p tsconfig\.json/);
  assert.doesNotMatch(packageJson.scripts.build, /tsconfig\.vercel\.json/);
  assert.match(entrypoint, /from ['"]\.\/handler\.js['"]/);
  assert.match(catchAllEntrypoint, /from ['"]\.\/handler\.js['"]/);
  assert.match(handler, /from ['"]@hono\/node-server['"]/);
  assert.match(handler, /from ['"]\.\.\/dist\/runtime\.js['"]/);
  assert.match(handler, /['"]\/health['"]/);
  assert.match(handler, /rawRequest\.arrayBuffer\(\)/);
  assert.match(handler, /export default getRequestListener\(/);
});

test('review app builds Astro SSR with the Vercel adapter from its documented root', async () => {
  const config = await readJson('apps/review/vercel.json');
  const packageJson = await readJson('apps/review/package.json');
  const astroConfig = await readFile(new URL('apps/review/astro.config.mjs', repositoryRoot), 'utf8');

  assert.equal(config.framework, 'astro');
  assert.equal(config.installCommand, 'pnpm install --frozen-lockfile');
  assert.equal(config.buildCommand, 'pnpm build');
  assert.ok(packageJson.dependencies['@astrojs/vercel']);
  assert.equal(packageJson.dependencies['@astrojs/node'], undefined);
  assert.match(astroConfig, /from ['"]@astrojs\/vercel['"]/);
  assert.match(astroConfig, /adapter:\s*vercel\(\)/);
  assert.doesNotMatch(astroConfig, /@astrojs\/node|standalone/);
});

test('worker remains outside the Vercel deployment surface', async () => {
  await assert.rejects(access(new URL('apps/worker/vercel.json', repositoryRoot)));
});

test('provider credentials and recipe filesystem roots remain local-worker-only', async () => {
  const deployedRuntimeFiles = [
    'apps/api/vercel.json',
    'apps/api/package.json',
    'apps/review/vercel.json',
    'apps/review/package.json',
    'apps/review/astro.config.mjs',
    ...await sourceFiles('apps/api/api'),
    ...await sourceFiles('apps/api/src'),
    ...await sourceFiles('apps/review/src'),
  ];
  const workerRuntime = await readFile(new URL('apps/worker/src/runtime.ts', repositoryRoot), 'utf8');
  const forbiddenDeploymentConfiguration = [
    'PRODUCT_RECIPE_ROOTS',
    'WORKER_FIXTURE_DIRECTORY',
    'NOTEBOOKLM_TIMEOUT_MS',
    'NOTEBOOKLM_TRUSTED_SOURCE_HOSTS',
    'PI_PROVIDER',
    'PI_MODEL',
    'MEDIA_GENERATION_COMMAND',
    'MEDIA_GENERATION_ARGS',
  ];

  for (const path of deployedRuntimeFiles) {
    const contents = await readFile(new URL(path, repositoryRoot), 'utf8');
    for (const name of forbiddenDeploymentConfiguration) {
      assert.doesNotMatch(contents, new RegExp(`\\b${name}\\b`), `${path} must not expose ${name}`);
    }
  }
  assert.match(workerRuntime, /env\.PRODUCT_RECIPE_ROOTS/);
  assert.match(workerRuntime, /parseProductRecipeRoots/);
});

test('documented production local-worker startup supplies the absolute product recipe-root mapping', async () => {
  const readme = await readFile(new URL('README.md', repositoryRoot), 'utf8');
  const localWorkerSection = readme.match(/## Local worker(?<body>[\s\S]*?)## Delivery/)?.groups?.body;

  assert.ok(localWorkerSection, 'README must document local-worker startup');
  assert.match(localWorkerSection, /WORKER_PROVIDER_MODE="production"/);
  assert.match(
    localWorkerSection,
    /PRODUCT_RECIPE_ROOTS='\{"nuglet\.lesson\.v1":"\/absolute\/path\/to\/knowledge-bits\/recipes\/nuglet\.lesson\.v1"\}'/,
  );
  assert.match(localWorkerSection, /pnpm --filter @knowledge-bits\/worker exec tsx src\/index\.ts/);
});

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, repositoryRoot), 'utf8'));
}

async function sourceFiles(path) {
  const entries = await readdir(new URL(`${path}/`, repositoryRoot), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.(?:astro|js|mjs|ts)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [child] : [];
  }));
  return files.flat();
}
