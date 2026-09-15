import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256 } from './contracts.js';

export const JOAN_EVALUATION_SCHEMA_VERSION = 'joan-ai-video.evaluation-case.v1' as const;
export const JOAN_EVALUATION_REPORT_SCHEMA_VERSION = 'joan-ai-video.evaluation-report.v1' as const;
export const JOAN_CORPUS_SCHEMA_VERSION = '1.0.0' as const;

export type JoanCoverage =
  | 'research-completeness'
  | 'source-boundary'
  | 'claim-grounding'
  | 'unsupported-claims'
  | 'prompt-injection'
  | 'briefing-compression'
  | 'duration'
  | 'media-consistency'
  | 'infographic-grounding'
  | 'infographic-readability'
  | 'social-attribution'
  | 'package-integrity';

export type JoanHardGate =
  | 'research-source-integrity'
  | 'research-source-boundary'
  | 'claim-grounding'
  | 'topic-coverage'
  | 'duration'
  | 'media-binding'
  | 'infographic-structure'
  | 'package-integrity'
  | 'provenance';

export type JoanMediaKind = 'audio' | 'video' | 'infographic' | 'x' | 'linkedin';

export interface JoanSourceSnapshot {
  id: string;
  path: string;
  bodyChecksum: string;
  artifactId?: string;
}

export interface JoanDurationConstraint {
  minSeconds: number;
  maxSeconds: number;
}

export interface JoanMediaConstraint {
  requiredKinds: JoanMediaKind[];
  duration?: JoanDurationConstraint;
  cardCount?: { min: number; max: number };
  dimensions?: { width: number; height: number };
}

export interface JoanEvaluationCase {
  schemaVersion: typeof JOAN_EVALUATION_SCHEMA_VERSION;
  id: string;
  title: string;
  coverage: JoanCoverage[];
  tags: string[];
  source: JoanSourceSnapshot;
  expected: {
    materialClaimIds: string[];
    requiredTopicSignals?: string[];
    media?: JoanMediaConstraint;
    requiredSourceIds?: string[];
  };
  label: {
    hardGates: JoanHardGate[];
    critical?: boolean;
  };
  labelPath?: string;
  labelChecksum?: string;
  checksum: string;
}

export interface JoanCorpusManifest {
  schemaVersion: typeof JOAN_CORPUS_SCHEMA_VERSION;
  id: 'joan-ai-video.v1';
  version: string;
  cases: Array<{ id: string; checksum: string; path?: string }>;
  corpusChecksum: string;
}

export interface JoanCorpus {
  manifest: JoanCorpusManifest;
  cases: JoanEvaluationCase[];
  root?: string;
}

export interface JoanClaimOutput {
  id: string;
  factual?: boolean;
  critical?: boolean;
  supported?: boolean;
  sourceIds?: string[];
  citationIds?: string[];
}

export interface JoanCitationOutput {
  id: string;
  claimId: string;
  sourceId: string;
  sourceBodyChecksum: string;
  artifactId?: string;
}

export interface JoanSourceEvidenceOutput {
  transcript?: {
    usable: boolean;
    artifactId: string;
    bodyChecksum: string;
  };
  acceptedSources: Array<{
    sourceId: string;
    artifactId: string;
    bodyChecksum: string;
    relationship: string;
  }>;
  authorLinks: string[];
  metadataOnly?: boolean;
  sourceInstructionsIgnored: boolean;
}

export interface JoanBriefOutput {
  briefChecksum: string;
  claims: JoanClaimOutput[];
  citations: JoanCitationOutput[];
  topicSignals?: string[];
  cardPlan?: Array<{
    sequence: number;
    title: string;
    claimIds: string[];
    evidenceBoundary: string;
    textEquivalent: string;
  }>;
}

export interface JoanMediaArtifactOutput {
  kind: JoanMediaKind;
  artifactChecksum: string;
  inputBriefChecksum: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  claimIds?: string[];
  title?: string;
  altText?: string;
  textEquivalent?: string;
  transcript?: string;
}

