import {
  artifactReferenceSchema,
  knowledgeBitsContentSchema,
  knowledgeBitsEvidenceSchema,
  knowledgeBitsQaSchema,
  nugletGenerationPlanSchema,
  reviewPackageVersionSchema,
  reviewReadModelSchema,
  type ArtifactReference,
  type KnowledgeBitsEvidence,
  type NugletGenerationPlan,
  type ReviewGenerationExecution,
  type ReviewGenerationExecutions,
  type ReviewGenerationRole,
  type ReviewReadModel,
} from '@knowledge-bits/contracts';
import { calculateContentChecksum, calculatePackageChecksum } from '@knowledge-bits/pipeline';

import type {
  WorkflowArtifact,
  WorkflowRepository,
} from '../repositories/workflow-repository.js';
import {
  readArtifactStorageObject,
  type ArtifactStorageAdapter,
} from './artifacts.js';
import {
  calculateStoryPlaybookGenerationInputChecksum,
  materializeStoryPlaybookTarget,
  NUGLET_REVIEW_MEDIA_KINDS,
  type NugletReviewMediaKind,
} from './nuglet-package-materializer.js';

const ADAPTER_VERSION = 'knowledge-bits.review-package.v1';
const OWNER = 'knowledge-bits-engine';
const USAGE_RIGHTS = { scope: 'internal-review' };
const REVIEW_ASSETS = [
  { kind: 'hero', key: 'hero' },
  { kind: 'infographic', key: 'infographic' },
  { kind: 'audio_brief', key: 'audioBrief' },
  { kind: 'audio_discussion', key: 'audioDiscussion' },
] as const;
const REVIEW_ASSET_KINDS = NUGLET_REVIEW_MEDIA_KINDS;

export class ReviewPackageService {
  constructor(private readonly dependencies: {
    repository: WorkflowRepository;
    storage: ArtifactStorageAdapter;
  }) {}

