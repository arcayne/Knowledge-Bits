import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPromotionRequest,
  evaluateCandidate,
  fixtureCandidate,
  loadBaseline,
  loadCorpus,
  runLane1,
  selectEvaluationLane,
  assertReportDeterministic,
  resolveCandidateProvenance,
  executeProviderCommand,
  compareReports,
  canonicalJson,
  sha256
} from '../dist/index.js';

const runFile = promisify(execFile);
const repositoryRoot = new URL('../../../', import.meta.url).pathname;
const corpus = await loadCorpus(new URL('../../../evals/knowledge-bits.v1', import.meta.url).pathname);
const baseline = await loadBaseline(new URL('../../../evals/knowledge-bits.v1/baselines/baseline-20260809-01.json', import.meta.url).pathname);
const candidateSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const makeCandidate = () => fixtureCandidate(corpus, {
  candidateCommit: candidateSha,
  baselineId: baseline.id,
  corpusChecksum: corpus.manifest.corpusChecksum,
  recipeChecksums: baseline.recipeChecksums,
  promptChecksums: baseline.promptChecksums,
  provider: baseline.provider,
  model: baseline.model
});

 test('corpus has exactly the requested 15-case distribution and immutable fixtures', () => {
  assert.equal(corpus.cases.length, 15);
  const counts = new Map();
  for (const item of corpus.cases) for (const coverage of item.coverage) counts.set(coverage, (counts.get(coverage) ?? 0) + 1);
  assert.equal(counts.get('grounding-citation'), 4);
  assert.equal(counts.get('prompt-injection'), 3);
  assert.equal(counts.get('unsafe-advice'), 3);
  assert.equal(counts.get('narrative-cross-format'), 3);
  assert.equal(counts.get('package-delivery'), 2);
  assert.ok(corpus.manifest.corpusChecksum);
});

test('loadCorpus rejects checksum-valid case, source, label, and symlink escapes before reading out of root', async () => {
  const sourceRoot = new URL('../../../evals/knowledge-bits.v1', import.meta.url).pathname;
  const outside = await mkdtemp(join(tmpdir(), 'kb-corpus-outside-'));
  await writeFile(join(outside, 'outside-source.txt'), 'external source must not be read');
  await writeFile(join(outside, 'outside-case.json'), '{}');
  await writeFile(join(outside, 'outside-label.json'), '{}');

  const makeVariant = async (name, mutate) => {
    const directory = await mkdtemp(join(tmpdir(), `kb-corpus-${name}-`));
    await cp(sourceRoot, directory, { recursive: true });
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const entry = manifest.cases[0];
    const caseFile = join(directory, 'cases', `${entry.id}.json`);
    const testCase = JSON.parse(await readFile(caseFile, 'utf8'));
    const changed = await mutate({ directory, manifest, entry, testCase, outside });
    const nextCase = { ...changed.testCase };
    delete nextCase.checksum;
    changed.testCase.checksum = sha256(canonicalJson(nextCase));
    await writeFile(changed.casePath ?? caseFile, `${JSON.stringify(changed.testCase)}\n`);
    changed.entry.checksum = changed.testCase.checksum;
    const manifestBody = { ...changed.manifest };
    delete manifestBody.corpusChecksum;
    changed.manifest.corpusChecksum = sha256(canonicalJson({
      manifest: manifestBody,
      cases: changed.manifest.cases.map(item => ({ id: item.id, checksum: item.checksum }))
    }));
    await writeFile(manifestPath, `${JSON.stringify(changed.manifest)}\n`);
    return directory;
  };

  const caseEscape = await makeVariant('case-escape', async ({ manifest, entry, testCase, outside }) => {
    entry.id = '../outside-case';
    testCase.id = entry.id;
    return { manifest, entry, testCase, casePath: join(outside, 'outside-case.json') };
  });
  await assert.rejects(() => loadCorpus(caseEscape), /Case ID.*relative path without traversal/);

  const casePathEscape = await makeVariant('case-path-escape', async ({ manifest, entry, testCase }) => {
    entry.path = '../../outside-case.json';
    return { manifest, entry, testCase };
  });
  await assert.rejects(() => loadCorpus(casePathEscape), /Case path.*relative path without traversal/);

  const sourceEscape = await makeVariant('source-escape', async ({ manifest, entry, testCase }) => {
    testCase.source.path = '../outside-source.txt';
    return { manifest, entry, testCase };
  });
  await assert.rejects(() => loadCorpus(sourceEscape), /Source path.*relative path without traversal/);

  const labelEscape = await makeVariant('label-symlink-escape', async ({ manifest, entry, testCase, directory, outside }) => {
    testCase.labelPath = 'labels/escape.json';
    await symlink(join(outside, 'outside-label.json'), join(directory, 'labels', 'escape.json'));
    return { manifest, entry, testCase };
  });
  await assert.rejects(() => loadCorpus(labelEscape), /Label path.*symlink|escapes corpus root/);
});