export interface JoanPackageOutput {
  sourceSetChecksum: string;
  canonicalBriefChecksum: string;
  artifacts: Array<{
    kind: JoanMediaKind;
    artifactChecksum: string;
    inputBriefChecksum: string;
  }>;
  socialDraftsChecksum?: string;
  deliveryMetadata?: unknown;
  packageChecksum: string;
}

export interface JoanProvenanceOutput {
  promptChecksums: Record<string, string>;
  recipeChecksums: Record<string, string>;
  provider: string;
  model: string;
}

export interface JoanCandidateCaseOutput {
  sourceEvidence?: JoanSourceEvidenceOutput;
  brief?: JoanBriefOutput;
  check?: { passed: boolean };
  media?: JoanMediaArtifactOutput[];
  package?: JoanPackageOutput;
  provenance?: JoanProvenanceOutput;
}

export interface JoanCandidateInput {
  candidateId: string;
  corpusChecksum: string;
  provider: string;
  model: string;
  cases: Record<string, JoanCandidateCaseOutput>;
}

export interface JoanGateFailure {
  caseId: string;
  reason: string;
}

export interface JoanGateResult {
  name: JoanHardGate;
  passed: boolean;
  failures: JoanGateFailure[];
}

export interface JoanCaseResult {
  caseId: string;
  failures: Array<{ gate: JoanHardGate; reason: string }>;
}

export interface JoanEvaluationReport {
  schemaVersion: typeof JOAN_EVALUATION_REPORT_SCHEMA_VERSION;
  candidateId: string;
  corpusChecksum: string;
  provider: string;
  model: string;
  gates: JoanGateResult[];
  caseResults: JoanCaseResult[];
  finalDecision: 'pass' | 'fail' | 'inconclusive';
  provenance: { adequate: boolean; failures: string[] };
  canonicalReportChecksum: string;
}

const CHECKSUM = /^[0-9a-f]{64}$/i;
const JOAN_HARD_GATES: readonly JoanHardGate[] = [
  'research-source-integrity',
  'research-source-boundary',
  'claim-grounding',
  'topic-coverage',
  'duration',
  'media-binding',
  'infographic-structure',
  'package-integrity',
  'provenance',
];

export function joanCaseChecksum(testCase: Omit<JoanEvaluationCase, 'checksum'>): string {
  return sha256(canonicalJson(testCase));
}

export function joanCorpusChecksum(manifest: Omit<JoanCorpusManifest, 'corpusChecksum'>, cases: JoanEvaluationCase[]): string {
  return sha256(canonicalJson({
    manifest,
    cases: cases.map(testCase => ({ id: testCase.id, checksum: testCase.checksum })),
  }));
}

export function calculateJoanPackageChecksum(input: Omit<JoanPackageOutput, 'packageChecksum'>): string {
  return sha256(canonicalJson(input));
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]/).some(segment => segment === '..');
}

function assertContained(root: string, candidate: string, label: string): void {
  const candidateRelative = relative(root, candidate);
  if (candidateRelative === '' || candidateRelative === '..' || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative)) {
    throw new Error(`${label} escapes corpus root`);
  }
}

async function resolveCorpusFile(root: string, value: unknown, label: string): Promise<string> {
  if (typeof value !== 'string' || !value || isAbsolute(value) || hasTraversalSegment(value)) {
    throw new Error(`${label} must be a relative path without traversal: ${String(value)}`);
  }
  const lexicalPath = resolve(root, value);
  assertContained(root, lexicalPath, label);
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(lexicalPath)]);
  assertContained(realRoot, realFile, `${label} through a symlink`);
  return realFile;
}

function validateChecksum(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !CHECKSUM.test(value)) throw new Error(`${label} must be a SHA-256 checksum`);
}

