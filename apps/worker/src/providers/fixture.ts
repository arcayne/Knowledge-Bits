import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  type ProviderExecution,
  type ProviderExecutionInput,
  type WorkerAction,
  type WorkerProvider,
} from './types.js';

const FIXTURE_FILE_BY_ACTION: Readonly<Record<WorkerAction, string>> = {
  collect_sources: 'collect-sources.json',
  create_content: 'create-content.json',
  check_content: 'check-content.json',
  produce_assets: 'produce-assets.json',
  deliver_package: 'deliver-package.json',
};

export class FixtureProvider implements WorkerProvider {
  readonly name = 'fixture';
  readonly capabilities = Object.keys(FIXTURE_FILE_BY_ACTION) as WorkerAction[];

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    const fixtureName = FIXTURE_FILE_BY_ACTION[input.action];
    const rawResponse = await readFile(new URL(`./fixtures/${fixtureName}`, import.meta.url));
    const parsedOutput = JSON.parse(rawResponse.toString('utf8')) as unknown;
    const fixtureChecksum = createHash('sha256').update(rawResponse).digest('hex');

    return {
      kind: 'success',
      rawResponse,
      parsedOutput,
      executionReport: {
        action: input.action,
        fixtureChecksum,
        idempotencyKey: input.idempotencyKey,
        provider: this.name,
      },
    };
  }
}
