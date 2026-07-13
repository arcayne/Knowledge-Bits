import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type ProviderBinaryAsset,
  type ProviderExecution,
  type ProviderExecutionInput,
  type WorkerAction,
  type WorkerProvider,
} from './types.js';

const FIXTURE_FILE_BY_ACTION: Readonly<Record<WorkerAction, string>> = {
  collect_sources: 'collect-sources.json',
  create_content: 'create-content.json',
  check_content: 'check-content.json',
  produce_assets: 'produce-assets.json',
  deliver_package: 'deliver-package.json',
};

export class FixtureProvider implements WorkerProvider {
  readonly name = 'fixture';
  readonly capabilities = Object.keys(FIXTURE_FILE_BY_ACTION) as WorkerAction[];
  private readonly fixtureDirectory: URL;

  constructor(options: { fixtureDirectory?: string | URL } = {}) {
    this.fixtureDirectory = fixtureDirectoryUrl(options.fixtureDirectory);
  }

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    const fixtureName = FIXTURE_FILE_BY_ACTION[input.action];
    const rawResponse = await readFile(new URL(fixtureName, this.fixtureDirectory));
    const fixture = JSON.parse(rawResponse.toString('utf8')) as unknown;
    const fixtureChecksum = createHash('sha256').update(rawResponse).digest('hex');
    const parsed = parseFixture(fixture, input.job);

    return {
      kind: 'success',
      rawResponse,
      parsedOutput: parsed.parsedOutput,
      executionReport: {
        action: input.action,
        fixtureChecksum,
        idempotencyKey: input.idempotencyKey,
        provider: this.name,
      },
      ...(parsed.assets ? { assets: parsed.assets } : {}),
    };
  }
}

function fixtureDirectoryUrl(directory: string | URL | undefined): URL {
  if (directory instanceof URL) return trailingSlashUrl(directory);
  if (directory) return trailingSlashUrl(pathToFileURL(resolve(directory)));
  return new URL('./fixtures/', import.meta.url);
}

function trailingSlashUrl(url: URL): URL {
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`);
}

function parseFixture(value: unknown, job: ProviderExecutionInput['job']): {
  parsedOutput: unknown;
  assets?: ProviderBinaryAsset[];
} {
  if (!isRecord(value) || value.fixtureSchemaVersion !== 'knowledge-bits.fixture-provider.v1') {
    return { parsedOutput: resolveFixturePlaceholders(value, job) };
  }
  if (!('parsedOutput' in value)) throw new TypeError('Fixture provider envelope requires parsedOutput');
  if (value.assets === undefined) {
    return { parsedOutput: resolveFixturePlaceholders(value.parsedOutput, job) };
  }
  if (!Array.isArray(value.assets)) throw new TypeError('Fixture provider assets must be an array');

  return {
    parsedOutput: resolveFixturePlaceholders(value.parsedOutput, job),
    assets: value.assets.map((asset) => {
      if (!isRecord(asset)
        || typeof asset.kind !== 'string'
        || !asset.kind.trim()
        || typeof asset.mediaType !== 'string'
        || !asset.mediaType.trim()
        || typeof asset.bodyBase64 !== 'string'
        || !(asset.inputChecksum === null || typeof asset.inputChecksum === 'string')
        || (typeof asset.inputChecksum === 'string'
          && asset.inputChecksum !== '$contentChecksum'
          && !/^[a-f0-9]{64}$/.test(asset.inputChecksum))
        || (asset.provenance !== undefined && !isRecord(asset.provenance))) {
        throw new TypeError('Fixture provider asset is invalid');
      }
      const body = Buffer.from(asset.bodyBase64, 'base64');
      if (!body.byteLength) throw new TypeError('Fixture provider asset body is empty');
      return {
        kind: asset.kind,
        mediaType: asset.mediaType,
        body,
        inputChecksum: asset.inputChecksum === '$contentChecksum'
          ? contentChecksumDependency(job)
          : asset.inputChecksum,
        ...(asset.provenance ? { provenance: asset.provenance } : {}),
      };
    }),
  };
}

function resolveFixturePlaceholders(value: unknown, job: ProviderExecutionInput['job']): unknown {
  if (typeof value === 'string') {
    if (value === '$contentChecksum') return contentChecksumDependency(job);
    const prefix = '$snapshotArtifactId:';
    if (value.startsWith(prefix)) {
      const sourceId = value.slice(prefix.length);
      const dependency = artifactDependencies(job).find((candidate) => (
        candidate.kind === 'source_snapshot' && candidate.sourceId === sourceId
      ));
      if (!dependency) throw new TypeError(`Fixture provider cannot resolve source snapshot ${sourceId}`);
      return dependency.artifactId;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveFixturePlaceholders(item, job));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      resolveFixturePlaceholders(item, job),
    ]));
  }
  return value;
}

function contentChecksumDependency(job: ProviderExecutionInput['job']): string {
  const dependency = artifactDependencies(job).find((candidate) => (
    candidate.kind === 'parsed_output' && candidate.action === 'create_content'
  ));
  if (!dependency) throw new TypeError('Fixture provider cannot resolve the content checksum');
  return dependency.checksum;
}

function artifactDependencies(job: ProviderExecutionInput['job']): Array<{
  artifactId: string;
  kind: string;
  checksum: string;
  action: string;
  sourceId?: string;
}> {
  if (!Array.isArray(job.input.dependencies)) return [];
  return job.input.dependencies.filter((value): value is {
    artifactId: string;
    kind: string;
    checksum: string;
    action: string;
    sourceId?: string;
  } => (
    isRecord(value)
      && typeof value.artifactId === 'string'
      && typeof value.kind === 'string'
      && typeof value.checksum === 'string'
      && typeof value.action === 'string'
      && (value.sourceId === undefined || typeof value.sourceId === 'string')
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