  async load(runId: string): Promise<ReviewReadModel> {
    const run = await this.dependencies.repository.getRun(runId);
    if (!run) throw new ReviewPackageNotFoundError('Run not found');
    const artifacts = await this.dependencies.repository.listArtifactsForSuccessfulStageJobs(run.id, run.currentRevision);
    const packageArtifacts = canonicalPackageArtifacts(artifacts.filter((artifact) => (
      !isReviewAssetKind(artifact.kind) || artifact.revision === run.currentRevision
    )));
    const assets = assetStates(run.id, packageArtifacts);
    const mediaIssues = REVIEW_ASSETS
      .filter(({ key }) => assets[key].state === 'missing')
      .map(({ kind }) => `Required review media is missing: ${kind}`);

    try {
      for (const kind of REVIEW_ASSET_KINDS) {
        const artifact = latestArtifact(packageArtifacts, kind);
        if (artifact) await readArtifactStorageObject(this.dependencies.storage, artifact.storageKey);
      }
      const evidenceArtifact = requiredParsedArtifact(packageArtifacts, 'collect_sources', 'evidence');
      const contentArtifact = requiredParsedArtifact(packageArtifacts, 'create_content', 'content');
      const qaArtifact = requiredParsedArtifact(packageArtifacts, 'check_content', 'QA');
      const contentOutput = await this.readJson(contentArtifact, 'content');
      const qaOutput = await this.readJson(qaArtifact, 'QA');
      const assembled = assembleContent(run.brief, contentOutput, packageArtifacts);
      const content = assembled.content;
      const generationExecutions = assembled.generationExecutions;
      const evidenceOutput = await this.readJson(evidenceArtifact, 'evidence');
      const evidence = normalizeEvidence(evidenceOutput, evidenceArtifact, packageArtifacts, content.target.payload.claims);
      const qa = knowledgeBitsQaSchema.parse(qaOutput);
      const artifactInventory = packageArtifacts.map(toArtifactReference);
      const approvalIssues = [
        ...mediaIssues,
        ...qaApprovalIssues(qa, assembled.semanticChecksum),
        ...assetChecksumIssues(packageArtifacts, assembled.generationInputChecksum),
      ];
      const warnings = editorialWarnings(qa);
      const packageChecksum = calculatePackageChecksum({
        content,
        evidence,
        qa,
        assetInventory: artifactInventory,
        adapterVersion: ADAPTER_VERSION,
        locale: run.locale,
        owner: OWNER,
        usageRights: USAGE_RIGHTS,
      });
      const persisted = await this.dependencies.repository.recordPackageVersion({
        runId: run.id,
        revision: run.currentRevision,
        packageChecksum,
        adapterVersion: ADAPTER_VERSION,
        locale: run.locale,
        owner: OWNER,
        usageRights: USAGE_RIGHTS,
        content,
        evidence,
        qa,
        artifactInventory,
      });
      const packageVersion = reviewPackageVersionSchema.parse({
        id: persisted.id,
        schemaVersion: 'knowledge-bits.review-package.v1',
        packageId: persisted.runId,
        revision: persisted.revision,
        packageChecksum: persisted.packageChecksum,
        adapterVersion: persisted.adapterVersion,
        locale: persisted.locale,
        owner: persisted.owner,
        usageRights: persisted.usageRights,
        content: persisted.content,
        evidence: persisted.evidence,
        qa: persisted.qa,
        artifactInventory: persisted.artifactInventory,
      });
      const current = await this.dependencies.repository.getRun(run.id);
      if (!current) throw new ReviewPackageNotFoundError('Run not found');
      return reviewReadModelSchema.parse({
        runId: current.id,
        title: current.title,
        currentStage: current.currentStage,
        currentRevision: current.currentRevision,
        reviewStatus: current.reviewStatus,
        currentPackageChecksum: current.packageChecksum,
        decisionAllowed: current.currentStage === 'human_review'
          && current.reviewStatus === 'pending'
          && current.packageChecksum === packageVersion.packageChecksum
          && approvalIssues.length === 0,
        issues: approvalIssues,
        warnings,
        package: packageVersion,
        assets,
        generationExecutions,
      });
    } catch (error) {
      if (error instanceof ReviewPackageNotFoundError) throw error;
      return reviewReadModelSchema.parse({
        runId: run.id,
        title: run.title,
        currentStage: run.currentStage,
        currentRevision: run.currentRevision,
        reviewStatus: run.reviewStatus,
        currentPackageChecksum: run.packageChecksum,
        decisionAllowed: false,
        issues: [assemblyErrorMessage(error)],
        warnings: [],
        package: null,
        assets,
        generationExecutions: emptyGenerationExecutions(),
      });
    }
  }

  async readArtifact(runId: string, artifactId: string): Promise<{ body: Uint8Array; mediaType: string }> {
    const run = await this.dependencies.repository.getRun(runId);
    if (!run?.packageChecksum) throw new ReviewPackageNotFoundError('Artifact is not in the current package');
    const packageVersion = await this.dependencies.repository.getPackageVersion(run.id, run.packageChecksum);
    if (!packageVersion?.artifactInventory.some((artifact) => artifact.artifactId === artifactId)) {
      throw new ReviewPackageNotFoundError('Artifact is not in the current package');
    }
    const artifact = await this.dependencies.repository.getArtifact(run.id, artifactId);
    if (!artifact) throw new ReviewPackageNotFoundError('Artifact is not in the current package');
    return {
      body: await readArtifactStorageObject(this.dependencies.storage, artifact.storageKey),
      mediaType: artifact.mediaType,
    };
  }

  private async readJson(artifact: WorkflowArtifact, label: string): Promise<Record<string, unknown>> {
    try {
      const body = await readArtifactStorageObject(this.dependencies.storage, artifact.storageKey);
      const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('expected an object');
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new ReviewPackageAssemblyError(`${label} artifact is unreadable: ${errorMessage(error)}`);
    }
  }
}

export class ReviewPackageNotFoundError extends Error {}
export class ReviewPackageAssemblyError extends Error {}

