import { parseEditorialCheck, requiresEditorialFailure } from '../checks/editorial.js';
import { runDeterministicChecks, type ContentCandidate, type EvidenceManifest } from '../checks/deterministic.js';
import { EDITORIAL_CHECK_PROMPT_VERSION, renderEditorialCheckPrompt } from '../prompts/editorial-check.v1.js';
import type { NugletGenerationPlan } from '@knowledge-bits/contracts';
import { renderPromptSections } from '../recipes/file-registry.js';
import { generationSupportArtifacts } from '../recipes/support-artifacts.js';
import type { ResolvedNugletRecipes } from '../recipes/types.js';

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
    renderedPrompt: string;
    idempotencyKey: string;
    signal: AbortSignal;
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
      generationPlan?: NugletGenerationPlan;
      resolvedRecipes?: Partial<ResolvedNugletRecipes>;
    }>;
    model?: string;
  }) {}

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    if (input.action !== 'check_content') throw new ProviderNeedsHumanError(`pi_unsupported_action:${input.action}`);
    const context = await this.options.context(input);
    const recipe = context.generationPlan ? context.resolvedRecipes?.editorialQa : undefined;
    if (context.generationPlan && !recipe) {
      throw new ProviderNeedsHumanError('generation_recipe_resolution_missing');
    }
    const deterministic = runDeterministicChecks(context);
    if (!deterministic.passed) throw new ProviderNeedsHumanError('deterministic_check_failed', 'quality');

    const rubric = recipe ? Buffer.from(recipe.canonicalBytes).toString('utf8') : context.rubric;
    const renderedPromptBytes = renderPromptSections([
      renderEditorialCheckPrompt(rubric),
      'Review context:',
      JSON.stringify({ candidate: context.candidate, evidence: context.evidence }),
    ]);
    const renderedPrompt = Buffer.from(renderedPromptBytes).toString('utf8');
    const response = await this.options.client.check({
      candidate: context.candidate,
      evidence: context.evidence,
      rubric,
      renderedPrompt,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
    });
    const editorial = parseEditorialCheck(response);
    if (requiresEditorialFailure(editorial)) throw new ProviderNeedsHumanError('editorial_check_failed', 'quality');

    return {
      kind: 'success',
      rawResponse: Buffer.from(JSON.stringify(response)),
      parsedOutput: { deterministic, editorial },
      executionReport: {
        promptVersion: recipe ? `${recipe.id}@${recipe.version}` : EDITORIAL_CHECK_PROMPT_VERSION,
        provider: this.name,
        renderedPrompt,
      },
      ...(recipe ? {
        supportArtifacts: generationSupportArtifacts({
          recipe,
          prompt: renderedPromptBytes,
          model: this.options.model ?? 'pi-editorial',
          executionInput: input,
        }),
      } : {}),
    };
  }
}
