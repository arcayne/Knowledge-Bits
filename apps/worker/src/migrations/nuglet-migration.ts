import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import {
  nugletMigrationInventorySchema,
  type LegacyMediaReuse,
  type NugletMigrationInventory,
} from '@knowledge-bits/contracts';

export interface MaterializeNugletMigrationOptions {
  artifactRoot: string;
  nugletR2PublicBaseUrl?: string;
  fetch?: typeof fetch;
}

export async function materializeNugletMigration(
  value: unknown,
  options: MaterializeNugletMigrationOptions,
): Promise<LegacyMediaReuse> {
  const inventory = nugletMigrationInventorySchema.parse(value);
  const root = resolve(options.artifactRoot);
  const roles = Object.entries(inventory.artifacts) as Array<[
    keyof NugletMigrationInventory['artifacts'],
    NugletMigrationInventory['artifacts'][keyof NugletMigrationInventory['artifacts']],
  ]>;
  const materialized = await Promise.all(roles.map(async ([role, artifact]) => {
    const bytes = await readMigrationSource(artifact.source, options);
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    if (artifact.expectedChecksum && artifact.expectedChecksum !== checksum) {
      throw new Error(`Migration ${role} checksum does not match expectedChecksum`);
    }
    if (artifact.expectedByteSize && artifact.expectedByteSize !== bytes.byteLength) {
      throw new Error(`Migration ${role} byte size does not match expectedByteSize`);
    }
    return { role, bytes, receipt: {
      path: artifact.targetPath,
      checksum,
      byteSize: bytes.byteLength,
      mediaType: artifact.mediaType,
      ...('durationSeconds' in artifact ? { durationSeconds: artifact.durationSeconds } : {}),
    } } as const;
  }));

  const artifacts = Object.fromEntries(
    materialized.map(({ role, receipt }) => [role, receipt]),
  ) as LegacyMediaReuse['artifacts'];
  if (artifacts.audioBrief.checksum === artifacts.audioDiscussion.checksum) {
    throw new Error('Migration Brief and Discussion audio must be distinct');
  }
  await Promise.all(materialized.map(async ({ bytes, receipt }) => {
    const target = resolveInside(root, receipt.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }));
  const reuse: LegacyMediaReuse = {
    source: 'nuglet_published',
    sourceRunId: inventory.sourceRunId,
    sourcePackagePath: inventory.sourcePackagePath,
    notebookId: inventory.notebookId,
    artifacts,
  };
  const receiptPath = resolveInside(root, `${inventory.sourcePackagePath}/legacy-media-reuse.json`);
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(reuse, null, 2)}\n`, 'utf8');
  return reuse;
}

async function readMigrationSource(
  source: NugletMigrationInventory['artifacts']['hero']['source'],
  options: MaterializeNugletMigrationOptions,
): Promise<Uint8Array> {
  if (source.kind === 'filesystem') return readFile(source.path);
  const url = source.kind === 'https'
    ? source.url
    : r2PublicUrl(source.objectKey, options.nugletR2PublicBaseUrl);
  const response = await (options.fetch ?? fetch)(url);
  if (!response.ok) throw new Error(`Migration source request failed with ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function r2PublicUrl(objectKey: string, baseUrl: string | undefined): string {
  if (!baseUrl?.trim()) throw new Error('Nuglet R2 source requires nugletR2PublicBaseUrl');
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(objectKey.split('/').map(encodeURIComponent).join('/'), base).toString();
}

function resolveInside(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('Migration target escapes artifactRoot');
  }
  return target;
}
