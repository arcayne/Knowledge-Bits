import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBaseline,
  loadCorpus,
  fixtureCandidate,
  runLane1,
  resolveCandidateProvenance,
  executeProviderCommand,
} from '../dist/index.js';

const baselinePath = new URL('../../../evals/knowledge-bits.v1/baselines/baseline-20260809-01.json', import.meta.url).pathname;
const baseline = await loadBaseline(baselinePath);
const corpus = await loadCorpus(new URL('../../../evals/knowledge-bits.v1', import.meta.url).pathname);

test('trusted baseline identity and checksum reject replacement and tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-baseline-'));
  const replacement = join(directory, 'baseline.json');
  await writeFile(replacement, await readFile(baselinePath));
  await assert.rejects(() => loadBaseline(replacement, { expectedId: 'wrong-baseline', trustedChecksum: baseline.checksum }), /identity/i);
  const tampered = { ...baseline, provider: 'attacker', checksum: baseline.checksum };
  await writeFile(replacement, JSON.stringify(tampered));
  await assert.rejects(() => loadBaseline(replacement, { trustedChecksum: baseline.checksum }), /checksum/i);
});

test('trusted baseline path can be required outside the evaluated project root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-project-'));
  const projectRoot = new URL('../../../', import.meta.url).pathname;
  await assert.rejects(() => loadBaseline(baselinePath, { projectRoot, requireOutsideProjectRoot: true }), /outside/i);
  await assert.doesNotReject(() => loadBaseline(baselinePath, { projectRoot: directory, requireOutsideProjectRoot: true, trustedChecksum: baseline.checksum }));
});

test('candidate provenance resolves actual bytes and changes when a candidate file changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-provenance-'));
  await mkdir(join(directory, 'files'), { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ recipes: { recipe: ['files/recipe.txt'] }, prompts: { prompt: ['files/prompt.txt'] } }));
  await writeFile(join(directory, 'files/recipe.txt'), 'recipe-a');
  await writeFile(join(directory, 'files/prompt.txt'), 'prompt-a');
  const first = await resolveCandidateProvenance(directory, 'manifest.json');
  await writeFile(join(directory, 'files/prompt.txt'), 'prompt-b');
  const second = await resolveCandidateProvenance(directory, 'manifest.json');
  assert.notEqual(first.promptChecksums.prompt, second.promptChecksums.prompt);
  assert.equal(first.recipeChecksums.recipe, second.recipeChecksums.recipe);
});

test('provider command structured output reaches scoring', async () => {
  const command = "node -e \"process.stdin.on('data',()=>process.stdout.write(JSON.stringify({execution:{text:'KB_FAKE_CANARY',claims:[],citations:[],toolEvents:[]}})))\"";
  const result = await executeProviderCommand(command, {
    schemaVersion: 'knowledge-bits.evaluation-case.v1', caseId: 'injection-01', title: 'fixture', coverage: ['prompt-injection'],
    source: { id: 'source', body: 'fixture', bodyChecksum: 'a'.repeat(64) }, provider: 'evaluation-only', model: 'fixture',
  });
  assert.equal(result.execution.text, 'KB_FAKE_CANARY');
  const candidate = fixtureCandidate(corpus, {
    candidateCommit: 'c'.repeat(40), baselineId: baseline.id, corpusChecksum: corpus.manifest.corpusChecksum,
    recipeChecksums: baseline.recipeChecksums, promptChecksums: baseline.promptChecksums,
    provider: 'evaluation-only', model: 'fixture',
  });
  const lane = await runLane1({
    changedPaths: ['prompts/create.md'], corpus, baseline, candidate,
    providerIdentity: { provider: 'evaluation-only', model: 'fixture', evaluationOnly: true }, providerCommand: command,
  });
  assert.equal(lane.report.finalDecision, 'fail');
  assert.equal(lane.report.gates.find(gate => gate.name === 'prompt-injection').passed, false);
});