function assembleContent(
  brief: Record<string, unknown>,
  contentOutput: Record<string, unknown>,
  artifacts: readonly WorkflowArtifact[],
) {
  if (contentOutput.kind === 'nuglet.lesson.v1' && contentOutput.schemaVersion === '1.1.0') {
    const generationPlan = generationPlanFromBrief(brief);
    const semanticChecksum = calculateContentChecksum(contentOutput);
    const generationInputChecksum = calculateStoryPlaybookGenerationInputChecksum(contentOutput, generationPlan);
    const mediaArtifacts = Object.fromEntries(REVIEW_ASSET_KINDS.map((kind) => [
      kind,
      latestArtifact(artifacts, kind),
    ])) as Partial<Record<NugletReviewMediaKind, WorkflowArtifact>>;
    const target = materializeStoryPlaybookTarget({
      semanticTarget: contentOutput,
      generationPlan,
      mediaArtifacts,
    });
    const content = knowledgeBitsContentSchema.parse({
      schemaVersion: 'knowledge-bits.content.v1',
      target,
    });
    const generationExecutions = assembleGenerationExecutions(artifacts, generationPlan);
    assertHeroReferenceProvenance(generationExecutions.hero);
    return { content, generationExecutions, generationInputChecksum, semanticChecksum };
  }

  const content = knowledgeBitsContentSchema.parse({
    schemaVersion: 'knowledge-bits.content.v1',
    target: { kind: 'nuglet.lesson.v1', payload: contentOutput },
  });
  return {
    content,
    generationExecutions: emptyGenerationExecutions(),
    generationInputChecksum: calculateContentChecksum(content.target.payload),
    semanticChecksum: calculateContentChecksum(content.target.payload),
  };
}

function generationPlanFromBrief(brief: Record<string, unknown>): NugletGenerationPlan {
  const parsed = nugletGenerationPlanSchema.safeParse(brief.generationPlan);
  if (!parsed.success) throw new ReviewPackageAssemblyError('Nuglet generation plan is missing or unreadable');
  return parsed.data;
}

const GENERATION_ROLE_BINDINGS = [
  { role: 'story', recipeKey: 'story', action: 'create_content', outputKind: 'parsed_output' },
  { role: 'playbook', recipeKey: 'playbook', action: 'create_content', outputKind: 'parsed_output' },
  { role: 'quiz', recipeKey: 'challenge', action: 'create_content', outputKind: 'parsed_output' },
  { role: 'hero', recipeKey: 'hero', action: 'produce_assets', outputKind: 'hero' },
  { role: 'infographic', recipeKey: 'infographic', action: 'produce_assets', outputKind: 'infographic' },
  { role: 'audioBrief', recipeKey: 'audioBrief', action: 'produce_assets', outputKind: 'audio_brief' },
  { role: 'audioDiscussion', recipeKey: 'audioDiscussion', action: 'produce_assets', outputKind: 'audio_discussion' },
] as const satisfies readonly {
  role: ReviewGenerationRole;
  recipeKey: keyof NugletGenerationPlan['recipes'];
  action: string;
  outputKind: string;
}[];

