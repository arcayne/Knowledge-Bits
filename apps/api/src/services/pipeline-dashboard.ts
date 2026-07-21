import {
  pipelineReadModelSchema,
  type PipelineReadModel,
} from '@knowledge-bits/contracts';

import type { WorkflowRepository, WorkflowRun } from '../repositories/workflow-repository.js';

const DAILY_DELIVERY_TARGET = 5;

type PipelineClassification = 'active' | 'deliver' | 'completed' | 'duplicate';

interface ClassifiedRun {
  run: WorkflowRun;
  classification: PipelineClassification;
  duplicateOf: string | null;
}

export class PipelineDashboardService {
  constructor(private readonly repository: WorkflowRepository) {}

  async load(): Promise<PipelineReadModel> {
    const runs = classifyRuns(await this.repository.listRuns());
    const today = startOfUtcDay(new Date());
    const counts = {
      research: 0,
      create: 0,
      check: 0,
      produce_assets: 0,
      human_review: 0,
      deliver: 0,
      delivering: 0,
      needsHuman: 0,
      active: 0,
      completed: 0,
      duplicates: 0,
      blocked: 0,
      retrying: 0,
    };
    const summaries = await Promise.all(runs.map(async ({ run, classification, duplicateOf }) => {
      const stage = run.stages[run.currentStage];
      const delivery = run.packageChecksum
        ? await this.repository.getDeliveryForPackage(run.id, run.packageChecksum)
        : null;
      if (classification === 'duplicate') {
        counts.duplicates += 1;
      } else {
        counts[run.currentStage] += 1;
        if (stage?.state === 'needs_human') counts.needsHuman += 1;
        if (classification === 'active') counts.active += 1;
        if (classification === 'deliver') counts.delivering += 1;
        if (classification === 'completed') counts.completed += 1;
        if (isBlocked(stage?.state, delivery?.state)) counts.blocked += 1;
        if (run.nextRetryAt || delivery?.nextAttemptAt) counts.retrying += 1;
      }
      return {
        id: run.id,
        title: run.title,
        locale: run.locale,
        classification,
        duplicateOf,
        currentStage: run.currentStage,
        currentState: stage?.state ?? 'queued',
        reason: stage?.reason ?? null,
        currentRevision: run.currentRevision,
        currentAttempt: stage?.attempt ?? 0,
        nextRetryAt: run.nextRetryAt?.toISOString() ?? null,
        reviewStatus: run.reviewStatus,
        delivery: delivery ? {
          state: delivery.state,
          attempts: delivery.attempts,
          target: delivery.target,
          nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
          updatedAt: delivery.updatedAt.toISOString(),
        } : null,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      };
    }));
    const canonical = summaries.filter((run) => run.classification !== 'duplicate');
    const delivered = canonical.filter((run) => (
      run.delivery?.state === 'succeeded' && new Date(run.delivery.updatedAt) >= today
    )).length;
    const daily = {
      day: today.toISOString().slice(0, 10),
      timezone: 'UTC' as const,
      target: DAILY_DELIVERY_TARGET,
      started: canonical.filter((run) => new Date(run.createdAt) >= today).length,
      readyForReview: canonical.filter((run) => (
        run.currentStage === 'human_review' && run.currentState === 'needs_human'
      )).length,
      approvedInFlight: canonical.filter((run) => (
        run.reviewStatus === 'approved'
        && run.delivery?.state !== 'succeeded'
        && run.delivery?.state !== 'superseded'
      )).length,
      delivered,
      remaining: Math.max(DAILY_DELIVERY_TARGET - delivered, 0),
    };
    return pipelineReadModelSchema.parse({ daily, counts, runs: summaries });
  }
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function isBlocked(stageState: string | undefined, deliveryState: string | undefined): boolean {
  return stageState === 'waiting'
    || stageState === 'needs_human'
    || deliveryState === 'waiting'
    || deliveryState === 'failed'
    || deliveryState === 'needs_human'
    || deliveryState === 'superseded';
}

function classifyRuns(runs: readonly WorkflowRun[]): ClassifiedRun[] {
  const currentByIdentity = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const identity = pipelineIdentity(run);
    const current = currentByIdentity.get(identity);
    if (!current || run.updatedAt > current.updatedAt || (
      run.updatedAt.getTime() === current.updatedAt.getTime() && run.id < current.id
    )) currentByIdentity.set(identity, run);
  }
  const canonicalIds = new Set([...currentByIdentity.values()].map((run) => run.id));
  return runs.map((run) => {
    const canonical = currentByIdentity.get(pipelineIdentity(run));
    if (!canonical || canonical.id === run.id) {
      return { run, classification: canonicalClassification(run), duplicateOf: null } satisfies ClassifiedRun;
    }
    return { run, classification: 'duplicate' as const, duplicateOf: canonical.id } satisfies ClassifiedRun;
  }).sort((left, right) => {
    const leftCanonical = canonicalIds.has(left.run.id) ? 0 : 1;
    const rightCanonical = canonicalIds.has(right.run.id) ? 0 : 1;
    return leftCanonical - rightCanonical
      || right.run.updatedAt.getTime() - left.run.updatedAt.getTime()
      || left.run.id.localeCompare(right.run.id);
  });
}

function canonicalClassification(run: WorkflowRun): Exclude<PipelineClassification, 'duplicate'> {
  if (run.currentStage === 'deliver') {
    return run.stages.deliver?.state === 'done' ? 'completed' : 'deliver';
  }
  return 'active';
}

function pipelineIdentity(run: WorkflowRun): string {
  const baseline = run.brief.baseline;
  if (isRecord(baseline) && typeof baseline.runId === 'string' && baseline.runId.length > 0) {
    return `baseline:${baseline.runId}`;
  }
  if (run.notebookLmNotebookId) return `notebooklm:${run.notebookLmNotebookId}`;
  return `run:${run.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
