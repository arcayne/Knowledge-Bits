import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateContentChecksum } from '@knowledge-bits/pipeline';
import type { NugletLessonV1Payload } from '@knowledge-bits/contracts';

import type { ArtifactStorageAdapter } from './artifacts.js';
import {
  ArtifactStorageObjectNotFoundError,
} from './artifacts.js';
import { ReviewPackageService } from './review-packages.js';
import { createApp } from '../app.js';
import {
  createInMemoryWorkflowStore,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';

const runId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const workerChecksum = 'f'.repeat(64);
const sourceId = '11111111-1111-4111-8111-111111111111';
const claimId = '11111111-1111-4111-8111-111111111112';
const snapshotArtifactId = '20000000-0000-4000-8000-000000000000';

class ReadableStorage implements ArtifactStorageAdapter {
  readonly objects = new Map<string, { body: Uint8Array; mediaType: string }>();
  readError: Error | null = null;

  async preparePut(): Promise<{ uploadUrl: string; requiredHeaders: Record<string, string> }> {
    throw new Error('not used');
  }

  async inspect(storageKey: string) {
    const object = this.objects.get(storageKey);
    if (!object) throw new Error('missing');
    return { checksum: 'a'.repeat(64), byteSize: object.body.byteLength, mediaType: object.mediaType };
  }

  async read(storageKey: string) {
    if (this.readError) throw this.readError;
    const object = this.objects.get(storageKey);
    if (!object) throw new Error('missing');
    return object.body;
  }
}

test('assembles and persists one checksum-bound review model from accepted artifacts', async () => {
  const { repository, storage } = await fixture();
  const service = new ReviewPackageService({ repository, storage });

  const model = await service.load(runId);
  const replay = await service.load(runId);
  const run = await repository.getRun(runId);
  const persisted = await repository.getPackageVersion(runId, model.package!.packageChecksum);

  assert.equal(model.decisionAllowed, true);
  assert.equal(model.package?.content.target.payload.title, 'Return to one task');
  assert.equal(model.package?.evidence.acceptedSources[0]?.title, 'Focused work evidence');
  assert.equal(model.package?.qa.deterministic.passed, true);
  assert.equal(model.assets.hero.state, 'available');
  assert.match(model.assets.hero.previewPath ?? '', new RegExp(`/runs/${runId}/artifacts/`));
  assert.notEqual(model.package?.packageChecksum, workerChecksum);
  assert.equal(run?.packageChecksum, model.package?.packageChecksum);
  assert.equal(replay.package?.id, model.package?.id);
  assert.equal(persisted?.id, model.package?.id);
});

test('keeps explicit missing asset states but blocks decisions when package data is unreadable', async () => {
  const { repository, storage, artifactKeys } = await fixture({ includeMedia: false });
  storage.objects.set(artifactKeys.content, { body: Buffer.from('{'), mediaType: 'application/json' });
  const service = new ReviewPackageService({ repository, storage });

  const model = await service.load(runId);

  assert.equal(model.decisionAllowed, false);
  assert.equal(model.package, null);
  assert.equal(model.assets.hero.state, 'missing');
  assert.match(model.issues.join(' '), /content.*unreadable/i);
});

test('blocks decisions when only required review media is missing', async () => {
  const { repository, storage } = await fixture({ includeMedia: false });
  const service = new ReviewPackageService({ repository, storage });

  const model = await service.load(runId);

  assert.equal(model.package?.content.target.payload.title, 'Return to one task');
  assert.equal(model.decisionAllowed, false);
  assert.equal(model.assets.hero.state, 'missing');
  assert.equal(model.assets.infographic.state, 'missing');
  assert.equal(model.assets.audio.state, 'missing');
  assert.match(model.issues.join(' '), /required review media/i);

  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_API_TOKEN: 'api-token',
      ENGINE_REVIEW_TOKEN: 'review-token',
    },
  });
  const decision = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer review-token', 'X-Knowledge-Bits-Reviewer': 'review-principal' },
    body: JSON.stringify({ decision: 'approve', packageChecksum: model.package?.packageChecksum }),
  });
  assert.equal(decision.status, 409, await decision.clone().text());
});

test('blocks approval for failed QA, blocking editorial findings, or stale asset inputs', async () => {
  for (const options of [
    { qaPassed: false },
    { blockingEditorial: true },
    { assetInputChecksum: 'd'.repeat(64) },
  ]) {
    const { repository, storage } = await fixture(options);
    const model = await new ReviewPackageService({ repository, storage }).load(runId);
    assert.equal(model.decisionAllowed, false);
    assert.ok(model.package);
    assert.match(model.issues.join(' '), /deterministic|editorial|checksum/i);
  }
});

