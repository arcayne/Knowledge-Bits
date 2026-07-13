import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
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
  assert.equal(config.rewrites, undefined);
  assert.match(packageJson.scripts.build, /tsc -p tsconfig\.json/);
  assert.doesNotMatch(packageJson.scripts.build, /tsconfig\.vercel\.json/);
  assert.match(entrypoint, /from ['"]\.\/handler\.js['"]/);
  assert.match(catchAllEntrypoint, /from ['"]\.\/handler\.js['"]/);
  assert.match(handler, /from ['"]@hono\/node-server['"]/);
  assert.match(handler, /from ['"]\.\.\/dist\/runtime\.js['"]/);
  assert.match(handler, /['"]\/health['"]/);
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

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, repositoryRoot), 'utf8'));
}
