import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { materializeNugletMigration } from './nuglet-migration.js';

test('materializes all approved Nuglet media into one immutable local bundle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-bits-migration-'));
  try {
    const sourceDirectory = join(directory, 'sources');
    const artifactRoot = join(directory, 'artifacts');
    const sources = {
      hero: Buffer.from('hero-bytes'),
      infographic: Buffer.from('infographic-bytes'),
      audioBrief: Buffer.from('brief-bytes'),
      audioDiscussion: Buffer.from('discussion-bytes'),
    };
    await Promise.all(Object.entries(sources).map(async ([role, bytes]) => {
      await import('node:fs/promises').then(({ mkdir }) => mkdir(sourceDirectory, { recursive: true }));
      await writeFile(join(sourceDirectory, role), bytes);
    }));
    const asset = (role: keyof typeof sources, target: string, mediaType: string) => ({
      source: { kind: 'filesystem' as const, path: join(sourceDirectory, role) },
      targetPath: `migrations/example/${target}`,
      mediaType,
      expectedChecksum: prefixedChecksum(sources[role]),
      expectedByteSize: sources[role].byteLength,
    });
    const receipt = await materializeNugletMigration({
      schemaVersion: 'knowledge-bits.nuglet-migration.v1',
      nugletSlug: 'example',
      title: 'Example',
      sourceRunId: 'published-example',
      sourcePackagePath: 'migrations/example',
      notebookId: 'notebook-example',
      regenerate: ['story', 'playbook'],
      artifacts: {
        hero: asset('hero', 'hero.webp', 'image/webp'),
        infographic: asset('infographic', 'infographic.webp', 'image/webp'),
        audioBrief: { ...asset('audioBrief', 'brief.m4a', 'audio/mp4'), durationSeconds: 83 },
        audioDiscussion: { ...asset('audioDiscussion', 'discussion.m4a', 'audio/mp4'), durationSeconds: 271 },
      },
    }, { artifactRoot });

    assert.equal(receipt.artifacts.hero.checksum, prefixedChecksum(sources.hero));
    assert.equal(receipt.artifacts.audioBrief.durationSeconds, 83);
    assert.deepEqual(
      await readFile(join(artifactRoot, receipt.artifacts.infographic.path)),
      sources.infographic,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(artifactRoot, 'migrations/example/legacy-media-reuse.json'), 'utf8')),
      receipt,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function prefixedChecksum(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