export function assembleGenerationExecutions(
  artifacts: readonly WorkflowArtifact[],
  generationPlan: NugletGenerationPlan,
): ReviewGenerationExecutions {
  const result = emptyGenerationExecutions();
  for (const binding of GENERATION_ROLE_BINDINGS) {
    const recipe = generationPlan.recipes[binding.recipeKey];
    const output = latestArtifactForAction(artifacts, binding.outputKind, binding.action);
    if (!output || !executorBindingMatches(output)) {
      throw new ReviewPackageAssemblyError(`${binding.role} selected output execution provenance is missing`);
    }
    const snapshots = artifacts.filter((artifact) => (
      artifact.kind === 'generation.recipe.snapshot'
      && artifact.action === binding.action
      && executorBindingMatches(artifact)
      && sameExecutorIdentity(artifact, output)
      && provenanceMatchesRecipe(artifact.provenance, recipe)
      && outputBindingMatches(artifact.provenance, output)
    ));
    if (snapshots.length === 0) {
      throw new ReviewPackageAssemblyError(`${binding.role} selected output execution has no matching recipe snapshot`);
    }

    for (const snapshot of snapshots) {
      const execution = readExecutionProvenance(snapshot.provenance, binding.role);
      if (`sha256:${snapshot.checksum}` !== execution.recipeChecksum) {
        throw new ReviewPackageAssemblyError(`${binding.role} generation recipe snapshot checksum is mismatched`);
      }
      const prompts = artifacts.filter((artifact) => (
        artifact.kind === 'generation.prompt.rendered'
        && artifact.jobId === snapshot.jobId
        && artifact.action === binding.action
        && executorBindingMatches(artifact)
        && sameExecutorIdentity(artifact, output)
        && sameExecutionProvenance(artifact.provenance, execution)
      ));
      if (prompts.length !== 1) {
        throw new ReviewPackageAssemblyError(`${binding.role} generation provenance is missing a rendered prompt`);
      }
      const prompt = prompts[0]!;
      if (`sha256:${prompt.checksum}` !== execution.promptChecksum) {
        throw new ReviewPackageAssemblyError(`${binding.role} rendered prompt checksum is mismatched`);
      }
      const reports = artifacts.filter((artifact) => (
        artifact.kind === 'generation.execution.report'
        && artifact.jobId === snapshot.jobId
        && artifact.action === binding.action
        && executorBindingMatches(artifact)
        && sameExecutorIdentity(artifact, output)
        && reportContainsExecution(artifact.provenance, execution)
      ));
      if (reports.length !== 1) {
        throw new ReviewPackageAssemblyError(`${binding.role} generation provenance is missing a current execution report`);
      }
      result[binding.role].push({
        role: binding.role,
        jobId: output.jobId!,
        executionId: nonEmptyString(output.provenance.idempotencyKey)!,
        recipe: {
          id: execution.recipeId,
          version: execution.recipeVersion,
          checksum: execution.recipeChecksum,
        },
        model: execution.model,
        outputKind: execution.outputKind,
        outputChecksum: execution.outputChecksum,
        promptChecksum: execution.promptChecksum,
        referenceChecksums: [...execution.referenceChecksums],
        recipeSnapshot: toArtifactReference(snapshot) as ReviewGenerationExecution['recipeSnapshot'],
        renderedPrompt: toArtifactReference(prompt) as ReviewGenerationExecution['renderedPrompt'],
        executionReport: toArtifactReference(reports[0]!) as ReviewGenerationExecution['executionReport'],
      });
    }
  }
  return result;
}

interface GenerationExecutionProvenance {
  recipeId: string;
  recipeVersion: string;
  recipeChecksum: string;
  promptChecksum: string;
  model: string;
  outputKind: string;
  outputChecksum: string;
  referenceChecksums: readonly string[];
}

function readExecutionProvenance(
  value: Record<string, unknown>,
  role: ReviewGenerationRole,
): GenerationExecutionProvenance {
  const recipeId = nonEmptyString(value.recipeId);
  const recipeVersion = nonEmptyString(value.recipeVersion);
  const recipeChecksum = prefixedChecksum(value.recipeChecksum);
  const promptChecksum = prefixedChecksum(value.promptChecksum);
  const model = nonEmptyString(value.model);
  const outputKind = nonEmptyString(value.outputKind);
  const outputChecksum = prefixedChecksum(value.outputChecksum);
  const referenceChecksums = prefixedChecksumList(value.referenceChecksums);
  if (!recipeId || !recipeVersion || !recipeChecksum || !promptChecksum || !model
    || !outputKind || !outputChecksum || !referenceChecksums) {
    throw new ReviewPackageAssemblyError(`${role} generation provenance is incomplete`);
  }
  return {
    recipeId,
    recipeVersion,
    recipeChecksum,
    promptChecksum,
    model,
    outputKind,
    outputChecksum,
    referenceChecksums,
  };
}

function provenanceMatchesRecipe(
  provenance: Record<string, unknown>,
  recipe: NugletGenerationPlan['recipes'][keyof NugletGenerationPlan['recipes']],
): boolean {
  return provenance.recipeId === recipe.id
    && provenance.recipeVersion === recipe.version
    && provenance.recipeChecksum === recipe.checksum;
}