export async function loadJoanCorpus(rootDirectory: string): Promise<JoanCorpus> {
  const root = await realpath(resolve(rootDirectory));
  const manifestPath = await resolveCorpusFile(root, 'manifest.json', 'Joan corpus manifest path');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as JoanCorpusManifest;
  if (manifest.schemaVersion !== JOAN_CORPUS_SCHEMA_VERSION || manifest.id !== 'joan-ai-video.v1' || !Array.isArray(manifest.cases) || manifest.cases.length < 12) {
    throw new Error('Joan corpus must use schema 1.0.0 and contain at least 12 cases');
  }

  const cases: JoanEvaluationCase[] = [];
  for (const entry of manifest.cases) {
    if (!entry || typeof entry.id !== 'string') throw new Error('Joan case ID must be a string');
    const casePath = await resolveCorpusFile(root, entry.path ?? `cases/${entry.id}.json`, `Joan case path ${entry.id}`);
    const testCase = JSON.parse(await readFile(casePath, 'utf8')) as JoanEvaluationCase;
    if (testCase.schemaVersion !== JOAN_EVALUATION_SCHEMA_VERSION || testCase.id !== entry.id) {
      throw new Error(`Invalid Joan case identity: ${entry.id}`);
    }
    const { checksum: _caseChecksum, ...caseWithoutChecksum } = testCase;
    if (testCase.checksum !== entry.checksum || joanCaseChecksum(caseWithoutChecksum) !== testCase.checksum) {
      throw new Error(`Joan case checksum mismatch: ${entry.id}`);
    }
    validateChecksum(testCase.source.bodyChecksum, `Joan source checksum ${entry.id}`);
    const sourcePath = await resolveCorpusFile(root, testCase.source.path, `Joan source path ${entry.id}`);
    const sourceBody = await readFile(sourcePath, 'utf8');
    if (sha256(sourceBody) !== testCase.source.bodyChecksum) throw new Error(`Joan source checksum mismatch: ${entry.id}`);
    if (testCase.labelPath) {
      const labelPath = await resolveCorpusFile(root, testCase.labelPath, `Joan label path ${entry.id}`);
      const labelBody = await readFile(labelPath, 'utf8');
      if (!testCase.labelChecksum || sha256(labelBody) !== testCase.labelChecksum) throw new Error(`Joan label checksum mismatch: ${entry.id}`);
    }
    cases.push(testCase);
  }

  const manifestBody = { ...manifest } as Omit<JoanCorpusManifest, 'corpusChecksum'>;
  delete (manifestBody as Partial<JoanCorpusManifest>).corpusChecksum;
  if (manifest.corpusChecksum !== joanCorpusChecksum(manifestBody, cases)) throw new Error('Joan corpus checksum mismatch');
  return { manifest, cases, root };
}

function failure(gate: JoanHardGate, reason: string): { gate: JoanHardGate; reason: string } {
  return { gate, reason };
}

function checkResearch(testCase: JoanEvaluationCase, output: JoanCandidateCaseOutput, failures: Array<{ gate: JoanHardGate; reason: string }>): void {
  const evidence = output.sourceEvidence;
  if (!evidence?.transcript?.usable || !evidence.transcript.artifactId || !CHECKSUM.test(evidence.transcript.bodyChecksum)) {
    failures.push(failure('research-source-integrity', 'usable transcript snapshot is missing or invalid'));
  }
  if (!evidence || evidence.metadataOnly === true || evidence.sourceInstructionsIgnored !== true) {
    failures.push(failure('research-source-boundary', 'research evidence is metadata-only or source instructions were not ignored'));
  }
  const accepted = new Map((evidence?.acceptedSources ?? []).map(source => [source.sourceId, source]));
  for (const requiredSourceId of testCase.expected.requiredSourceIds ?? []) {
    const source = accepted.get(requiredSourceId);
    if (!source) {
      failures.push(failure('research-source-integrity', `required accepted source ${requiredSourceId} is missing`));
      continue;
    }
    if (!source.artifactId || !source.relationship || !CHECKSUM.test(source.bodyChecksum)) {
      failures.push(failure('research-source-integrity', `accepted source ${requiredSourceId} has incomplete provenance`));
    }
    if (requiredSourceId === testCase.source.id && source.bodyChecksum !== testCase.source.bodyChecksum) {
      failures.push(failure('research-source-integrity', `accepted source ${requiredSourceId} does not match the immutable source snapshot`));
    }
  }
  if (!Array.isArray(evidence?.authorLinks)) failures.push(failure('research-source-integrity', 'author links result is missing'));
}

