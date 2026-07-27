import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);

test('local supervisor keeps API, review UI, and worker clock alive from one stable runtime', async () => {
  const [installer, review, worker, workerEntry] = await Promise.all([
    read('scripts/local-supervisor/install-launchd.zsh'),
    read('scripts/local-supervisor/knowledge-bits-review.zsh'),
    read('scripts/local-supervisor/knowledge-bits-worker-tick.zsh'),
    read('apps/worker/src/index.ts'),
  ]);

  assert.match(installer, /app\.knowledge-bits\.api/);
  assert.match(installer, /app\.knowledge-bits\.review/);
  assert.match(installer, /app\.knowledge-bits\.worker-tick/);
  assert.match(installer, /knowledge-bits-review\.zsh/);
  assert.match(installer, /bootstrap_service/);
  assert.match(installer, /StartInterval/);
  assert.match(installer, /KeepAlive/);

  assert.match(review, /ENGINE_API_URL=.*KNOWLEDGE_BITS_LOCAL_API_URL/);
  assert.match(review, /REVIEW_LOCAL_OPERATOR_ID is required/);
  assert.match(review, /astro dev/);

  assert.match(worker, /lock_owner=.*pid/);
  assert.match(worker, /kill -0/);
  assert.match(worker, /trap cleanup_lock EXIT INT TERM/);
  assert.match(worker, /ENGINE_API_BASE_URL%\/}\/health/);
  assert.match(worker, /for attempt in \{1\.\.30\}/);
  assert.match(workerEntry, /worker_tick_started/);
  assert.match(workerEntry, /worker_tick_completed/);
});

async function read(path) {
  return readFile(new URL(path, repositoryRoot), 'utf8');
}
