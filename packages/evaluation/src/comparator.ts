import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Baseline, EvaluationReport, Decision } from './contracts.js';
import { canonicalJson, sha256 } from './contracts.js';
import { assertReportDeterministic, baselineChecksum, isExactSha } from './runner.js';

export interface ComparisonOptions {
  trustedBaseline?: Baseline;
  corpusChecksum?: string;
}

export function compareReports(baselineReport: EvaluationReport, candidateReport: EvaluationReport, options: ComparisonOptions = {}): { decision: Decision; exactCandidateSha: boolean; failures: string[] } {
  const failures: string[] = [];
  const inconclusiveFailures: string[] = [];
  const baseline = options.trustedBaseline;
  if (!assertReportDeterministic(baselineReport)) inconclusiveFailures.push('baseline report checksum is invalid');
  if (!assertReportDeterministic(candidateReport)) inconclusiveFailures.push('candidate report checksum is invalid');
  if (baseline && baselineChecksum(baseline) !== baseline.checksum) inconclusiveFailures.push('trusted baseline checksum is invalid');
  if (baseline && baselineReport.baselineId !== baseline.id) inconclusiveFailures.push('baseline report identity does not match trusted baseline');
  if (baseline && baselineReport.baselineCommit !== baseline.commit) inconclusiveFailures.push('baseline report commit does not match trusted baseline');
  if (baseline && baselineReport.candidateCommit !== baseline.commit) inconclusiveFailures.push('baseline report candidate SHA does not match trusted baseline');
  if (baseline && baselineReport.baselineChecksum !== baseline.checksum) inconclusiveFailures.push('baseline report checksum binding does not match trusted baseline');
  if (baseline && baselineReport.corpusChecksum !== baseline.corpusChecksum) inconclusiveFailures.push('baseline report corpus does not match trusted baseline');
  if (baseline && candidateReport.baselineChecksum !== baseline.checksum) inconclusiveFailures.push('candidate report baseline checksum does not match trusted baseline');
  if (baseline && candidateReport.thresholds && canonicalJson(candidateReport.thresholds) !== canonicalJson(baseline.thresholds)) inconclusiveFailures.push('candidate report thresholds do not match trusted baseline');
  if (candidateReport.baselineId !== baselineReport.baselineId) inconclusiveFailures.push('reports use different baseline IDs');
  if (candidateReport.baselineCommit !== baselineReport.baselineCommit) inconclusiveFailures.push('reports use different baseline commits');
  if (candidateReport.corpusChecksum !== baselineReport.corpusChecksum || (options.corpusChecksum && candidateReport.corpusChecksum !== options.corpusChecksum)) inconclusiveFailures.push('reports use different corpus checksums');
  if (!isExactSha(candidateReport.candidateCommit)) inconclusiveFailures.push('candidate commit is not an exact SHA');
  if (candidateReport.candidateCommit === baselineReport.baselineCommit) inconclusiveFailures.push('candidate commit is not distinct from baseline commit');
  if (baselineReport.finalDecision !== 'pass') inconclusiveFailures.push(`trusted baseline report is ${baselineReport.finalDecision}`);
  if (candidateReport.finalDecision !== 'pass') failures.push(`candidate evaluation is ${candidateReport.finalDecision}`);
  const exactCandidateSha = isExactSha(candidateReport.candidateCommit) && candidateReport.candidateCommit !== baselineReport.baselineCommit;
  if (inconclusiveFailures.length > 0) return { decision: 'inconclusive', exactCandidateSha, failures: [...inconclusiveFailures, ...failures] };
  return { decision: failures.length > 0 ? (candidateReport.finalDecision === 'inconclusive' ? 'inconclusive' : 'fail') : 'pass', exactCandidateSha, failures };
}

export interface NarrativeBlindComparison {
  caseId: string;
  baselineOutput: string;
  candidateOutput: string;
  sourceReportChecksum: string;
}
export interface PromotionRequest {
  schemaVersion: '1.0.0';
  type: 'model-baseline-promotion-request';
  candidateCommit: string;
  sourceReportChecksum: string;
  human: string;
  decision: 'approve' | 'reject';
  blindedNarrativeComparison: NarrativeBlindComparison[];
  requestChecksum: string;
}

export function createPromotionRequest(report: EvaluationReport, baseline: Baseline, input: { human: string; decision: 'approve' | 'reject'; blindedNarrativeComparison: NarrativeBlindComparison[] }): PromotionRequest {
  if (report.finalDecision !== 'pass') throw new Error('Only a passing report can request baseline promotion');
  if (!assertReportDeterministic(report)) throw new Error('Promotion requires a valid canonical report checksum');
  if (report.baselineId !== baseline.id || report.baselineChecksum !== baseline.checksum) throw new Error('Promotion report does not use the selected trusted baseline');
  if (!isExactSha(report.candidateCommit) || report.candidateCommit === baseline.commit) throw new Error('Promotion requires an exact candidate SHA distinct from baseline');
  if (!input.human.trim()) throw new Error('A named human is required');
  const expected = [...baseline.narrativeCaseIds].sort();
  const actualItems = input.blindedNarrativeComparison;
  const actual = actualItems.map(item => item.caseId).sort();
  if (expected.length !== 3 || actual.length !== 3 || expected.some((id, index) => id !== actual[index])) throw new Error('Promotion requires blinded comparison for precisely the three narrative cases');
  if (new Set(actual).size !== 3) throw new Error('Narrative comparison case IDs must be unique');
  for (const item of actualItems) {
    if (!item.baselineOutput?.trim() || !item.candidateOutput?.trim()) throw new Error(`Narrative comparison output is empty: ${item.caseId}`);
    if (item.sourceReportChecksum !== report.canonicalReportChecksum) throw new Error(`Narrative comparison is not bound to source report: ${item.caseId}`);
  }
  if (input.decision !== 'approve' && input.decision !== 'reject') throw new Error('Human decision is required');
  const base = { schemaVersion: '1.0.0' as const, type: 'model-baseline-promotion-request' as const, candidateCommit: report.candidateCommit, sourceReportChecksum: report.canonicalReportChecksum, human: input.human.trim(), decision: input.decision, blindedNarrativeComparison: input.blindedNarrativeComparison };
  return { ...base, requestChecksum: sha256(canonicalJson(base)) };
}

export async function writePromotionRequest(path: string, request: PromotionRequest): Promise<void> {
  const target = resolve(path);
  try {
    await readFile(target);
    throw new Error(`Promotion artifact already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(target, `${canonicalJson(request)}\n`, { flag: 'wx' });
}