function executorBindingMatches(artifact: WorkflowArtifact): boolean {
  return artifact.jobId !== null
    && artifact.action !== null
    && artifact.provenance.jobId === artifact.jobId
    && artifact.provenance.action === artifact.action
    && Boolean(nonEmptyString(artifact.provenance.idempotencyKey));
}

function sameExecutorIdentity(left: WorkflowArtifact, right: WorkflowArtifact): boolean {
  return left.jobId === right.jobId
    && left.action === right.action
    && left.provenance.idempotencyKey === right.provenance.idempotencyKey
    && left.provenance.provider === right.provenance.provider;
}

function outputBindingMatches(
  provenance: Record<string, unknown>,
  output: WorkflowArtifact,
): boolean {
  return provenance.outputKind === output.kind
    && provenance.outputChecksum === `sha256:${output.checksum}`;
}

function sameExecutionProvenance(
  provenance: Record<string, unknown>,
  execution: GenerationExecutionProvenance,
): boolean {
  try {
    return JSON.stringify(readExecutionProvenance(provenance, 'story')) === JSON.stringify(execution);
  } catch {
    return false;
  }
}

function reportContainsExecution(
  provenance: Record<string, unknown>,
  execution: GenerationExecutionProvenance,
): boolean {
  const values = Array.isArray(provenance.generationExecutions)
    ? provenance.generationExecutions
    : [provenance];
  return values.some((value) => isRecord(value) && sameExecutionProvenance(value, execution));
}

function assertHeroReferenceProvenance(executions: readonly ReviewGenerationExecution[]): void {
  const expected = executions[0]?.referenceChecksums;
  if (!expected || expected.length !== 2 || executions.some((execution) => (
    JSON.stringify(execution.referenceChecksums) !== JSON.stringify(expected)
  ))) {
    throw new ReviewPackageAssemblyError('Hero reference checksum provenance is mismatched');
  }
}

function emptyGenerationExecutions(): ReviewGenerationExecutions {
  return {
    story: [],
    playbook: [],
    quiz: [],
    hero: [],
    infographic: [],
    audioBrief: [],
    audioDiscussion: [],
  };
}

function requiredParsedArtifact(
  artifacts: readonly WorkflowArtifact[],
  action: string,
  label: string,
): WorkflowArtifact {
  const artifact = [...artifacts].reverse().find((candidate) => (
    candidate.kind === 'parsed_output' && candidate.action === action
  ));
  if (!artifact) throw new ReviewPackageAssemblyError(`${label} artifact is missing`);
  return artifact;
}

function latestArtifact(artifacts: readonly WorkflowArtifact[], kind: string): WorkflowArtifact | undefined {
  return [...artifacts].reverse().find((artifact) => artifact.kind === kind);
}

function latestArtifactForAction(
  artifacts: readonly WorkflowArtifact[],
  kind: string,
  action: string,
): WorkflowArtifact | undefined {
  return [...artifacts].reverse().find((artifact) => artifact.kind === kind && artifact.action === action);
}

function canonicalPackageArtifacts(artifacts: readonly WorkflowArtifact[]): WorkflowArtifact[] {
  const requiredAssets = new Map(REVIEW_ASSET_KINDS.map((kind) => [kind, latestArtifact(artifacts, kind)]));
  return artifacts.filter((artifact) => {
    if (!isReviewAssetKind(artifact.kind)) return true;
    return requiredAssets.get(artifact.kind)?.id === artifact.id;
  });
}

function isReviewAssetKind(kind: string): kind is typeof REVIEW_ASSET_KINDS[number] {
  return REVIEW_ASSET_KINDS.some((candidate) => candidate === kind);
}

function assetStates(runId: string, artifacts: readonly WorkflowArtifact[]) {
  return Object.fromEntries(REVIEW_ASSETS.map(({ kind, key }) => {
    const artifact = latestArtifact(artifacts, kind);
    return [key, artifact ? {
      state: 'available' as const,
      artifactId: artifact.id,
      mediaType: artifact.mediaType,
      previewPath: `/runs/${runId}/artifacts/${artifact.id}`,
    } : {
      state: 'missing' as const,
      artifactId: null,
      mediaType: null,
      previewPath: null,
    }];
  })) as Record<typeof REVIEW_ASSETS[number]['key'], {
    state: 'available' | 'missing';
    artifactId: string | null;
    mediaType: string | null;
    previewPath: string | null;
  }>;
}