test('excludes superseded assets so approval is bound to the displayed canonical package', async () => {
  const { repository, storage, mediaId, staleMediaId } = await fixture({ includeStaleHero: true });
  const service = new ReviewPackageService({ repository, storage });

  const model = await service.load(runId);
  const packagedHeroes = model.package?.artifactInventory.filter((artifact) => artifact.kind === 'hero');

  assert.equal(model.decisionAllowed, true);
  assert.equal(model.assets.hero.artifactId, mediaId);
  assert.deepEqual(packagedHeroes?.map((artifact) => artifact.artifactId), [mediaId]);
  assert.ok(!model.package?.artifactInventory.some((artifact) => artifact.artifactId === staleMediaId));
  await assert.rejects(service.readArtifact(runId, staleMediaId!), /artifact.*package/i);

  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_API_TOKEN: 'api-token',
      ENGINE_REVIEW_TOKEN: 'review-token',
    },
  });
  const decision = await app.request(`/runs/${runId}/review`, {
    method: 'POST',
    headers: { Authorization: 'Bearer review-token', 'X-Knowledge-Bits-Reviewer': 'review-principal' },
    body: JSON.stringify({ decision: 'approve', packageChecksum: model.package?.packageChecksum }),
  });
  assert.equal(decision.status, 200, await decision.clone().text());
});

test('reads only an artifact included in the current immutable package', async () => {
  const { repository, storage, mediaId } = await fixture();
  const service = new ReviewPackageService({ repository, storage });
  await service.load(runId);

  const artifact = await service.readArtifact(runId, mediaId!);
  assert.equal(Buffer.from(artifact.body).toString(), 'hero-image');
  assert.equal(artifact.mediaType, 'image/webp');
  await assert.rejects(service.readArtifact(runId, '99999999-9999-4999-8999-999999999999'), /artifact.*package/i);
});

test('serves the review model and artifact bytes only to the configured review principal', async () => {
  const { repository, storage, mediaId } = await fixture();
  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_API_TOKEN: 'api-token',
      ENGINE_REVIEW_TOKEN: 'review-token',
    },
  });

  const missingAuth = await app.request(`/runs/${runId}/review`);
  assert.equal(missingAuth.status, 401);
  const response = await app.request(`/runs/${runId}/review`, {
    headers: { Authorization: 'Bearer review-token', 'X-Knowledge-Bits-Reviewer': 'review-principal' },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const model = await response.json() as { decisionAllowed: boolean; package: { packageChecksum: string } };
  assert.equal(model.decisionAllowed, true);

  const artifact = await app.request(`/runs/${runId}/artifacts/${mediaId}`, {
    headers: { Authorization: 'Bearer review-token' },
  });
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), 'hero-image');
  assert.equal(artifact.headers.get('content-type'), 'image/webp');
});

test('maps authenticated artifact-read object misses to 404 and generic adapter failures to 503', async () => {
  const { repository, storage, mediaId } = await fixture();
  const app = createApp({
    repository,
    artifactStorage: storage,
    env: {
      ENGINE_API_TOKEN: 'api-token',
      ENGINE_REVIEW_TOKEN: 'review-token',
    },
  });
  const headers = { Authorization: 'Bearer review-token', 'X-Knowledge-Bits-Reviewer': 'review-principal' };
  const loaded = await app.request(`/runs/${runId}/review`, { headers });
  assert.equal(loaded.status, 200);

  storage.readError = new ArtifactStorageObjectNotFoundError('Stored artifact is missing');
  const missing = await app.request(`/runs/${runId}/artifacts/${mediaId}`, { headers });
  assert.equal(missing.status, 404, await missing.clone().text());

  storage.readError = new Error('adapter connection reset');
  const unavailable = await app.request(`/runs/${runId}/artifacts/${mediaId}`, { headers });
  assert.equal(unavailable.status, 503, await unavailable.clone().text());
});

