import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderNeedsHumanError, ProviderWaitingError } from './types.js';
import { NotebookLmNotebookProvisioner, type NotebookProvisioningProcess } from './notebooklm-provisioner.js';

test('reuses a notebook with the deterministic Joan title before creating another one', async () => {
  const process = fakeProcess([
    response(JSON.stringify([
      { id: 'legacy-notebook', title: '', source_count: 0 },
      { id: 'existing-notebook', title: 'Joan AI — -QFHIoCo-Ko', source_count: 0, updated_at: '2026-08-19T08:39:35Z' },
    ])),
  ]);
  const provisioner = new NotebookLmNotebookProvisioner({ process });

  const result = await provisioner.provision({
    title: '  Joan AI —   -QFHIoCo-Ko ',
    idempotencyKey: 'run-1:research',
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    notebookId: 'existing-notebook',
    title: 'Joan AI — -QFHIoCo-Ko',
    reused: true,
  });
  assert.equal(process.calls.length, 1);
  assert.deepEqual(process.calls[0]?.args, ['notebook', 'list', '--json']);
});

test('creates a notebook with JSON output after the deterministic lookup misses', async () => {
  const process = fakeProcess([
    response('[]'),
    response(JSON.stringify({
      notebook_id: 'created-notebook',
      title: 'Joan AI — -QFHIoCo-Ko',
      url: 'https://notebooklm.google.com/notebook/created-notebook',
    })),
  ]);
  const provisioner = new NotebookLmNotebookProvisioner({ process, command: '/usr/local/bin/nlm' });

  const result = await provisioner.provision({
    title: 'Joan AI — -QFHIoCo-Ko',
    idempotencyKey: 'run-1:research',
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    notebookId: 'created-notebook',
    title: 'Joan AI — -QFHIoCo-Ko',
    url: 'https://notebooklm.google.com/notebook/created-notebook',
    reused: false,
  });
  assert.deepEqual(process.calls[1]?.args, ['notebook', 'create', 'Joan AI — -QFHIoCo-Ko', '--json']);
  assert.equal(process.calls[1]?.command, '/usr/local/bin/nlm');
});

test('classifies authentication and timeout failures as typed operational outcomes', async (context) => {
  await context.test('authentication', async () => {
    const provisioner = new NotebookLmNotebookProvisioner({
      process: fakeProcess([response('', 'Please run nlm login', 2)]),
    });
    await assert.rejects(
      () => provisioner.provision({ title: 'Joan AI — test', idempotencyKey: 'key', signal: new AbortController().signal }),
      (error: unknown) => error instanceof ProviderNeedsHumanError && error.message === 'notebooklm_provisioning_configuration',
    );
  });
  await context.test('timeout', async () => {
    const provisioner = new NotebookLmNotebookProvisioner({
      process: fakeProcess([{ stdout: '', stderr: '', exitCode: null, timedOut: true }]),
    });
    await assert.rejects(
      () => provisioner.provision({ title: 'Joan AI — test', idempotencyKey: 'key', signal: new AbortController().signal }),
      (error: unknown) => error instanceof ProviderWaitingError && error.message === 'notebooklm_provisioning_timeout',
    );
  });
});

function response(stdout: string, stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode };
}

function fakeProcess(responses: Array<Awaited<ReturnType<NotebookProvisioningProcess['run']>>>) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let index = 0;
  const process: NotebookProvisioningProcess & { calls: typeof calls } = {
    calls,
    async run(input) {
      calls.push({ command: input.command, args: input.args });
      const result = responses[index];
      index += 1;
      if (!result) throw new Error('Unexpected process call');
      return result;
    },
  };
  return process;
}