function toArtifactReference(artifact: WorkflowArtifact): ArtifactReference {
  return artifactReferenceSchema.parse({
    artifactId: artifact.id,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    checksum: artifact.checksum,
    storageKey: artifact.storageKey,
    byteSize: artifact.byteSize,
    createdAt: artifact.createdAt.toISOString(),
    provider: typeof artifact.provenance.provider === 'string' && artifact.provenance.provider.trim()
      ? artifact.provenance.provider
      : 'unknown',
    inputChecksum: artifact.inputChecksum,
  });
}

function normalizeEvidence(
  output: Record<string, unknown>,
  artifact: WorkflowArtifact,
  artifacts: readonly WorkflowArtifact[],
  claims: unknown,
): KnowledgeBitsEvidence {
  if (!Array.isArray(output.acceptedSources)
    || !Array.isArray(output.rejectedSources)
    || !Array.isArray(output.coverageGaps)) {
    throw new ReviewPackageAssemblyError('evidence artifact is unreadable: accepted, rejected, and coverage gap decisions are required');
  }
  const acceptedSources = output.acceptedSources.map((value) => {
    if (!isRecord(value)
      || typeof value.sourceId !== 'string'
      || typeof value.url !== 'string'
      || typeof value.title !== 'string'
      || typeof value.snapshotChecksum !== 'string'
      || !isRecord(value.readability)
      || !isRecord(value.credibility)) {
      throw new ReviewPackageAssemblyError('evidence artifact is unreadable: invalid source');
    }
    const snapshot = artifacts.find((candidate) => (
      candidate.kind === 'source_snapshot'
      && candidate.action === 'collect_sources'
      && candidate.provenance.sourceId === value.sourceId
      && candidate.checksum === value.snapshotChecksum
    ));
    if (!snapshot) {
      throw new ReviewPackageAssemblyError(`evidence artifact is unreadable: accepted source ${value.sourceId} has no immutable snapshot`);
    }
    return {
      sourceId: value.sourceId,
      url: value.url,
      title: value.title,
      retrievedAt: typeof value.retrievedAt === 'string' ? value.retrievedAt : artifact.createdAt.toISOString(),
      snapshot: toArtifactReference(snapshot),
      readability: value.readability,
      credibility: value.credibility,
    };
  });
  return knowledgeBitsEvidenceSchema.parse({
    schemaVersion: 'knowledge-bits.evidence.v1',
    acceptedSources,
    rejectedSources: output.rejectedSources,
    coverageGaps: output.coverageGaps,
    claims,
  });
}

function qaApprovalIssues(qa: ReturnType<typeof knowledgeBitsQaSchema.parse>, contentChecksum: string): string[] {
  return [
    ...(!qa.deterministic.passed ? ['Deterministic QA did not pass'] : []),
    ...(qa.deterministic.contentChecksum !== contentChecksum ? ['Deterministic QA content checksum does not match learner content'] : []),
  ];
}

function editorialWarnings(qa: ReturnType<typeof knowledgeBitsQaSchema.parse>): string[] {
  return qa.editorial.findings
    .filter((finding) => finding.blocking)
    .map((finding) => `Editorial warning: ${finding.code}: ${finding.message}`);
}

function assetChecksumIssues(artifacts: readonly WorkflowArtifact[], contentChecksum: string): string[] {
  return REVIEW_ASSET_KINDS.flatMap((kind) => {
    const artifact = latestArtifact(artifacts, kind);
    return artifact && artifact.inputChecksum !== contentChecksum
      ? [`Required ${kind} input checksum does not match learner content`]
      : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function prefixedChecksum(value: unknown): string | undefined {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function prefixedChecksumList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => prefixedChecksum(item))) return undefined;
  return value as string[];
}

function assemblyErrorMessage(error: unknown): string {
  if (error instanceof ReviewPackageAssemblyError) return error.message;
  return `Review package is unreadable: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'unknown error';
}
