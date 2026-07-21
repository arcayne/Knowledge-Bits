import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = new URL('./pages/index.astro', import.meta.url);
const proxy = new URL('./pages/api/pipeline.ts', import.meta.url);
const client = new URL('./pipeline-client.mjs', import.meta.url);

test('pipeline page exposes daily throughput, operations, filters, and preview links', async () => {
  const source = await readFile(page, 'utf8');
  const clientSource = await readFile(client, 'utf8');

  assert.match(source, /Knowledge Bits pipeline/);
  assert.match(source, /data-filter="needs_human"/);
  assert.match(source, /data-filter="blocked"/);
  assert.match(source, /data-filter="retrying"/);
  assert.match(source, /data-filter="deliver"/);
  assert.match(source, /data-filter="completed"/);
  assert.match(source, /data-filter="duplicate"/);
  assert.match(source, /id="status-counts"/);
  assert.match(source, /id="stage-counts"/);
  assert.match(source, /id="pipeline-runs"/);
  assert.match(source, /id="daily-progress"/);
  assert.match(source, /id="operations"/);
  assert.match(clientSource, /fetch\('\/api\/pipeline'\)/);
  assert.match(clientSource, /href = `\/runs\//);
  assert.match(clientSource, /currentState === 'needs_human'/);
  assert.match(clientSource, /Active pipeline/);
  assert.match(clientSource, /Superseded by/);
  assert.match(clientSource, /delivered today/);
  assert.match(clientSource, /Retries scheduled/);
  assert.match(clientSource, /Delivery attempts/);
});

test('pipeline page proxy uses the authenticated review service', async () => {
  const source = await readFile(proxy, 'utf8');

  assert.match(source, /ENGINE_API_URL/);
  assert.match(source, /ENGINE_REVIEW_TOKEN/);
  assert.match(source, /path: '\/pipeline'/);
});
