import {
  knowledgeBitsCreateRunRequestSchema,
  nugletSimilarityRequestSchema,
  nugletSimilarityResponseSchema,
  nugletSimilarityReviewSchema,
  workflowRunResponseSchema,
} from '@knowledge-bits/contracts';

import type { Hono } from 'hono';

import type { EngineAuthConfig } from '../auth.js';
import { requireApiOrReviewPrincipal, requireEngineScope } from '../auth.js';
import { WorkflowConflictError, type WorkflowRepository, type WorkflowRun } from '../repositories/workflow-repository.js';
import { analyzeNugletSimilarity } from '../services/nuglet-similarity.js';
import { bindStandardNugletIntakePlan } from '../services/standard-nuglet-intake.js';

export function registerRunRoutes(
  app: Hono,
  dependencies: { repository: WorkflowRepository; auth: EngineAuthConfig },
): void {
  app.post('/runs', async (context) => {
    const authFailure = requireApiOrReviewPrincipal(context, dependencies.auth);
    if (authFailure) return authFailure;
    const input = knowledgeBitsCreateRunRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid run input' }, 400);

    try {
      const similarityInput = standardNugletSimilarityInput(input.data.title, input.data.locale, input.data.brief);
      if (similarityInput === null) {
        return context.json({ error: 'New Nuglet intake requires a learner objective' }, 400);
      }
      let intakeBrief = input.data.brief;
      if (similarityInput) {
        const similarity = analyzeNugletSimilarity(similarityInput, await dependencies.repository.listRuns());
        const review = similarityReviewFromBrief(input.data.brief);
        if (review && review.fingerprint !== similarity.fingerprint) {
          return context.json({
            error: 'Similarity preflight is stale; review the current matches',
            similarity,
          }, 409);
        }
        if (similarity.risk !== 'none' && review?.decision !== 'proceed_distinct') {
          return context.json({
            error: 'Similar Nuglets require explicit distinct-angle confirmation',
            similarity,
          }, 409);
        }
        intakeBrief = withSimilarityReview(input.data.brief, similarity.fingerprint, (
          similarity.risk === 'none' ? 'clear' : 'proceed_distinct'
        ));
      }
      const brief = bindStandardNugletIntakePlan({
        title: input.data.title,
        brief: intakeBrief,
      });
      const boundInput = knowledgeBitsCreateRunRequestSchema.safeParse({
        ...input.data,
        brief,
      });
      if (!boundInput.success) return context.json({ error: 'Invalid run input' }, 400);
      const run = await dependencies.repository.bootstrapRun({
        ...boundInput.data,
        notebookLmNotebookId: boundInput.data.notebookLmNotebookId
          ?? notebookIdFromBrief(brief),
      });
      return context.json(workflowRunResponseSchema.parse(toRunResponse(run)), 201);
    } catch (error) {
      if (error instanceof WorkflowConflictError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.post('/runs/similarity', async (context) => {
    const authFailure = requireApiOrReviewPrincipal(context, dependencies.auth);
    if (authFailure) return authFailure;
    const input = nugletSimilarityRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ error: 'Invalid similarity input' }, 400);
    const result = analyzeNugletSimilarity(input.data, await dependencies.repository.listRuns());
    return context.json(nugletSimilarityResponseSchema.parse(result));
  });

  app.get('/runs/:id', async (context) => {
    const authFailure = requireEngineScope(context, dependencies.auth, 'api');
    if (authFailure) return authFailure;

    const run = await dependencies.repository.getRun(context.req.param('id'));
    if (!run) return context.json({ error: 'Run not found' }, 404);
    return context.json(workflowRunResponseSchema.parse(toRunResponse(run)));
  });
}

function toRunResponse(run: WorkflowRun) {
  return {
    ...run,
    notebookLmNotebookId: run.notebookLmNotebookId ?? null,
    packageChecksum: run.packageChecksum,
    approvedChecksum: run.approvedChecksum,
    reviewStatus: run.reviewStatus,
    nextRetryAt: run.nextRetryAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function notebookIdFromBrief(brief: Record<string, unknown>): string | undefined {
  const value = brief.notebookLmNotebookId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function standardNugletSimilarityInput(
  title: string,
  locale: string,
  brief: Record<string, unknown>,
): ReturnType<typeof nugletSimilarityRequestSchema.parse> | null | undefined {
  const intake = isRecord(brief.intake) ? brief.intake : undefined;
  if (
    intake?.requestedFormat !== 'story_playbook'
    && intake?.requestedFormat !== 'single_narrative'
  ) return undefined;
  const parsed = nugletSimilarityRequestSchema.safeParse({
    title,
    objective: brief.objective,
    ...(typeof brief.audience === 'string' ? { audience: brief.audience } : {}),
    locale,
  });
  return parsed.success ? parsed.data : null;
}

function similarityReviewFromBrief(brief: Record<string, unknown>) {
  const intake = isRecord(brief.intake) ? brief.intake : undefined;
  const parsed = nugletSimilarityReviewSchema.safeParse(intake?.similarityReview);
  return parsed.success ? parsed.data : undefined;
}

function withSimilarityReview(
  brief: Record<string, unknown>,
  fingerprint: string,
  decision: 'clear' | 'proceed_distinct',
) {
  const intake = isRecord(brief.intake) ? brief.intake : {};
  return {
    ...brief,
    intake: {
      ...intake,
      similarityReview: { fingerprint, decision },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
