import type { EvaluationReport } from './contracts.js';
import { canonicalJson, sha256 } from './contracts.js';

export function canonicalReportChecksum(report: Omit<EvaluationReport, 'canonicalReportChecksum'>): string {
  return sha256(canonicalJson(report));
}
export function isCanonicalReport(report: EvaluationReport): boolean {
  const { canonicalReportChecksum: checksum, ...body } = report;
  return canonicalReportChecksum(body) === checksum;
}
