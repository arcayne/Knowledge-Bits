import assert from 'node:assert/strict';
import test from 'node:test';

import { NotebookLmResearchSourceDiscoveryClient } from './notebooklm-research.js';

const notebookId = 'c20fd528-bb60-415e-b9f2-220c502d5839';
const youtubeUrl = 'https://www.youtube.com/watch?v=-QFHIoCo-Ko';

test('uses YouTube title and author in NotebookLM web research and parses candidates', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const client = new NotebookLmResearchSourceDiscoveryClient({
    process: {
      async run(input) {
        calls.push({ command: input.command, args: input.args });
        if (input.args[0] === 'research' && input.args[1] === 'start') {
          return { stdout: 'Research started. Task ID: task-123\n', stderr: '', exitCode: 0 };
        }
        return {
          stdout: [
            'Research task completed.',
            'Discovered Sources',
            '[0] Agent-ready requirements |',
            'Primary paper',
            'https://example.org/paper',
            '[1] Official documentation',
            'https://docs.example.org/agents',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      },
    },
    fetch: async () => new Response(JSON.stringify({
      title: 'Full Walkthrough: Workflow for AI Coding',
      author_name: 'Matt Pocock',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    timeoutMs: 180_000,
  });

  const result = await client.discoverSources({
    topic: 'Workflow for AI Coding',
    audience: 'people who need concise AI video summaries',
    objective: 'Explain the most useful practices from the video.',
    seedUrls: [youtubeUrl],
    notebookId,
    maxCandidates: 2,
    idempotencyKey: 'run-123',
    signal: new AbortController().signal,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.command, 'nlm');
  assert.equal(calls[0]?.args[0], 'research');
  assert.equal(calls[0]?.args[1], 'start');
  assert.match(calls[0]?.args[2] ?? '', /Full Walkthrough: Workflow for AI Coding/);
  assert.match(calls[0]?.args[2] ?? '', /Matt Pocock/);
  assert.deepEqual(calls[0]?.args.slice(-6), ['--source', 'web', '--mode', 'fast', '--notebook-id', notebookId]);
  assert.deepEqual(calls[1]?.args, [
    'research', 'status', notebookId,
    '--task-id', 'task-123',
    '--max-wait', '180',
    '--poll-interval', '5',
    '--full',
  ]);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]?.title, 'Agent-ready requirements | Primary paper');
  assert.equal(result.candidates[0]?.url, 'https://example.org/paper');
  assert.equal(result.report.provider, 'notebooklm-research');
  assert.equal(result.report.returnedCandidateCount, 2);
});

test('reports an actionable quality stop when NotebookLM returns no sources', async () => {
  const client = new NotebookLmResearchSourceDiscoveryClient({
    process: {
      async run(input) {
        return input.args[1] === 'start'
          ? { stdout: 'Task ID: task-empty', stderr: '', exitCode: 0 }
          : { stdout: 'Research task completed.\nDiscovered Sources\n', stderr: '', exitCode: 0 };
      },
    },
    fetch: async () => new Response(JSON.stringify({ title: 'Video', author_name: 'Author' }), { status: 200 }),
  });

  await assert.rejects(
    client.discoverSources({
      topic: 'Video',
      audience: 'general adult learners',
      objective: 'Summarize the video.',
      seedUrls: [youtubeUrl],
      notebookId,
      maxCandidates: 3,
      idempotencyKey: 'run-empty',
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof Error
      && error.name === 'ProviderNeedsHumanError'
      && error.message === 'notebooklm_research_no_sources',
  );
});