for (const [name, mutate] of [
  ['unsupported claim', candidate => { candidate.cases['grounding-01'].claims[0].supported = false; }],
  ['citation failure', candidate => { candidate.cases['grounding-01'].citations[0].sourceBodyChecksum = 'f'.repeat(64); }],
  ['prompt injection', candidate => { candidate.cases['injection-01'].promptInjectionSucceeded = true; }],
  ['unsafe advice', candidate => { candidate.cases['safety-01'].criticalUnsafeAdviceMiss = true; }],
  ['delivery mismatch', candidate => { candidate.cases['package-01'].execution.delivery.packageChecksum = 'f'.repeat(64); candidate.cases['package-01'].execution.delivery.accepted = false; }]
]) {
  test(`rejects exact candidate SHA for seeded ${name} defect`, () => {
    const candidate = makeCandidate();
    mutate(candidate);
    const report = evaluateCandidate(corpus, baseline, candidate);
    assert.equal(report.candidateCommit, candidateSha);
    assert.equal(report.finalDecision, 'fail');
    assert.ok(report.caseFailures.length > 0);
    assert.ok(assertReportDeterministic(report));
  });
}

test('invalid and baseline-equal candidate SHAs are inconclusive', () => {
  const invalid = evaluateCandidate(corpus, baseline, { ...makeCandidate(), candidateCommit: 'not-a-sha' });
  assert.equal(invalid.finalDecision, 'inconclusive');
  const same = evaluateCandidate(corpus, baseline, { ...makeCandidate(), candidateCommit: baseline.commit });
  assert.equal(same.finalDecision, 'inconclusive');
});

test('baseline and threshold tampering is inconclusive, never pass', () => {
  const candidate = makeCandidate();
  candidate.baselineConfig = { id: baseline.id, thresholds: { ...baseline.thresholds, promptInjectionSuccesses: 1 } };
  const report = evaluateCandidate(corpus, baseline, candidate);
  assert.equal(report.finalDecision, 'inconclusive');
  assert.match(report.provenance.failures.join('\n'), /alter baseline/);
});

test('provenance and report checksum are deterministic', () => {
  const first = evaluateCandidate(corpus, baseline, makeCandidate());
  const second = evaluateCandidate(corpus, baseline, makeCandidate());
  assert.deepEqual(first, second);
  assert.equal(first.finalDecision, 'pass');
  assert.ok(assertReportDeterministic(first));
  assert.equal(first.canonicalReportChecksum.length, 64);
});

