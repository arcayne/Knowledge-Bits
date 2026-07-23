import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);

test('API app exposes a catch-all Hono Vercel function from its documented root', async () => {
  const config = await readJson('apps/api/vercel.json');
  const packageJson = await readJson('apps/api/package.json');
  const entrypoint = await readFile(new URL('apps/api/api/index.js', repositoryRoot), 'utf8');
  const catchAllEntrypoint = await readFile(new URL('apps/api/api/[...path].js', repositoryRoot), 'utf8');
  const handler = await readFile(new URL('apps/api/api/handler.js', repositoryRoot), 'utf8');

  assert.equal(config.framework, null);
  assert.equal(config.installCommand, 'pnpm install --frozen-lockfile');
  assert.equal(config.buildCommand, 'pnpm build');
  assert.equal(config.functions['api/handler.js'].includeFiles, 'apps/api/dist/**');
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
    /PRODUCT_RECIPE_ROOTS='\{"nuglet\.lesson\.v1":"\/absolute\/path\/to\/nuglet\/apps\/nuglet-lab\/recipes\/nuglet\.lesson\.v1"\}'/,
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
