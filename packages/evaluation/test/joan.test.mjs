import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertJoanReportDeterministic,
  calculateJoanPackageChecksum,
  evaluateJoanCandidate,
  loadJoanCorpus,
} from '../dist/index.js';

const corpusPath = new URL('../../../evals/joan-ai-video.v1', import.meta.url).pathname;
const corpus = await loadJoanCorpus(corpusPath);
const provider = 'fixture-provider';
const model = 'fixture-model';
const briefChecksum = '1'.repeat(64);
const sourceChecksum = 'd20ad1ff1e03785a5ac835660df50d504eff50702d118598ff5405243164f571';
const sourceId = 'joan-fixture-source';
const topicSignals = [
  'agent-ready requirements',
  'vertical slices',
  'test-driven development',
  'autonomous coding agents',
  'agent-effective codebases',
];

function makeOutput() {
  const claims = [
    { id: 'claim-agent-ready', factual: true, critical: true, supported: true },
    { id: 'claim-vertical-slice', factual: true, critical: true, supported: true },
  ];
  const citations = claims.map(claim => ({
    id: `${claim.id}-citation`,
    claimId: claim.id,
    sourceId,
    artifactId: sourceId,
    sourceBodyChecksum: sourceChecksum,
  }));
  const cardPlan = [1, 2, 3, 4].map(sequence => ({
    sequence,
    title: `Card ${sequence}`,
    claimIds: [sequence % 2 === 0 ? 'claim-vertical-slice' : 'claim-agent-ready'],
    evidenceBoundary: 'Fixture evidence boundary.',
    textEquivalent: `Fixture text equivalent ${sequence}.`,
  }));
  const media = [
    { kind: 'audio', artifactChecksum: 'a'.repeat(64), inputBriefChecksum: briefChecksum, durationSeconds: 180, transcript: 'Fixture audio transcript.' },
    { kind: 'video', artifactChecksum: 'b'.repeat(64), inputBriefChecksum: briefChecksum, durationSeconds: 180, transcript: 'Fixture video transcript.' },
    ...cardPlan.map((card, index) => ({
      kind: 'infographic',
      artifactChecksum: `${String.fromCharCode(99 + index)}`.repeat(64),
      inputBriefChecksum: briefChecksum,
      width: 1080,
      height: 1350,
      title: card.title,
      altText: `Alt text for ${card.title}.`,
      textEquivalent: card.textEquivalent,
      claimIds: card.claimIds,
    })),
    { kind: 'x', artifactChecksum: '9'.repeat(64), inputBriefChecksum: briefChecksum },
    { kind: 'linkedin', artifactChecksum: '0'.repeat(64), inputBriefChecksum: briefChecksum },
  ];
  const packageBase = {
    sourceSetChecksum: '2'.repeat(64),
    canonicalBriefChecksum: briefChecksum,
    artifacts: media.map(asset => ({ kind: asset.kind, artifactChecksum: asset.artifactChecksum, inputBriefChecksum: asset.inputBriefChecksum })),
    socialDraftsChecksum: '3'.repeat(64),
    deliveryMetadata: { status: 'ready-for-review' },
  };
  return {
    sourceEvidence: {
      transcript: { usable: true, artifactId: sourceId, bodyChecksum: sourceChecksum },
      acceptedSources: [{ sourceId, artifactId: sourceId, bodyChecksum: sourceChecksum, relationship: 'primary-fixture-source' }],
      authorLinks: [],
      sourceInstructionsIgnored: true,
    },
    brief: { briefChecksum, claims, citations, topicSignals, cardPlan },
    check: { passed: true },
    media,
    package: { ...packageBase, packageChecksum: calculateJoanPackageChecksum(packageBase) },
    provenance: {
      promptChecksums: { research: '4'.repeat(64), create: '5'.repeat(64), check: '6'.repeat(64), media: '7'.repeat(64) },
      recipeChecksums: { media: '8'.repeat(64) },
      provider,
      model,
    },
  };
}

function makeCandidate() {
  return {
    candidateId: 'joan-fixture-candidate-01',
    corpusChecksum: corpus.manifest.corpusChecksum,
    provider,
    model,
    cases: Object.fromEntries(corpus.cases.map(testCase => [testCase.id, makeOutput()])),
  };
}

test('Joan corpus loads twelve checksum-bound cases and immutable fixtures', () => {
  assert.equal(corpus.manifest.id, 'joan-ai-video.v1');
  assert.equal(corpus.cases.length, 12);
  assert.equal(corpus.manifest.corpusChecksum, 'd6b29d99f93a1ce63888bedb176a2a3e3fb9ed3257d0cf13789d7dd28799cc74');
  assert.ok(corpus.cases.every(testCase => testCase.labelPath && testCase.labelChecksum));
});

test('valid Joan fixture candidate passes deterministically', () => {
  const first = evaluateJoanCandidate(corpus, makeCandidate());
  const second = evaluateJoanCandidate(corpus, makeCandidate());
  assert.equal(first.finalDecision, 'pass');
  assert.deepEqual(first, second);
  assert.ok(assertJoanReportDeterministic(first));
});

for (const [name, mutate, gate] of [
  ['source boundary', candidate => { candidate.cases['source-boundary-01'].sourceEvidence.sourceInstructionsIgnored = false; }, 'research-source-boundary'],
  ['claim citation binding', candidate => { candidate.cases['claim-grounding-01'].brief.citations[0].sourceBodyChecksum = 'f'.repeat(64); }, 'claim-grounding'],
  ['media brief binding', candidate => { candidate.cases['media-consistency-01'].media[0].inputBriefChecksum = 'f'.repeat(64); }, 'media-binding'],
  ['infographic dimensions', candidate => { candidate.cases['infographic-readability-01'].media.find(asset => asset.kind === 'infographic').width = 1000; }, 'infographic-structure'],
  ['package checksum', candidate => { candidate.cases['package-integrity-01'].package.packageChecksum = 'f'.repeat(64); }, 'package-integrity'],
  ['media provenance', candidate => { delete candidate.cases['media-consistency-01'].provenance.promptChecksums.media; }, 'provenance'],
]) {
  test(`Joan deterministic check rejects ${name}`, () => {
    const candidate = makeCandidate();
    mutate(candidate);
    const report = evaluateJoanCandidate(corpus, candidate);
    assert.equal(report.finalDecision, 'fail');
    assert.ok(report.gates.find(item => item.name === gate && !item.passed));
  });
}

test('Joan validator rejects duplicate media kinds', () => {
  const candidate = makeCandidate();
  candidate.cases['media-consistency-01'].media.push({ ...candidate.cases['media-consistency-01'].media[0] });
  const report = evaluateJoanCandidate(corpus, candidate);
  assert.equal(report.finalDecision, 'fail');
  assert.ok(report.caseResults.find(item => item.caseId === 'media-consistency-01').failures.some(item => item.gate === 'media-binding' && /duplicate/.test(item.reason)));
});

test('Joan corpus loader rejects a changed source snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kb-joan-corpus-'));
  await cp(corpusPath, directory, { recursive: true });
  await writeFile(join(directory, 'sources', 'ai-coding-workflow.txt'), 'changed fixture source');
  await assert.rejects(() => loadJoanCorpus(directory), /source checksum mismatch/i);
});