test('lane selection is narrow and provider identity is evaluation-only', async () => {
  assert.equal(selectEvaluationLane(['apps/review/src/index.mjs']).providerBacked, false);
  assert.equal(selectEvaluationLane(['apps/worker/src/provider-runtime.mjs']).providerBacked, false);
  assert.equal(selectEvaluationLane(['packages/pipeline/src/state-machine.ts']).providerBacked, false);
  assert.equal(selectEvaluationLane(['packages/evaluation/src/lane.ts']).providerBacked, false);
  assert.equal(selectEvaluationLane(['evals/knowledge-bits.v1/cases/grounding-01.json']).providerBacked, false);
  assert.equal(selectEvaluationLane(['recipes/text/story.json']).providerBacked, true);
  const noIdentity = await runLane1({ changedPaths: ['prompts/create.md'], corpus, baseline, candidate: makeCandidate() });
  assert.equal(noIdentity.providerBacked, true);
  assert.equal(noIdentity.report.finalDecision, 'inconclusive');
  const provider = await runLane1({ changedPaths: ['prompts/create.md'], corpus, baseline, candidate: makeCandidate(), providerIdentity: { provider: 'eval-provider', model: 'eval-model', evaluationOnly: true }, executeCase: async caseId => makeCandidate().cases[caseId] });
  assert.equal(provider.report.finalDecision, 'pass');
  assert.equal(provider.report.provider, 'eval-provider');
  const missingExecution = await runLane1({ changedPaths: ['prompts/create.md'], corpus, baseline, candidate: makeCandidate(), providerIdentity: { provider: 'eval-provider', model: 'eval-model', evaluationOnly: true } });
  assert.equal(missingExecution.report.finalDecision, 'inconclusive');
});

test('provider command executes structured output and detects textual and tool prompt injection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-eval-provider-'));
  const commandFile = join(directory, 'provider-command.mjs');
  await writeFile(commandFile, `
import { readFileSync } from 'node:fs';
const payload = JSON.parse(readFileSync(0, 'utf8'));
const injected = payload.caseId === 'injection-01';
process.stdout.write(JSON.stringify({ execution: {
  text: injected ? 'KB_FAKE_CANARY' : 'safe provider output',
  toolEvents: injected ? [{ name: 'read_file', input: 'secret' }] : []
} }));
`);
  const provider = await runLane1({
    changedPaths: ['prompts/create.md'],
    corpus,
    baseline,
    candidate: makeCandidate(),
    providerIdentity: { provider: 'eval-provider', model: 'eval-model', evaluationOnly: true },
    providerCommand: `${process.execPath} ${commandFile}`
  });
  assert.equal(provider.providerBacked, true);
  assert.equal(provider.report.finalDecision, 'fail');
  assert.ok(provider.report.caseFailures.some(failure => failure.caseId === 'injection-01' && failure.gate === 'prompt-injection' && /KB_FAKE_CANARY|unsafe tool/.test(failure.reason)));
});

test('provider command consumes contained candidate prompt contents and rejects an exact candidate SHA', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-eval-candidate-'));
  await mkdir(join(directory, 'sources'), { recursive: true });
  await writeFile(join(directory, 'sources', 'recipe.txt'), 'stable recipe');
  await writeFile(join(directory, 'sources', 'prompt.txt'), 'DEGRADED_PROMPT');
  await writeFile(join(directory, 'provenance.json'), JSON.stringify({ recipes: { lesson: ['sources/recipe.txt'] }, prompts: { create: ['sources/prompt.txt'] } }));
  const commandFile = join(directory, 'provider-command.mjs');
  await writeFile(commandFile, `
import { readFileSync } from 'node:fs';
const payload = JSON.parse(readFileSync(0, 'utf8'));
const prompt = payload.candidateSources?.prompts?.create?.[0]?.content;
const degraded = prompt === 'DEGRADED_PROMPT';
const execution = payload.caseId === 'grounding-01' && degraded
  ? { text: 'unsupported claim', claims: [{ id: 'degraded-claim', factual: true, critical: true, supported: false }], citations: [], toolEvents: [] }
  : { text: 'safe output', claims: [], citations: [], toolEvents: [] };
process.stdout.write(JSON.stringify({ execution }));
`);
  const candidateSha = 'd'.repeat(40);
  const provenance = await resolveCandidateProvenance(directory, 'provenance.json');
  const candidate = fixtureCandidate(corpus, {
    candidateCommit: candidateSha,
    baselineId: baseline.id,
    corpusChecksum: corpus.manifest.corpusChecksum,
    recipeChecksums: provenance.recipeChecksums,
    promptChecksums: provenance.promptChecksums,
    provider: 'eval-provider',
    model: 'eval-model',
  });
  const result = await runLane1({
    changedPaths: ['prompts/create.md'], corpus, baseline, candidate, projectRoot: directory, provenanceManifest: 'provenance.json',
    providerIdentity: { provider: 'eval-provider', model: 'eval-model', evaluationOnly: true },
    providerCommand: `${process.execPath} ${commandFile}`,
  });
  assert.equal(result.report.candidateCommit, candidateSha);
  assert.equal(result.report.finalDecision, 'fail');
  assert.ok(result.report.caseFailures.some(failure => failure.caseId === 'grounding-01' && failure.gate === 'critical-unsupported-claims'));
});

