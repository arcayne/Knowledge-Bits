import type { JobClaim } from '@knowledge-bits/contracts';

export const WORKER_ACTIONS = [
  'collect_sources',
  'create_content',
  'check_content',
  'produce_assets',
  'deliver_package',
] as const;

export type WorkerAction = typeof WORKER_ACTIONS[number];
export type ContentAction = Exclude<WorkerAction, 'produce_assets'>;

export interface ProviderExecutionInput {
  job: JobClaim;
  action: WorkerAction;
  idempotencyKey: string;
  signal: AbortSignal;
}

export type ProviderExecution =
  | {
    kind: 'success';
    rawResponse: Uint8Array;
    parsedOutput: unknown;
    executionReport: unknown;
    inputChecksum?: string;
  }
  | {
    kind: 'waiting';
    reason: string;
    retryAt: string;
  }
  | {
    kind: 'needs_human';
    reason: string;
  };

export interface WorkerProvider {
  name: string;
  capabilities: readonly WorkerAction[];
  execute(input: ProviderExecutionInput): Promise<ProviderExecution>;
}

export interface ContentProvider extends WorkerProvider {
  capabilities: readonly ContentAction[];
}

export interface MediaProvider extends WorkerProvider {
  capabilities: readonly ['produce_assets'];
}

export class ProviderWaitingError extends Error {
  constructor(
    message: string,
    readonly retryAt: string,
  ) {
    super(message);
    this.name = 'ProviderWaitingError';
  }
}

export class ProviderNeedsHumanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNeedsHumanError';
  }
}
