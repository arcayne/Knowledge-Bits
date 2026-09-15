import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateInput, Corpus, EvaluationReport, Baseline, CaseResult } from './contracts.js';
import { evaluateCandidate, resolveCandidateProvenance, type ResolvedCandidateProvenance } from './runner.js';
import { canonicalJson, sha256 } from './contracts.js';

const PROVIDER_CHANGE = /(^|\/)(research|create|check|source|sources|prompt|prompts|recipe|recipes|provider|providers|model|models)(\/|\.|$)/i;
export interface LaneSelection { deterministic: true; providerBacked: boolean; reason: string }
export function selectEvaluationLane(changedPaths: string[]): LaneSelection {
  const providerBacked = changedPaths.some(path => PROVIDER_CHANGE.test(path));
  return { deterministic: true, providerBacked, reason: providerBacked ? 'research/Create/Check/source/prompt/recipe/provider/model change detected' : 'no provider-backed change detected' };
}

export interface ProviderIdentity { provider: string; model: string; evaluationOnly: true; environment?: string }
export interface Lane1Options {
  changedPaths: string[];
  corpus: Corpus;
  baseline: Baseline;
  candidate: CandidateInput;
  providerIdentity?: ProviderIdentity;
  providerCommand?: string;
  projectRoot?: string;
  provenanceManifest?: string;
  executeCase?: (caseId: string, payload?: unknown) => Promise<unknown>;
}

export interface ProviderCasePayload {
  schemaVersion: 'knowledge-bits.evaluation-case.v1';
  caseId: string;
  title: string;
  coverage: string[];
  source: { id: string; body: string; bodyChecksum: string };
  candidateSources?: {
    recipes: Record<string, Array<{ path: string; content: string; checksum: string }>>;
    prompts: Record<string, Array<{ path: string; content: string; checksum: string }>>;
  };
  provider: string;
  model: string;
}

export async function executeProviderCommand(command: string, payload: ProviderCasePayload, timeoutMs = 120_000): Promise<CaseResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KB_EVALUATION_ONLY: '1' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`provider command timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`provider command exited ${code}: ${stderr.slice(0, 1000)}`));
      try {
        const parsed = JSON.parse(stdout) as CaseResult;
        if (!parsed || typeof parsed !== 'object') throw new Error('provider result must be an object');
        resolve(parsed);
      } catch (error) { reject(new Error(`provider command returned invalid JSON: ${(error as Error).message}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function providerResult(options: Lane1Options, caseId: string, candidateProvenance?: ResolvedCandidateProvenance): Promise<CaseResult> {
  const testCase = options.corpus.cases.find(item => item.id === caseId)!;
  const sourceBody = options.corpus.root ? await readFile(join(options.corpus.root, testCase.source.path), 'utf8') : '';
  const payload: ProviderCasePayload = {
    schemaVersion: 'knowledge-bits.evaluation-case.v1', caseId, title: testCase.title,
    coverage: testCase.coverage, source: { id: testCase.source.id, body: sourceBody, bodyChecksum: testCase.source.bodyChecksum },
    ...(candidateProvenance ? { candidateSources: { recipes: candidateProvenance.recipeSources, prompts: candidateProvenance.promptSources } } : {}),
    provider: options.providerIdentity!.provider, model: options.providerIdentity!.model,
  };
  if (options.providerCommand) return executeProviderCommand(options.providerCommand, payload);
  if (options.executeCase) return await options.executeCase(caseId, payload) as CaseResult;
  throw new Error('provider command is required for provider-backed evaluation');
}

function inconclusiveReport(report: EvaluationReport, reason: string): EvaluationReport {
  const { canonicalReportChecksum: _ignored, ...body } = report;
  const next = { ...body, finalDecision: 'inconclusive' as const, provenance: { adequate: false, failures: [...body.provenance.failures, reason] } };
  return { ...next, canonicalReportChecksum: sha256(canonicalJson(next)) };
}

export async function runLane1(options: Lane1Options): Promise<{ selection: LaneSelection; providerBacked: boolean; report: EvaluationReport }> {
  const selection = selectEvaluationLane(options.changedPaths);
  if (!selection.providerBacked) return { selection, providerBacked: false, report: evaluateCandidate(options.corpus, options.baseline, options.candidate) };
  if (!options.providerIdentity?.provider || !options.providerIdentity.model || options.providerIdentity.evaluationOnly !== true) {
    const report = evaluateCandidate(options.corpus, options.baseline, { ...options.candidate, provider: '', model: '' });
    return { selection, providerBacked: true, report };
  }
  const candidateBase: CandidateInput = { ...options.candidate, provider: options.providerIdentity.provider, model: options.providerIdentity.model, cases: {} };
  let candidateProvenance: ResolvedCandidateProvenance | undefined;
  if (options.projectRoot) {
    try {
      candidateProvenance = await resolveCandidateProvenance(options.projectRoot, options.provenanceManifest);
    } catch (error) {
      return { selection, providerBacked: true, report: inconclusiveReport(evaluateCandidate(options.corpus, options.baseline, candidateBase), `candidate provenance validation failed: ${(error as Error).message}`) };
    }
  }
  if (!options.providerCommand && !options.executeCase) {
    const report = evaluateCandidate(options.corpus, options.baseline, candidateBase);
    return { selection, providerBacked: true, report: inconclusiveReport(report, 'provider command is required for provider-backed evaluation') };
  }
  const candidate: CandidateInput = { ...candidateBase, cases: { ...options.candidate.cases } };
  try {
    for (const testCase of options.corpus.cases) candidate.cases[testCase.id] = await providerResult(options, testCase.id, candidateProvenance);
  } catch (error) {
    const report = evaluateCandidate(options.corpus, options.baseline, { ...candidate, cases: {} });
    return { selection, providerBacked: true, report: inconclusiveReport(report, `provider execution failed: ${(error as Error).message}`) };
  }
  return { selection, providerBacked: true, report: evaluateCandidate(options.corpus, options.baseline, candidate) };
}
