import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { nugletGenerationPlanSchema } from '@knowledge-bits/contracts';
import { calculateNugletGenerationInputChecksum } from '@knowledge-bits/pipeline';

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

const SCHEMA_1_1_FIXTURE_FILE_BY_ACTION: Partial<Record<WorkerAction, string>> = {
  create_content: 'create-content-story-playbook.json',
  produce_assets: 'produce-assets-dual-audio.json',
};

const JOAN_FIXTURE_FILE_BY_ACTION: Partial<Record<WorkerAction, string>> = {
  produce_assets: 'produce-assets-joan-photo-infographic.json',
};

export class FixtureProvider implements WorkerProvider {
  readonly name = 'fixture';
  readonly capabilities = Object.keys(FIXTURE_FILE_BY_ACTION) as WorkerAction[];
  private readonly fixtureDirectory: URL;

  constructor(options: { fixtureDirectory?: string | URL } = {}) {
    this.fixtureDirectory = fixtureDirectoryUrl(options.fixtureDirectory);
  }

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    const fixtureName = fixtureFileFor(input);
    const rawResponse = await readFile(new URL(fixtureName, this.fixtureDirectory));
    const fixture = JSON.parse(rawResponse.toString('utf8')) as unknown;
    const fixtureChecksum = createHash('sha256').update(rawResponse).digest('hex');
    const fixtureValues = await resolveFixtureValues(input, this.fixtureDirectory);
    const parsed = parseFixture(fixture, input.job, fixtureValues);

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
      ...(parsed.supportArtifacts ? { supportArtifacts: parsed.supportArtifacts } : {}),
    };
  }
}

async function resolveFixtureValues(
  input: ProviderExecutionInput,
  fixtureDirectory: URL,
): Promise<{ generationInputChecksum?: string }> {
  if (input.action !== 'produce_assets') return {};
  const brief = input.job.input.brief;
  const generationPlan = isRecord(brief) ? brief.generationPlan : undefined;
  if (!isRecord(generationPlan) || generationPlan.schemaVersion !== '1.1.0') return {};
  const rawContent = await readFile(new URL('create-content-story-playbook.json', fixtureDirectory));
  const contentFixture: unknown = JSON.parse(rawContent.toString('utf8'));
  if (!isRecord(contentFixture) || !('parsedOutput' in contentFixture)) {
    throw new TypeError('Schema 1.1.0 content fixture is invalid');
  }
  const semanticTarget = resolveFixturePlaceholders(contentFixture.parsedOutput, input.job, {});
  return {
    generationInputChecksum: calculateNugletGenerationInputChecksum({
      semanticTarget,
      generationPlan: nugletGenerationPlanSchema.parse(generationPlan),
    }),
  };
}

function fixtureFileFor(input: ProviderExecutionInput): string {
  const brief = input.job.input.brief;
  if (isRecord(brief) && brief.contentKind === 'joan.ai-video-brief.v1') {
    return JOAN_FIXTURE_FILE_BY_ACTION[input.action] ?? FIXTURE_FILE_BY_ACTION[input.action];
  }
  const generationPlan = isRecord(brief) && isRecord(brief.generationPlan)
    ? brief.generationPlan
    : undefined;
  return generationPlan?.schemaVersion === '1.1.0'
    ? SCHEMA_1_1_FIXTURE_FILE_BY_ACTION[input.action] ?? FIXTURE_FILE_BY_ACTION[input.action]
    : FIXTURE_FILE_BY_ACTION[input.action];
}

function fixtureDirectoryUrl(directory: string | URL | undefined): URL {
  if (directory instanceof URL) return trailingSlashUrl(directory);
  if (directory) return trailingSlashUrl(pathToFileURL(resolve(directory)));
  return new URL('./fixtures/', import.meta.url);
}