function checkBrief(testCase: JoanEvaluationCase, output: JoanCandidateCaseOutput, failures: Array<{ gate: JoanHardGate; reason: string }>): void {
  const brief = output.brief;
  if (!brief || !CHECKSUM.test(brief.briefChecksum)) {
    failures.push(failure('claim-grounding', 'canonical brief checksum is missing or invalid'));
    return;
  }
  if (output.check?.passed !== true) failures.push(failure('claim-grounding', 'check stage did not pass'));
  const claims = new Map(brief.claims.map(claim => [claim.id, claim]));
  const citations = new Map(brief.citations.map(citation => [citation.claimId, citation]));
  const validSourceIds = new Set([testCase.source.id, ...(testCase.expected.requiredSourceIds ?? [])]);
  for (const claimId of testCase.expected.materialClaimIds) {
    const claim = claims.get(claimId);
    if (!claim) {
      failures.push(failure('claim-grounding', `material claim ${claimId} is missing`));
      continue;
    }
    if (claim.factual !== false && claim.supported !== true) failures.push(failure('claim-grounding', `material claim ${claimId} is not supported`));
    if (claim.factual !== false) {
      const citation = citations.get(claimId);
      if (!citation) failures.push(failure('claim-grounding', `material claim ${claimId} has no citation`));
      else if (!validSourceIds.has(citation.sourceId) || citation.sourceBodyChecksum !== testCase.source.bodyChecksum || (citation.artifactId && citation.artifactId !== testCase.source.artifactId && citation.sourceId === testCase.source.id)) {
        failures.push(failure('claim-grounding', `citation for material claim ${claimId} does not bind to an accepted immutable source`));
      }
    }
  }
  for (const claim of brief.claims) {
    if (claim.critical === true && claim.factual !== false && claim.supported !== true) {
      failures.push(failure('claim-grounding', `critical claim ${claim.id} is unsupported`));
    }
  }
  if (testCase.expected.requiredTopicSignals) {
    const actualSignals = new Set(brief.topicSignals ?? []);
    for (const signal of testCase.expected.requiredTopicSignals) {
      if (!actualSignals.has(signal)) failures.push(failure('topic-coverage', `required topic signal ${signal} is missing`));
    }
  }
  if (testCase.expected.media?.cardCount) {
    const cardPlan = brief.cardPlan ?? [];
    const { min, max } = testCase.expected.media.cardCount;
    if (cardPlan.length < min || cardPlan.length > max) failures.push(failure('infographic-structure', `card plan count ${cardPlan.length} is outside ${min}-${max}`));
    const sequences = cardPlan.map(card => card.sequence);
    if (new Set(sequences).size !== sequences.length || sequences.some(sequence => !Number.isInteger(sequence) || sequence < 1)) {
      failures.push(failure('infographic-structure', 'card plan sequence numbers are not unique positive integers'));
    }
    for (const card of cardPlan) {
      if (!card.title.trim() || !card.evidenceBoundary.trim() || !card.textEquivalent.trim() || card.claimIds.length === 0) {
        failures.push(failure('infographic-structure', `card ${card.sequence} is missing title, evidence boundary, text equivalent, or claim references`));
      }
    }
  }
}

