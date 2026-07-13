import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workerRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureOutput = new URL('../dist/providers/fixtures/', import.meta.url);

test('copies worker fixtures idempotently across consecutive builds', async () => {
  await rm(fixtureOutput, { recursive: true, force: true });

  execFileSync('pnpm', ['run', 'build'], { cwd: workerRoot, stdio: 'pipe' });
  const firstTree = await fixtureTree();
  execFileSync('pnpm', ['run', 'build'], { cwd: workerRoot, stdio: 'pipe' });
  const secondTree = await fixtureTree();

  assert.deepEqual(secondTree, firstTree);
  assert.equal(secondTree.some((path) => path.startsWith('fixtures/')), false);
});

async function fixtureTree(): Promise<string[]> {
  const walk = async (directory: URL, prefix = ''): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const path = `${prefix}${entry.name}`;
      return entry.isDirectory() ? walk(new URL(`${entry.name}/`, directory), `${path}/`) : [path];
    }));
    return files.flat().sort();
  };
  return walk(fixtureOutput);
}