function trailingSlashUrl(url: URL): URL {
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`);
}

function parseFixture(
  value: unknown,
  job: ProviderExecutionInput['job'],
  fixtureValues: { generationInputChecksum?: string },
): {
  parsedOutput: unknown;
  assets?: ProviderBinaryAsset[];
  supportArtifacts?: Array<{
    kind: 'generation.recipe.snapshot' | 'generation.prompt.rendered' | 'generation.execution.report';
    mediaType: 'application/json' | 'text/plain';
    body: Uint8Array;
    inputChecksum: string | null;
    provenance: Readonly<Record<string, unknown>>;
  }>;
} {
  if (!isRecord(value) || value.fixtureSchemaVersion !== 'knowledge-bits.fixture-provider.v1') {
    return { parsedOutput: resolveFixturePlaceholders(value, job, fixtureValues) };
  }
  if (!('parsedOutput' in value)) throw new TypeError('Fixture provider envelope requires parsedOutput');
  if (value.assets !== undefined && !Array.isArray(value.assets)) {
    throw new TypeError('Fixture provider assets must be an array');
  }
  if (value.supportArtifacts !== undefined && !Array.isArray(value.supportArtifacts)) {
    throw new TypeError('Fixture provider supportArtifacts must be an array');
  }

  return {
    parsedOutput: resolveFixturePlaceholders(value.parsedOutput, job, fixtureValues),
    ...(value.assets ? { assets: value.assets.map((asset) => parseBinaryAsset(asset, job, fixtureValues)) } : {}),
    ...(value.supportArtifacts ? {
      supportArtifacts: value.supportArtifacts.map((artifact) => parseSupportArtifact(artifact, job, fixtureValues)),
    } : {}),
  };
}

function parseBinaryAsset(
  value: unknown,
  job: ProviderExecutionInput['job'],
  fixtureValues: { generationInputChecksum?: string },
): ProviderBinaryAsset {
  if (!isRecord(value)
    || typeof value.kind !== 'string'
    || !value.kind.trim()
    || typeof value.mediaType !== 'string'
    || !value.mediaType.trim()
    || typeof value.bodyBase64 !== 'string'
    || !validInputChecksum(value.inputChecksum)
    || (value.provenance !== undefined && !isRecord(value.provenance))) {
    throw new TypeError('Fixture provider asset is invalid');
  }
  return {
    kind: value.kind,
    mediaType: value.mediaType,
    body: requiredBody(value.bodyBase64, 'asset'),
    inputChecksum: resolvedInputChecksum(value.inputChecksum, job, fixtureValues),
    ...(value.provenance ? {
      provenance: resolveFixturePlaceholders(value.provenance, job, fixtureValues) as Record<string, unknown>,
    } : {}),
  };
}

function parseSupportArtifact(
  value: unknown,
  job: ProviderExecutionInput['job'],
  fixtureValues: { generationInputChecksum?: string },
) {
  if (!isRecord(value)
    || !['generation.recipe.snapshot', 'generation.prompt.rendered', 'generation.execution.report'].includes(String(value.kind))
    || !['application/json', 'text/plain'].includes(String(value.mediaType))
    || typeof value.bodyBase64 !== 'string'
    || !validInputChecksum(value.inputChecksum)
    || !isRecord(value.provenance)) {
    throw new TypeError('Fixture provider support artifact is invalid');
  }
  return {
    kind: value.kind as 'generation.recipe.snapshot' | 'generation.prompt.rendered' | 'generation.execution.report',
    mediaType: value.mediaType as 'application/json' | 'text/plain',
    body: requiredBody(value.bodyBase64, 'support artifact'),
    inputChecksum: resolvedInputChecksum(value.inputChecksum, job, fixtureValues),
    provenance: resolveFixturePlaceholders(value.provenance, job, fixtureValues) as Record<string, unknown>,
  };
}

function validInputChecksum(value: unknown): value is string | null {
  return value === null
    || value === '$contentChecksum'
    || value === '$generationInputChecksum'
    || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
}

function resolvedInputChecksum(
  value: string | null,
  job: ProviderExecutionInput['job'],
  fixtureValues: { generationInputChecksum?: string },
): string | null {
  if (value === '$contentChecksum') return contentChecksumDependency(job);
  if (value === '$generationInputChecksum') {
    if (!fixtureValues.generationInputChecksum) {
      throw new TypeError('Fixture provider cannot resolve the generation input checksum');
    }
    return fixtureValues.generationInputChecksum;
  }
  return value;
}

function requiredBody(value: string, label: string): Uint8Array {
  const body = Buffer.from(value, 'base64');
  if (!body.byteLength) throw new TypeError(`Fixture provider ${label} body is empty`);
  return body;
}

function resolveFixturePlaceholders(
  value: unknown,
  job: ProviderExecutionInput['job'],
  fixtureValues: { generationInputChecksum?: string },
): unknown {
  if (typeof value === 'string') {
    if (value === '$contentChecksum') return contentChecksumDependency(job);
    if (value === '$generationInputChecksum') {
      if (!fixtureValues.generationInputChecksum) {
        throw new TypeError('Fixture provider cannot resolve the generation input checksum');
      }
      return fixtureValues.generationInputChecksum;
    }
    if (value === '$youtubeVideoId') {
      const brief = job.input.brief;
      if (!isRecord(brief) || typeof brief.youtubeVideoId !== 'string') {
        throw new TypeError('Fixture provider cannot resolve the YouTube video ID');
      }
      return brief.youtubeVideoId;
    }
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
  if (Array.isArray(value)) return value.map((item) => resolveFixturePlaceholders(item, job, fixtureValues));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      resolveFixturePlaceholders(item, job, fixtureValues),
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