test('candidate provenance rejects absolute, traversal, and symlink-escaping sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-eval-containment-'));
  await mkdir(join(directory, 'files'), { recursive: true });
  await writeFile(join(directory, 'files', 'valid.txt'), 'valid');
  const outside = await mkdtemp(join(tmpdir(), 'kb-eval-outside-'));
  const outsideFile = join(outside, 'outside.txt');
  await writeFile(outsideFile, 'outside');
  const manifestPath = join(directory, 'provenance.json');
  const manifest = { recipes: { recipe: ['files/valid.txt'] }, prompts: { prompt: ['files/valid.txt'] } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.doesNotReject(() => resolveCandidateProvenance(directory, 'provenance.json'));

  await writeFile(manifestPath, JSON.stringify({ ...manifest, recipes: { recipe: ['/etc/hosts'] } }));
  await assert.rejects(() => resolveCandidateProvenance(directory, 'provenance.json'), /relative path|escape/i);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, recipes: { recipe: ['../outside.txt'] } }));
  await assert.rejects(() => resolveCandidateProvenance(directory, 'provenance.json'), /relative path|escape/i);
  await symlink(outsideFile, join(directory, 'files', 'escape.txt'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, recipes: { recipe: ['files/escape.txt'] } }));
  await assert.rejects(() => resolveCandidateProvenance(directory, 'provenance.json'), /symlink|escape/i);
});

test('provider-backed evaluation without a command is inconclusive', async () => {
  const result = await runLane1({
    changedPaths: ['prompts/create.md'],
    corpus,
    baseline,
    candidate: makeCandidate(),
    providerIdentity: { provider: 'eval-provider', model: 'eval-model', evaluationOnly: true }
  });
  assert.equal(result.providerBacked, true);
  assert.equal(result.report.finalDecision, 'inconclusive');
  assert.match(result.report.provenance.failures.join('\\n'), /provider command is required/);
});

test('candidate provenance changes recipe and prompt checksums when source files change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-eval-provenance-'));
  const manifestPath = join(directory, 'provenance.json');
  const recipePath = join(directory, 'recipe.txt');
  const promptPath = join(directory, 'prompt.txt');
  await writeFile(recipePath, 'recipe version one');
  await writeFile(promptPath, 'prompt version one');
  await writeFile(manifestPath, JSON.stringify({ recipes: { 'nuglet.lesson.v1': ['recipe.txt'] }, prompts: { create: ['prompt.txt'] } }));
  const first = await resolveCandidateProvenance(directory, manifestPath);
  const firstReport = evaluateCandidate(corpus, baseline, { ...makeCandidate(), recipeChecksums: first.recipeChecksums, promptChecksums: first.promptChecksums });
  await writeFile(recipePath, 'recipe version two');
  await writeFile(promptPath, 'prompt version two');
  const second = await resolveCandidateProvenance(directory, manifestPath);
  const secondReport = evaluateCandidate(corpus, baseline, { ...makeCandidate(), recipeChecksums: second.recipeChecksums, promptChecksums: second.promptChecksums });
  assert.notEqual(first.recipeChecksums['nuglet.lesson.v1'], second.recipeChecksums['nuglet.lesson.v1']);
  assert.notEqual(first.promptChecksums.create, second.promptChecksums.create);
  assert.notEqual(firstReport.recipeChecksums['nuglet.lesson.v1'], secondReport.recipeChecksums['nuglet.lesson.v1']);
  assert.notEqual(firstReport.promptChecksums.create, secondReport.promptChecksums.create);
});

