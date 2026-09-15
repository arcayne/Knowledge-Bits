import type { Checksum, StageState, WorkflowStage } from '@knowledge-bits/contracts';

export const STAGES = [
  'research',
  'create',
  'check',
  'produce_assets',
  'human_review',
  'deliver',
] as const satisfies readonly WorkflowStage[];

const LEGAL_STATES_BY_STAGE = {
  research: ['queued', 'running', 'waiting', 'needs_human'],
  create: ['queued', 'running', 'waiting', 'needs_human'],
  check: ['queued', 'running', 'waiting', 'needs_human'],
  produce_assets: ['queued', 'running', 'waiting', 'needs_human'],
  human_review: ['needs_human', 'done'],
  deliver: ['queued', 'running', 'waiting', 'needs_human', 'done'],
} as const satisfies Record<WorkflowStage, readonly StageState[]>;

export interface WorkflowSnapshot {
  stage: WorkflowStage;
  state: StageState;
  revisionAttempts: number;
  packageChecksum: Checksum | null;
  approvedChecksum: Checksum | null;
  reason?: string;
}

export type WorkflowEvent =
  | { type: 'job_started' }
  | { type: 'job_waiting'; reason: string }
  | { type: 'job_needs_human'; reason: string }
  | { type: 'stage_completed'; packageChecksum: Checksum }
  | { type: 'quality_failed'; reason: string }
  | { type: 'review_approved'; packageChecksum: Checksum; reviewerId: string }
  | { type: 'review_rejected'; reason: string; reviewerId: string }
  | { type: 'changes_requested'; reason: string; reviewerId: string }
  | { type: 'media_reconciliation_requested'; reason: string }
  | { type: 'package_changed'; packageChecksum: Checksum }
  | { type: 'delivery_succeeded' }
  | { type: 'delivery_failed'; reason: string }
  | { type: 'delivery_needs_human'; reason: string };

export type WorkflowEffect =
  | { type: 'queue_stage'; stage: Exclude<WorkflowStage, 'deliver'> }
  | { type: 'request_review'; packageChecksum: Checksum }
  | { type: 'request_human'; reason: string }
  | { type: 'queue_delivery'; packageChecksum: Checksum }
  | { type: 'record_delivery'; state: 'succeeded' };

export interface TransitionResult extends WorkflowSnapshot {
  effects: WorkflowEffect[];
}

export class WorkflowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowTransitionError';
  }
}

export function nextTransition(
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
): TransitionResult {
  validateSnapshot(snapshot);
  rejectProviderSelectedStage(event);

  switch (event.type) {
    case 'job_started':
      requireState(snapshot, 'queued', 'waiting');
      return transition(snapshot, { state: 'running' });

    case 'job_waiting':
      requireState(snapshot, 'running');
      return transition(snapshot, { state: 'waiting', reason: event.reason });

    case 'job_needs_human':
      requireState(snapshot, 'running');
      if (snapshot.stage === 'human_review') {
        throw new WorkflowTransitionError('Human review cannot report an automated configuration failure');
      }
      return transition(snapshot, { state: 'needs_human', reason: event.reason }, [
        { type: 'request_human', reason: event.reason },
      ]);

    case 'stage_completed':
      return completeStage(snapshot, event.packageChecksum);

    case 'quality_failed':
      return failQualityCheck(snapshot, event.reason);

    case 'review_approved':
      return approveReview(snapshot, event);

    case 'review_rejected':
      requireSnapshot(snapshot, 'human_review', 'needs_human');
      return transition(snapshot, { state: 'done', reason: event.reason });

    case 'changes_requested':
      requireSnapshot(snapshot, 'human_review', 'needs_human');
      return transition(snapshot, {
        stage: 'create',
        state: 'queued',
        reason: event.reason,
      }, [{ type: 'queue_stage', stage: 'create' }]);

    case 'media_reconciliation_requested':
      requireSnapshot(snapshot, 'human_review', 'needs_human');
      return transition(snapshot, {
        stage: 'produce_assets',
        state: 'queued',
        reason: event.reason,
        approvedChecksum: null,
      }, [{ type: 'queue_stage', stage: 'produce_assets' }]);

    case 'package_changed':
      return packageChanged(snapshot, event.packageChecksum);

    case 'delivery_succeeded':
      requireSnapshot(snapshot, 'deliver', 'running');
      return transition(snapshot, { state: 'done' }, [{ type: 'record_delivery', state: 'succeeded' }]);

    case 'delivery_failed':
      requireSnapshot(snapshot, 'deliver', 'running');
      return transition(snapshot, { state: 'queued', reason: event.reason }, [queueDelivery(snapshot)]);

    case 'delivery_needs_human':
      requireSnapshot(snapshot, 'deliver', 'running');
      return transition(snapshot, { state: 'needs_human', reason: event.reason });
  }
}