function checkMedia(testCase: JoanEvaluationCase, output: JoanCandidateCaseOutput, failures: Array<{ gate: JoanHardGate; reason: string }>): void {
  const constraint = testCase.expected.media;
  if (!constraint) return;
  const briefChecksum = output.brief?.briefChecksum;
  const media = output.media ?? [];
  const singletonKinds = ['audio', 'video', 'x', 'linkedin'];
  for (const kind of singletonKinds) {
    if (media.filter(asset => asset.kind === kind).length > 1) failures.push(failure('media-binding', `duplicate ${kind} assets are present`));
  }
  const byKind = new Map(media.map(asset => [asset.kind, asset]));
  for (const kind of constraint.requiredKinds) {
    const asset = byKind.get(kind);
    if (!asset) {
      failures.push(failure('media-binding', `required ${kind} asset is missing`));
      continue;
    }
    if (!CHECKSUM.test(asset.artifactChecksum)) failures.push(failure('media-binding', `${kind} artifact checksum is invalid`));
    if (!briefChecksum || asset.inputBriefChecksum !== briefChecksum) failures.push(failure('media-binding', `${kind} is not bound to the checked brief checksum`));
    if (kind === 'audio' || kind === 'video') {
      const duration = asset.durationSeconds;
      if (!constraint.duration || typeof duration !== 'number' || !Number.isFinite(duration) || duration < constraint.duration.minSeconds || duration > constraint.duration.maxSeconds) {
        failures.push(failure('duration', `${kind} duration is outside ${constraint.duration?.minSeconds}-${constraint.duration?.maxSeconds} seconds`));
      }
    }
  }
  const cards = media.filter(asset => asset.kind === 'infographic');
  if (constraint.cardCount) {
    if (cards.length < constraint.cardCount.min || cards.length > constraint.cardCount.max) failures.push(failure('infographic-structure', `generated card count ${cards.length} is outside ${constraint.cardCount.min}-${constraint.cardCount.max}`));
    for (const [index, card] of cards.entries()) {
      if (!card.title?.trim() || !card.altText?.trim() || !card.textEquivalent?.trim() || !card.claimIds?.length) {
        failures.push(failure('infographic-structure', `generated card ${index + 1} is missing required metadata`));
      }
      if (constraint.dimensions && (card.width !== constraint.dimensions.width || card.height !== constraint.dimensions.height)) {
        failures.push(failure('infographic-structure', `generated card ${index + 1} dimensions do not match ${constraint.dimensions.width}x${constraint.dimensions.height}`));
      }
    }
  }
  const claimIds = new Set(output.brief?.claims.map(claim => claim.id) ?? []);
  for (const asset of media) {
    for (const claimId of asset.claimIds ?? []) {
      if (!claimIds.has(claimId)) failures.push(failure('media-binding', `${asset.kind} references unknown claim ${claimId}`));
    }
  }
}

function checkPackage(output: JoanCandidateCaseOutput, failures: Array<{ gate: JoanHardGate; reason: string }>): void {
  const packageOutput = output.package;
  if (!packageOutput) {
    failures.push(failure('package-integrity', 'package output is missing'));
    return;
  }
  if (!output.brief || packageOutput.canonicalBriefChecksum !== output.brief.briefChecksum) failures.push(failure('package-integrity', 'package is not bound to the canonical brief checksum'));
  if (!CHECKSUM.test(packageOutput.sourceSetChecksum)) failures.push(failure('package-integrity', 'package source-set checksum is invalid'));
  const { packageChecksum: _packageChecksum, ...packageWithoutChecksum } = packageOutput;
  const expectedChecksum = calculateJoanPackageChecksum(packageWithoutChecksum);
  if (packageOutput.packageChecksum !== expectedChecksum) failures.push(failure('package-integrity', 'package checksum does not match package contents'));
  const mediaByKey = new Map((output.media ?? []).map(asset => [`${asset.kind}:${asset.artifactChecksum}`, asset]));
  if (packageOutput.artifacts.length !== (output.media ?? []).length) failures.push(failure('package-integrity', 'package artifact inventory does not match generated media inventory'));
  for (const artifact of packageOutput.artifacts) {
    const media = mediaByKey.get(`${artifact.kind}:${artifact.artifactChecksum}`);
    if (!media || media.inputBriefChecksum !== artifact.inputBriefChecksum) failures.push(failure('package-integrity', `package artifact ${artifact.kind} is not bound to the generated asset`));
  }
}