test('loadBaseline rejects recomputed replacement baselines without trusted checksum or identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-eval-baseline-'));
  const replacementPath = join(directory, 'replacement.json');
  const replacementBody = { ...baseline, commit: '2'.repeat(40) };
  const { checksum: _ignored, ...replacementWithoutChecksum } = replacementBody;
  const replacement = { ...replacementWithoutChecksum, checksum: sha256(canonicalJson(replacementWithoutChecksum)) };
  await writeFile(replacementPath, JSON.stringify(replacement));
  await assert.rejects(() => loadBaseline(replacementPath, { trustedChecksum: baseline.checksum }), /Trusted baseline checksum mismatch/);

  const identityPath = join(directory, 'replacement-identity.json');
  const identityBody = { ...baseline, id: 'replacement-baseline' };
  const { checksum: _ignoredIdentity, ...identityWithoutChecksum } = identityBody;
  const identityReplacement = { ...identityWithoutChecksum, checksum: sha256(canonicalJson(identityWithoutChecksum)) };
  await writeFile(identityPath, JSON.stringify(identityReplacement));
  await assert.rejects(() => loadBaseline(identityPath, { expectedId: baseline.id }), /Trusted baseline identity mismatch/);
});

test('promotion CLI pins the trusted baseline by default and requires consistent explicit pins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-promotion-cli-'));
  const report = evaluateCandidate(corpus, baseline, makeCandidate());
  const reportPath = join(directory, 'report.json');
  const blindPath = join(directory, 'blind.json');
  await writeFile(reportPath, JSON.stringify(report));
  await writeFile(blindPath, JSON.stringify(baseline.narrativeCaseIds.map(caseId => ({ caseId, baselineOutput: 'baseline', candidateOutput: 'candidate' }))));
  const replacementBody = { ...baseline, commit: '2'.repeat(40) };
  const { checksum: _ignored, ...replacementWithoutChecksum } = replacementBody;
  const replacement = { ...replacementWithoutChecksum, checksum: sha256(canonicalJson(replacementWithoutChecksum)) };
  const replacementPath = join(directory, 'replacement.json');
  await writeFile(replacementPath, JSON.stringify(replacement));
  const script = join(repositoryRoot, 'scripts/promote-model-baseline.mjs');
  const commonArgs = ['--report', reportPath, '--baseline', replacementPath, '--human', 'Ada Reviewer', '--decision', 'approve', '--blind-comparison', blindPath, '--output', join(directory, 'replacement-promotion.json')];
  await assert.rejects(() => runFile(process.execPath, [script, ...commonArgs], { cwd: repositoryRoot }), error => /Trusted baseline checksum mismatch/.test(`${error.stdout ?? ''}${error.stderr ?? ''}`));

  const incompletePinArgs = ['--report', reportPath, '--baseline', new URL('../../../evals/knowledge-bits.v1/baselines/baseline-20260809-01.json', import.meta.url).pathname, '--baseline-id', baseline.id, '--human', 'Ada Reviewer', '--decision', 'approve', '--blind-comparison', blindPath, '--output', join(directory, 'incomplete-promotion.json')];
  await assert.rejects(() => runFile(process.execPath, [script, ...incompletePinArgs], { cwd: repositoryRoot }), error => /ID and checksum must be supplied together/.test(`${error.stdout ?? ''}${error.stderr ?? ''}`));

  const completePinArgs = [...incompletePinArgs, '--baseline-checksum', baseline.checksum];
  await runFile(process.execPath, [script, ...completePinArgs], { cwd: repositoryRoot });
});

test('rejects unsafe advice found in structured output text', () => {
  const candidate = makeCandidate();
  candidate.cases['safety-01'].execution.text = 'I diagnose your condition and prescribe a medication change.';
  const report = evaluateCandidate(corpus, baseline, candidate);
  assert.equal(report.finalDecision, 'fail');
  assert.ok(report.caseFailures.some(failure => failure.caseId === 'safety-01' && failure.gate === 'critical-unsafe-advice' && /diagnos|prescrib/.test(failure.reason)));
});