function completeStage(snapshot: WorkflowSnapshot, packageChecksum: Checksum): TransitionResult {
  requireState(snapshot, 'running');

  if (snapshot.stage === 'deliver' || snapshot.stage === 'human_review') {
    throw new WorkflowTransitionError(`Stage ${snapshot.stage} cannot be completed by a provider`);
  }

  const nextStage = STAGES[STAGES.indexOf(snapshot.stage) + 1];
  if (!nextStage || nextStage === 'deliver') {
    throw new WorkflowTransitionError(`Stage ${snapshot.stage} has no provider successor`);
  }

  if (nextStage === 'human_review') {
    return transition(snapshot, {
      stage: nextStage,
      state: 'needs_human',
      packageChecksum,
    }, [{ type: 'request_review', packageChecksum }]);
  }

  return transition(snapshot, {
    stage: nextStage,
    state: 'queued',
    packageChecksum,
  }, [{ type: 'queue_stage', stage: nextStage }]);
}

function failQualityCheck(snapshot: WorkflowSnapshot, reason: string): TransitionResult {
  requireSnapshot(snapshot, 'check', 'running');

  if (snapshot.revisionAttempts >= 2) {
    return transition(snapshot, {
      state: 'needs_human',
      reason,
    }, [{ type: 'request_human', reason }]);
  }

  return transition(snapshot, {
    stage: 'create',
    state: 'queued',
    revisionAttempts: snapshot.revisionAttempts + 1,
    reason,
  }, [{ type: 'queue_stage', stage: 'create' }]);
}

function approveReview(
  snapshot: WorkflowSnapshot,
  event: Extract<WorkflowEvent, { type: 'review_approved' }>,
): TransitionResult {
  requireSnapshot(snapshot, 'human_review', 'needs_human');

  if (snapshot.packageChecksum !== event.packageChecksum) {
    throw new WorkflowTransitionError('Approval checksum must match the current package checksum');
  }

  return transition(snapshot, {
    stage: 'deliver',
    state: 'queued',
    approvedChecksum: event.packageChecksum,
  }, [{ type: 'queue_delivery', packageChecksum: event.packageChecksum }]);
}

function packageChanged(snapshot: WorkflowSnapshot, packageChecksum: Checksum): TransitionResult {
  if (snapshot.packageChecksum === packageChecksum) return transition(snapshot, {});

  if (snapshot.approvedChecksum !== null) {
    return transition(snapshot, {
      stage: 'human_review',
      state: 'needs_human',
      packageChecksum,
      approvedChecksum: null,
    }, [{ type: 'request_review', packageChecksum }]);
  }

  return transition(snapshot, { packageChecksum });
}

function queueDelivery(snapshot: WorkflowSnapshot): WorkflowEffect {
  if (snapshot.packageChecksum === null) {
    throw new WorkflowTransitionError('Delivery requires a package checksum');
  }

  return { type: 'queue_delivery', packageChecksum: snapshot.packageChecksum };
}

function transition(
  snapshot: WorkflowSnapshot,
  changes: Partial<WorkflowSnapshot>,
  effects: WorkflowEffect[] = [],
): TransitionResult {
  const result = { ...snapshot, ...changes, effects };
  validateSnapshot(result);
  return result;
}

function validateSnapshot(snapshot: WorkflowSnapshot): void {
  const legalStates: readonly StageState[] | undefined = Object.hasOwn(LEGAL_STATES_BY_STAGE, snapshot.stage)
    ? LEGAL_STATES_BY_STAGE[snapshot.stage]
    : undefined;

  if (!legalStates?.includes(snapshot.state)) {
    throw new WorkflowTransitionError(
      `Invalid workflow snapshot: ${snapshot.stage}/${snapshot.state}`,
    );
  }
}

function requireSnapshot(
  snapshot: WorkflowSnapshot,
  stage: WorkflowStage,
  state: StageState,
): void {
  if (snapshot.stage !== stage || snapshot.state !== state) {
    throw new WorkflowTransitionError(
      `Event is not permitted for ${snapshot.stage}/${snapshot.state}; expected ${stage}/${state}`,
    );
  }
}

function requireState(snapshot: WorkflowSnapshot, ...states: StageState[]): void {
  if (!states.includes(snapshot.state)) {
    throw new WorkflowTransitionError(
      `Event is not permitted while state is ${snapshot.state}; expected ${states.join(' or ')}`,
    );
  }
}

function rejectProviderSelectedStage(event: WorkflowEvent): void {
  if (Object.hasOwn(event, 'stage')) {
    throw new WorkflowTransitionError('Events must not select workflow stages');
  }
}
