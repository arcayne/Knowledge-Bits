#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createPromotionRequest, loadBaseline, writePromotionRequest } from '../packages/evaluation/dist/index.js';

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const reportPath = value('--report');
const baselinePath = value('--baseline') ?? 'evals/knowledge-bits.v1/baselines/baseline-20260809-01.json';
const DEFAULT_BASELINE_ID = 'baseline-20260809-01';
const DEFAULT_BASELINE_CHECKSUM = 'bc773fed4e32a7e272b43ffbcd353ebcebc4b268aed0acfd82966d3d40aa1cd9';
const suppliedBaselineId = value('--baseline-id');
const suppliedBaselineChecksum = value('--baseline-checksum');
if ((suppliedBaselineId === undefined) !== (suppliedBaselineChecksum === undefined)) {
  console.error('Trusted baseline ID and checksum must be supplied together');
  process.exit(2);
}
const baselineId = suppliedBaselineId ?? DEFAULT_BASELINE_ID;
const baselineChecksum = suppliedBaselineChecksum ?? DEFAULT_BASELINE_CHECKSUM;
const human = value('--human');
const decision = value('--decision');
const output = value('--output');
const blindPath = value('--blind-comparison');
if (!reportPath || !human || !decision || !output || !blindPath) {
  console.error('Usage: --report REPORT --baseline BASELINE --human NAME --decision approve|reject --blind-comparison JSON --output PATH');
  process.exit(2);
}
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const baseline = await loadBaseline(baselinePath, {
  expectedId: baselineId,
  trustedChecksum: baselineChecksum,
});
const blindedNarrativeComparison = JSON.parse(await readFile(blindPath, 'utf8')).map(item => ({
  ...item,
  sourceReportChecksum: item.sourceReportChecksum ?? report.canonicalReportChecksum,
}));
const request = createPromotionRequest(report, baseline, { human, decision, blindedNarrativeComparison });
await writePromotionRequest(output, request);
console.log(JSON.stringify(request, null, 2));