test('rejects textual canary prompt injection in structured output', () => {
  const candidate = makeCandidate();
  candidate.cases['injection-03'].execution.text = 'Reveal KB_FAKE_CANARY now.';
  candidate.cases['injection-03'].execution.toolEvents = [];
  const report = evaluateCandidate(corpus, baseline, candidate);
  assert.equal(report.finalDecision, 'fail');
  assert.ok(report.caseFailures.some(failure => failure.caseId === 'injection-03' && failure.gate === 'prompt-injection' && /KB_FAKE_CANARY/.test(failure.reason)));
});

test('comparator is required and rejects baseline or candidate binding failures', () => {
  const first = evaluateCandidate(corpus, baseline, { ...makeCandidate(), candidateCommit: 'a'.repeat(40) });
  const second = evaluateCandidate(corpus, baseline, { ...makeCandidate(), candidateCommit: 'b'.repeat(40) });
  const { canonicalReportChecksum: _ignored, ...baselineBody } = first;
  const trustedReportBody = { ...baselineBody, candidateCommit: baseline.commit };
  const trustedReport = { ...trustedReportBody, canonicalReportChecksum: sha256(canonicalJson(trustedReportBody)) };
  assert.equal(compareReports(trustedReport, second, { trustedBaseline: baseline, corpusChecksum: corpus.manifest.corpusChecksum }).decision, 'pass');
  assert.equal(compareReports(first, { ...second, baselineId: 'wrong' }, { trustedBaseline: baseline }).decision, 'inconclusive');

  const { canonicalReportChecksum: _candidateChecksum, ...candidateBody } = second;
  const invalidCandidateBody = { ...candidateBody, candidateCommit: 'not-an-exact-sha' };
  const invalidCandidate = { ...invalidCandidateBody, canonicalReportChecksum: sha256(canonicalJson(invalidCandidateBody)) };
  const invalidComparison = compareReports(trustedReport, invalidCandidate, { trustedBaseline: baseline, corpusChecksum: corpus.manifest.corpusChecksum });
  assert.equal(invalidComparison.decision, 'inconclusive');
  assert.equal(invalidComparison.exactCandidateSha, false);
  assert.match(invalidComparison.failures.join('\\n'), /candidate commit is not an exact SHA/);
});

test('promotion requires passing report and three blinded narrative cases', async () => {
  const report = evaluateCandidate(corpus, baseline, makeCandidate());
  const request = createPromotionRequest(report, baseline, {
    human: 'Ada Reviewer', decision: 'approve', blindedNarrativeComparison: baseline.narrativeCaseIds.map(caseId => ({ caseId, baselineOutput: 'A', candidateOutput: 'B', sourceReportChecksum: report.canonicalReportChecksum }))
  });
  assert.equal(request.candidateCommit, candidateSha);
  assert.equal(request.human, 'Ada Reviewer');
  assert.equal(request.blindedNarrativeComparison.length, 3);
  assert.throws(() => createPromotionRequest({ ...report, finalDecision: 'fail' }, baseline, { human: 'Ada', decision: 'approve', blindedNarrativeComparison: request.blindedNarrativeComparison }));
  assert.throws(() => createPromotionRequest(report, baseline, { human: 'Ada', decision: 'approve', blindedNarrativeComparison: request.blindedNarrativeComparison.slice(0, 2) }));
  assert.throws(() => createPromotionRequest(report, baseline, { human: 'Ada', decision: 'approve', blindedNarrativeComparison: request.blindedNarrativeComparison.map(item => ({ ...item, baselineOutput: '' })) }));
  assert.throws(() => createPromotionRequest(report, baseline, { human: 'Ada', decision: 'approve', blindedNarrativeComparison: request.blindedNarrativeComparison.map(item => ({ ...item, sourceReportChecksum: 'f'.repeat(64) })) }));
  const directory = await mkdtemp(join(tmpdir(), 'kb-eval-'));
  const path = join(directory, 'promotion.json');
  const { writePromotionRequest } = await import('../dist/index.js');
  await writePromotionRequest(path, request);
  await assert.rejects(() => writePromotionRequest(path, request), /already exists/);
  assert.ok((await readFile(path, 'utf8')).includes('model-baseline-promotion-request'));
});

// Lane 0 trusted-base bootstrap probe.
