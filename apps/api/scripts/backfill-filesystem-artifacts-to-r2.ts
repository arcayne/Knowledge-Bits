import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import {
  ArtifactStorageObjectNotFoundError,
} from '../src/services/artifacts.js';
import { createArtifactStorageFromEnv } from '../src/services/r2-artifacts.js';

const [sourceRootArgument, ...runIds] = process.argv.slice(2).filter((argument) => argument !== '--');

if (!sourceRootArgument || runIds.length === 0) {
  throw new Error('Usage: artifacts:backfill:r2 <filesystem-root> <run-id> [run-id...]');
}
if (process.env.ARTIFACT_STORAGE_MODE !== 'r2') {
  throw new Error('ARTIFACT_STORAGE_MODE must be r2 for an artifact backfill');
}

const sourceRoot = resolve(sourceRootArgument);
const storage = createArtifactStorageFromEnv(process.env);
const files = (await Promise.all(runIds.map(async (runId) => (
  walk(resolve(sourceRoot, 'knowledge-bits', 'nuglet', runId))
)))).flat().filter((path) => !path.endsWith('.knowledge-bits-meta.json'));

let uploaded = 0;
let alreadyPresent = 0;

await mapConcurrent(files, 6, async (filePath) => {
  const body = await readFile(filePath);
  const checksum = createHash('sha256').update(body).digest('hex');
  const storageKey = relative(sourceRoot, filePath).split(sep).join('/');
  const mediaType = await readMediaType(filePath);

  try {
    const current = await storage.inspect(storageKey);
    if (current.checksum !== checksum || current.byteSize !== body.byteLength) {
      throw new Error(`R2 object differs from the immutable local artifact: ${storageKey}`);
    }
    alreadyPresent += 1;
    return;
  } catch (error) {
    if (!(error instanceof ArtifactStorageObjectNotFoundError)) throw error;
  }

  const upload = await storage.preparePut({
    storageKey,
    mediaType,
    expiresInSeconds: 300,
  });
  const response = await fetch(upload.uploadUrl, {
    method: 'PUT',
    headers: upload.requiredHeaders,
    body,
  });
  if (!response.ok) {
    throw new Error(`R2 upload failed for ${storageKey}: ${response.status} ${response.statusText}`);
  }

  const stored = await storage.inspect(storageKey);
  if (stored.checksum !== checksum || stored.byteSize !== body.byteLength) {
    throw new Error(`R2 verification failed for ${storageKey}`);
  }
  uploaded += 1;
});

process.stdout.write(`${JSON.stringify({
  sourceRoot,
  runIds,
  considered: files.length,
  uploaded,
  alreadyPresent,
})}\n`);

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}

async function readMediaType(filePath: string): Promise<string> {
  try {
    const metadata = JSON.parse(await readFile(`${filePath}.knowledge-bits-meta.json`, 'utf8')) as {
      mediaType?: unknown;
    };
    return typeof metadata.mediaType === 'string'
      ? metadata.mediaType
      : 'application/octet-stream';
  } catch {
    return 'application/octet-stream';
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(values[index]!);
    }
  }));
}
