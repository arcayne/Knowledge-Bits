import { parseEditorialCheck, requiresEditorialFailure } from '../checks/editorial.js';
import { runDeterministicChecks, type ContentCandidate, type EvidenceManifest } from '../checks/deterministic.js';
import { EDITORIAL_CHECK_PROMPT_VERSION, renderEditorialCheckPrompt } from '../prompts/editorial-check.v1.js';

import {
  ProviderNeedsHumanError,
  type ContentProvider,
  type ProviderExecution,
  type ProviderExecutionInput,
} from './types.js';

export interface PiSdkClient {
  check(input: {
    candidate: ContentCandidate;
    evidence: EvidenceManifest;
    rubric: string;
  }): Promise<unknown>;
}

export class PiEditorialProvider implements ContentProvider {
  readonly name = 'pi';
  readonly capabilities = ['check_content'] as const;

  constructor(private readonly options: {
    client: PiSdkClient;
    context: (input: ProviderExecutionInput) => Promise<{
      candidate: ContentCandidate;
      evidence: EvidenceManifest;
      rubric: string;
    }>;
  }) {}

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    if (input.action !== 'check_content') throw new ProviderNeedsHumanError(`pi_unsupported_action:${input.action}`);
    const context = await this.options.context(input);
    const deterministic = runDeterministicChecks(context);
    if (!deterministic.passed) throw new ProviderNeedsHumanError('deterministic_check_failed');

    const response = await this.options.client.check({
      candidate: context.candidate,
      evidence: context.evidence,
      rubric: context.rubric,
    });
    const editorial = parseEditorialCheck(response);
    if (requiresEditorialFailure(editorial)) throw new ProviderNeedsHumanError('editorial_check_failed');

    return {
      kind: 'success',
      rawResponse: Buffer.from(JSON.stringify(response)),
      parsedOutput: { deterministic, editorial },
      executionReport: {
        promptVersion: EDITORIAL_CHECK_PROMPT_VERSION,
        provider: this.name,
        renderedPrompt: renderEditorialCheckPrompt(context.rubric),
      },
    };
  }
}