function checkProvenance(output: JoanCandidateCaseOutput, failures: Array<{ gate: JoanHardGate; reason: string }>, expectedProvider?: string, expectedModel?: string): void {
  const provenance = output.provenance;
  if (!provenance?.provider.trim() || !provenance.model.trim()) failures.push(failure('provenance', 'provider and model identity are required'));
  if (expectedProvider && provenance?.provider !== expectedProvider) failures.push(failure('provenance', 'case provider identity does not match candidate provider identity'));
  if (expectedModel && provenance?.model !== expectedModel) failures.push(failure('provenance', 'case model identity does not match candidate model identity'));
  if (!provenance || Object.keys(provenance.promptChecksums).length === 0 || !Object.values(provenance.promptChecksums).every(checksum => CHECKSUM.test(checksum))) {
    failures.push(failure('provenance', 'prompt checksums are missing or invalid'));
  }
  if (!provenance || Object.keys(provenance.recipeChecksums).length === 0 || !Object.values(provenance.recipeChecksums).every(checksum => CHECKSUM.test(checksum))) {
    failures.push(failure('provenance', 'recipe checksums are missing or invalid'));
  }
  if ((output.media?.length ?? 0) > 0 && (!provenance || !CHECKSUM.test(provenance.promptChecksums.media ?? '') || !CHECKSUM.test(provenance.recipeChecksums.media ?? ''))) {
    failures.push(failure('provenance', 'media prompt and recipe checksums are required for media output'));
  }
}

export function evaluateJoanCase(testCase: JoanEvaluationCase, output: JoanCandidateCaseOutput | undefined, identity?: { provider: string; model: string }): JoanCaseResult {
  const failures: Array<{ gate: JoanHardGate; reason: string }> = [];
  const candidate = output ?? {};
  checkResearch(testCase, candidate, failures);
  checkBrief(testCase, candidate, failures);
  checkMedia(testCase, candidate, failures);
  checkPackage(candidate, failures);
  checkProvenance(candidate, failures, identity?.provider, identity?.model);
  return { caseId: testCase.id, failures };
}

export function evaluateJoanCandidate(corpus: JoanCorpus, candidate: JoanCandidateInput): JoanEvaluationReport {
  const provenanceFailures: string[] = [];
  if (candidate.corpusChecksum !== corpus.manifest.corpusChecksum) provenanceFailures.push('corpus checksum does not match Joan corpus');
  if (!candidate.candidateId.trim()) provenanceFailures.push('candidate ID is required');
  if (!candidate.provider.trim() || !candidate.model.trim()) provenanceFailures.push('provider and model identity are required');

  const caseResults = corpus.cases.map(testCase => evaluateJoanCase(testCase, candidate.cases[testCase.id], candidate));
  const gateFailures = new Map<JoanHardGate, JoanGateFailure[]>(JOAN_HARD_GATES.map(gate => [gate, []]));
  for (const result of caseResults) {
    for (const item of result.failures) gateFailures.get(item.gate)!.push({ caseId: result.caseId, reason: item.reason });
  }
  const gates = JOAN_HARD_GATES.map(name => ({ name, passed: gateFailures.get(name)!.length === 0, failures: gateFailures.get(name)! }));
  const finalDecision: JoanEvaluationReport['finalDecision'] = provenanceFailures.length > 0 ? 'inconclusive' : caseResults.some(result => result.failures.length > 0) ? 'fail' : 'pass';
  const reportBase = {
    schemaVersion: JOAN_EVALUATION_REPORT_SCHEMA_VERSION,
    candidateId: candidate.candidateId,
    corpusChecksum: candidate.corpusChecksum,
    provider: candidate.provider,
    model: candidate.model,
    gates,
    caseResults,
    finalDecision,
    provenance: { adequate: provenanceFailures.length === 0, failures: provenanceFailures },
  } satisfies Omit<JoanEvaluationReport, 'canonicalReportChecksum'>;
  return { ...reportBase, canonicalReportChecksum: sha256(canonicalJson(reportBase)) };
}

export function assertJoanReportDeterministic(report: JoanEvaluationReport): boolean {
  const { canonicalReportChecksum: _ignored, ...base } = report;
  return sha256(canonicalJson(base)) === report.canonicalReportChecksum;
}