async function fixture(options: {
  includeMedia?: boolean;
  includeStaleHero?: boolean;
  qaPassed?: boolean;
  blockingEditorial?: boolean;
  assetInputChecksum?: string;
} = {}) {
  const repository = new WorkflowRepository(createInMemoryWorkflowStore());
  repository.listArtifactsForSuccessfulStageJobs = (id, revision) => repository.listArtifacts(id, revision);
  const storage = new ReadableStorage();
  await repository.createRun({
    id: runId,
    title: 'Return to one task',
    locale: 'en',
    brief: { objective: 'Make one focused next step.' },
    currentStage: 'human_review',
    packageChecksum: workerChecksum,
    stages: [{ name: 'human_review', state: 'needs_human' }],
  });

  const artifactKeys = {
    evidence: 'objects/evidence',
    content: 'objects/content',
    qa: 'objects/qa',
    hero: 'objects/hero',
    infographic: 'objects/infographic',
    audio: 'objects/audio',
    staleHero: 'objects/stale-hero',
    snapshot: 'objects/snapshot',
  };
  const inputs: Array<{
    id: string;
    kind: string;
    storageKey: string;
    action: string;
    mediaType: string;
    body: unknown;
    inputChecksum?: string | null;
    provenance?: Record<string, unknown>;
  }> = [
    {
      id: snapshotArtifactId,
      kind: 'source_snapshot',
      storageKey: artifactKeys.snapshot,
      action: 'collect_sources',
      mediaType: 'text/plain',
      body: 'A short reset followed by one written next action can reduce restart friction.',
      provenance: { sourceId },
    },
    {
      id: '20000000-0000-4000-8000-000000000001',
      kind: 'parsed_output',
      storageKey: artifactKeys.evidence,
      action: 'collect_sources',
      mediaType: 'application/json',
      body: {
        acceptedSources: [{
          sourceId,
          title: 'Focused work evidence',
          url: 'https://example.test/focused-work',
          retrievedAt: '2026-07-13T10:00:00.000Z',
          snapshotChecksum: 'a'.repeat(64),
          readability: { passed: true, reason: null },
          credibility: { passed: true, policy: 'fixture-trusted-hosts.v1', reason: null },
        }],
        rejectedSources: [],
        coverageGaps: [],
      },
    },
    {
      id: '20000000-0000-4000-8000-000000000002',
      kind: 'parsed_output',
      storageKey: artifactKeys.content,
      action: 'create_content',
      mediaType: 'application/json',
      body: contentOutput(),
    },
    {
      id: '20000000-0000-4000-8000-000000000003',
      kind: 'parsed_output',
      storageKey: artifactKeys.qa,
      action: 'check_content',
      mediaType: 'application/json',
      body: {
        deterministic: {
          passed: options.qaPassed !== false,
          contentChecksum: calculateContentChecksum(contentOutput()),
          findings: options.qaPassed === false ? [{ code: 'claim-coverage', message: 'Coverage is incomplete.' }] : [],
        },
        editorial: {
          summary: options.blockingEditorial ? 'Needs revision.' : 'Ready for structural review.',
          findings: options.blockingEditorial
            ? [{ code: 'unsupported-claim', severity: 'major', blocking: true, message: 'A claim is unsupported.' }]
            : [],
        },
      },
    },
  ];
  if (options.includeMedia !== false) {
    if (options.includeStaleHero) {
      inputs.push({
        id: '10000000-0000-4000-8000-000000000007',
        kind: 'hero',
        storageKey: artifactKeys.staleHero,
        action: 'produce_assets',
        mediaType: 'image/webp',
        body: 'stale-hero-image',
        inputChecksum: 'd'.repeat(64),
      });
    }
    inputs.push(
      {
        id: '20000000-0000-4000-8000-000000000004',
        kind: 'hero',
        storageKey: artifactKeys.hero,
        action: 'produce_assets',
        mediaType: 'image/webp',
        body: 'hero-image',
        inputChecksum: options.assetInputChecksum ?? calculateContentChecksum(contentOutput()),
      },
      {
        id: '20000000-0000-4000-8000-000000000005',
        kind: 'infographic',
        storageKey: artifactKeys.infographic,
        action: 'produce_assets',
        mediaType: 'image/webp',
        body: 'infographic-image',
        inputChecksum: options.assetInputChecksum ?? calculateContentChecksum(contentOutput()),
      },
      {
        id: '20000000-0000-4000-8000-000000000006',
        kind: 'audio',
        storageKey: artifactKeys.audio,
        action: 'produce_assets',
        mediaType: 'audio/mpeg',
        body: 'audio-bytes',
        inputChecksum: options.assetInputChecksum ?? calculateContentChecksum(contentOutput()),
      },
    );
  }

  for (const input of inputs) {
    const bytes = typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(JSON.stringify(input.body));
    storage.objects.set(input.storageKey, { body: bytes, mediaType: input.mediaType });
    await repository.recordArtifact({
      id: input.id,
      runId,
      revision: 1,
      kind: input.kind,
      mediaType: input.mediaType,
      checksum: 'a'.repeat(64),
      storageKey: input.storageKey,
      byteSize: bytes.byteLength,
      provenance: { action: input.action, provider: 'fixture', ...input.provenance },
      inputChecksum: input.inputChecksum ?? null,
      jobId: `30000000-0000-4000-8000-00000000000${inputs.indexOf(input) + 1}`,
      stage: input.action === 'collect_sources'
        ? 'research'
        : input.action === 'create_content'
          ? 'create'
          : input.action === 'check_content'
            ? 'check'
            : 'produce_assets',
      action: input.action,
    });
  }

  return {
    repository,
    storage,
    artifactKeys,
    mediaId: options.includeMedia === false ? null : '20000000-0000-4000-8000-000000000004',
    staleMediaId: options.includeStaleHero ? '10000000-0000-4000-8000-000000000007' : null,
  };
}

function contentOutput(): NugletLessonV1Payload {
  const citation = {
    sourceId,
    snapshotArtifactId,
    excerpt: 'A short reset followed by one written next action can reduce restart friction.',
  };
  return {
    title: 'Return to one task',
    takeaway: 'Name the next step.',
    action: 'Write the next step down.',
    depths: { quick: 'Name it.', core: 'Write it down.', deep: 'Remove restart friction.' },
    claims: [{ claimId, statement: 'A short reset can help.', citations: [citation] }],
    claimCoverage: [
      { path: 'title', claimIds: [claimId] },
      { path: 'takeaway', claimIds: [claimId] },
      { path: 'action', claimIds: [claimId] },
      { path: 'depths.quick', claimIds: [claimId] },
      { path: 'depths.core', claimIds: [claimId] },
      { path: 'depths.deep', claimIds: [claimId] },
    ],
  };
}
