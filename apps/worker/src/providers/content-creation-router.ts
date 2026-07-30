import {
  ProviderNeedsHumanError,
  type ContentProvider,
  type ProviderExecution,
  type ProviderExecutionInput,
} from './types.js';

export class ContentCreationRouterProvider implements ContentProvider {
  readonly name: string;
  readonly capabilities = ['collect_sources', 'create_content'] as const;

  constructor(private readonly options: {
    legacy?: ContentProvider;
    narrative?: ContentProvider;
  }) {
    this.name = options.legacy?.name ?? 'notebooklm-unavailable';
  }

  async execute(input: ProviderExecutionInput): Promise<ProviderExecution> {
    if (input.action === 'collect_sources') {
      if (!this.options.legacy) {
        throw new ProviderNeedsHumanError('provider_runtime_unconfigured:notebooklm');
      }
      return this.options.legacy.execute(input);
    }
    if (input.action !== 'create_content') {
      throw new ProviderNeedsHumanError(`content_creation_router_unsupported_action:${input.action}`);
    }
    const brief = recordValue(input.job.input.brief);
    const plan = recordValue(brief?.generationPlan);
    const contentKind = plan?.contentKind ?? brief?.contentKind;
    if (contentKind === 'nuglet.lesson.v2') {
      if (!this.options.narrative) {
        throw new ProviderNeedsHumanError('narrative_writer_unconfigured');
      }
      return this.options.narrative.execute(input);
    }
    if (!this.options.legacy) {
      throw new ProviderNeedsHumanError('provider_runtime_unconfigured:notebooklm');
    }
    return this.options.legacy.execute(input);
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
