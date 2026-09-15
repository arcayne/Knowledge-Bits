#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fixtureCandidate, loadBaseline, loadCorpus, evaluateCandidate, runLane1, compareReports, canonicalJson, sha256, resolveCandidateProvenance } from '../packages/evaluation/dist/index.js';

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const values = name => args.flatMap((arg, i) => arg === name ? [args[i + 1]] : []).filter(Boolean);
const projectRoot = resolve(value('--project-root') ?? process.cwd());
const candidateCommit = value('--candidate-sha') ?? process.env.GITHUB_SHA;
if (!candidateCommit || !/^[0-9a-f]{40}$/i.test(candidateCommit)) { console.error('Missing or invalid --candidate-sha (expected a 40-hex SHA)'); process.exit(2); }
let headSha;
try { ({ stdout: headSha } = await execFile('git', ['-C', projectRoot, 'rev-parse', 'HEAD'])); } catch (error) { console.error(`Cannot resolve project HEAD: ${error.message}`); process.exit(2); }
headSha = headSha.trim();
if (candidateCommit !== headSha) { console.error(`Candidate SHA ${candidateCommit} does not equal project HEAD ${headSha}`); process.exit(2); }
const corpusPath = value('--corpus') ?? resolve(projectRoot, 'evals/knowledge-bits.v1');
const baselinePath = value('--trusted-baseline') ?? value('--baseline') ?? resolve(projectRoot, 'evals/knowledge-bits.v1/baselines/baseline-20260809-01.json');
const trustedExplicit = Boolean(value('--trusted-baseline'));
const trustedBaselineId = value('--baseline-id') ?? 'baseline-20260809-01';
// This local-fixture pin prevents silent baseline replacement. Protected runners should
// provide --trusted-baseline and --baseline-checksum from outside the project tree.
const trustedBaselineChecksum = value('--baseline-checksum') ?? process.env.KB_TRUSTED_BASELINE_CHECKSUM ?? 'bc773fed4e32a7e272b43ffbcd353ebcebc4b268aed0acfd82966d3d40aa1cd9';
const corpus = await loadCorpus(corpusPath);
let baseline;
try {
  baseline = await loadBaseline(baselinePath, {
    expectedId: trustedBaselineId,
    trustedChecksum: trustedBaselineChecksum,
    projectRoot,
    requireOutsideProjectRoot: trustedExplicit,
  });
} catch (error) { console.error(`Trusted baseline rejected: ${error.message}`); process.exit(2); }
if (candidateCommit === baseline.commit) { console.error('Candidate SHA must differ from trusted baseline commit'); process.exit(2); }
let provenance;
try { provenance = await resolveCandidateProvenance(projectRoot, value('--provenance-manifest') ?? 'evals/knowledge-bits.v1/provenance.json'); }
catch (error) { provenance = { recipeChecksums: {}, promptChecksums: {} }; console.error(`Candidate provenance unavailable: ${error.message}`); }
const fixture = fixtureCandidate(corpus, {
  candidateCommit,
  baselineId: baseline.id,
  corpusChecksum: corpus.manifest.corpusChecksum,
  recipeChecksums: provenance.recipeChecksums,
  promptChecksums: provenance.promptChecksums,
  provider: value('--provider') ?? 'fixture-provider',
  model: value('--model') ?? 'fixture-model-v1',
});
const provider = value('--provider');
const model = value('--model');
const candidateFile = value('--candidate-file');
const candidate = candidateFile
  ? { ...fixture, ...JSON.parse(await readFile(resolve(projectRoot, candidateFile), 'utf8')), candidateCommit, recipeChecksums: provenance.recipeChecksums, promptChecksums: provenance.promptChecksums, ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
  : fixture;
const changedPaths = [...values('--changed-path'), ...values('--changed-paths').flatMap(item => item.split(',').map(path => path.trim()).filter(Boolean)), ...(process.env.CHANGED_PATHS ? process.env.CHANGED_PATHS.split(',').map(path => path.trim()).filter(Boolean) : [])];
const lane = await runLane1({
  changedPaths,
  corpus,
  baseline,
  candidate,
  providerIdentity: provider && model ? { provider, model, evaluationOnly: true } : undefined,
  providerCommand: value('--provider-command'),
  projectRoot,
});
let report = lane.report;
// Construct a checksum-addressed trusted baseline report from fixture evidence. This report is
// used only as comparator input; it never writes or changes the baseline artifact.
const baselineFixture = fixtureCandidate(corpus, {
  candidateCommit: 'a'.repeat(40), baselineId: baseline.id, corpusChecksum: corpus.manifest.corpusChecksum,
  recipeChecksums: baseline.recipeChecksums, promptChecksums: baseline.promptChecksums,
  provider: baseline.provider, model: baseline.model,
});
const trustedBody = evaluateCandidate(corpus, baseline, baselineFixture);
const baselineReportBody = { ...trustedBody, candidateCommit: baseline.commit, finalDecision: 'pass', provenance: { adequate: true, failures: [] } };
const { canonicalReportChecksum: _ignored, ...baselineWithoutChecksum } = baselineReportBody;
const baselineReport = { ...baselineWithoutChecksum, canonicalReportChecksum: sha256(canonicalJson(baselineWithoutChecksum)) };
const comparison = compareReports(baselineReport, report, { trustedBaseline: baseline, corpusChecksum: corpus.manifest.corpusChecksum });
if (comparison.decision !== report.finalDecision) {
  const { canonicalReportChecksum: _drop, ...body } = report;
  report = { ...body, finalDecision: comparison.decision, provenance: { adequate: comparison.decision !== 'inconclusive' && body.provenance.adequate, failures: [...body.provenance.failures, ...comparison.failures] }, canonicalReportChecksum: '' };
  const { canonicalReportChecksum: _drop2, ...reportWithoutChecksum } = report;
  report.canonicalReportChecksum = sha256(canonicalJson(reportWithoutChecksum));
}
const output = value('--output');
if (output) await writeFile(resolve(projectRoot, output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ selection: lane.selection, comparison, report }, null, 2));
process.exit(report.finalDecision === 'pass' ? 0 : report.finalDecision === 'fail' ? 1 : 2);
