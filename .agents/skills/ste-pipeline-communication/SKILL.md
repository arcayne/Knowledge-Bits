---
name: ste-pipeline-communication
description: Use ASD-STE100-inspired technical English for Knowledge Bits pipeline engineering communication. Use for implementation plans, debugging reports, code reviews, architecture decisions, incident analysis, task handoffs, test reports, and pipeline status summaries. Do not use for learner-facing Nuglet editorial content.
---

# STE Pipeline Communication

Use this skill for technical communication about the Knowledge Bits pipeline.

The goal is not literal ASD-STE100 compliance. The goal is precise, compact, low-ambiguity engineering prose that humans and agents can act on without reconstructing hidden reasoning.

## Scope

Use this skill for:

- implementation plans
- debugging reports
- code review comments
- architecture decisions
- incident analysis
- task handoffs
- migration plans
- test results
- technical documentation
- pipeline status summaries
- explanations of code changes

Do not apply this style mechanically to source code, identifiers, API names, commands, schemas, error messages, logs, or other technical literals.

Do not apply this skill to learner-facing Nuglet copy, stories, audio scripts, hooks, editorial framing, or marketing content.

## Core rules

1. State the result or recommendation first.
2. Use short sentences when this improves clarity.
3. Put one main idea in each sentence.
4. Prefer active voice.
5. Use concrete verbs.
6. Remove filler and conversational padding.
7. Avoid marketing language, metaphors, idioms, and rhetorical flourishes in technical reports.
8. Keep precise technical terms when they are the clearest words available.
9. Use the same term for the same concept. Do not invent synonyms to avoid repetition.
10. Separate facts, assumptions, hypotheses, and recommendations.
11. Make uncertainty explicit.
12. State a cause only when evidence supports it.
13. Prefer specific references such as file names, functions, endpoints, run IDs, stage names, tests, and log events.
14. Use lists for independent items. Avoid deep nesting.
15. Explain uncommon acronyms on first use.
16. Give commands and required actions in imperative form.
17. End operational reports with a concrete next action when one exists.

## Preserve engineering precision

Do not simplify established terms when simplification would reduce accuracy.

Examples include:

- race condition
- idempotent
- transaction
- mutex
- schema migration
- dependency injection
- API
- retry
- rollback
- invariant
- side effect
- latency
- throughput

Prefer:

`This migration is not backward compatible.`

Avoid:

`There may be some compatibility considerations associated with this migration.`

Prefer:

`I found two failures.`

Avoid:

`There appear to be a couple of areas that may warrant additional attention.`

## Default structure

Use this order when it fits the task:

### Result

State what happened or what you recommend.

### Evidence

State the relevant observations, tests, files, logs, or code paths.

### Cause

State the verified cause.

If the cause is not verified, use `Hypothesis` instead.

### Change

State what changed or what should change.

### Verification

State how the result was tested.

### Next action

State the next concrete action.

Do not add empty sections. Do not force this template onto a simple answer.

## Facts and hypotheses

Do not blend observation and inference.

Good:

`Fact: The API returns 429 after 100 requests.`

`Hypothesis: The upstream limit is configured per IP address.`

`Next check: Repeat the test from a second runner.`

Bad:

`The upstream service probably has some rate limiting going on.`

## Code reviews

A review comment should identify:

1. the problem
2. why it matters
3. the concrete change required

Good:

`This update is not atomic. Two workers can claim the same job and execute it twice. Use a database lock or an atomic claim operation before processing.`

Bad:

`You might want to consider whether there could be some concurrency issues here.`

## Debugging reports

Separate observation from inference.

Example:

`Observed: The run enters audio but never reaches validation.`

`Observed: No exception appears in the worker log.`

`Observed: The final persistence call is not executed.`

`Hypothesis: The process exits during the provider download step.`

`Next check: Add logging immediately before and after the download call.`

## Implementation plans

Plans must describe executable work.

Bad:

`Improve the ingestion architecture to make the pipeline more robust.`

Good:

1. Add a unique run ID to every intake request.
2. Store the run ID with each generated asset.
3. Reject duplicate publish requests for the same run ID.
4. Add an integration test that submits the same run twice.

## Agent handoffs

A handoff must contain enough information for another agent to continue without access to the previous agent's hidden reasoning.

Include when relevant:

- objective
- current state
- files changed
- commands run
- tests passed
- tests failed
- unresolved questions
- constraints
- recommended next action

Example:

`Objective: Make audio generation resumable after provider failure.`

`Current state: Intake and research stages are persisted. Audio completion is not.`

`Files changed: packages/pipeline/src/run.ts and packages/db/schema.prisma.`

`Verification: Unit tests pass. Resume integration test fails.`

`Failure: The resumed run creates a second audio asset.`

`Next action: Make audio asset creation idempotent using runId + assetType.`

## Knowledge Bits pipeline reporting

Use the actual repository stage names. Do not invent normalized names when the implementation uses different names.

For a pipeline bug or failed run, report these fields when known:

- run
- stage
- input
- expected state
- actual state
- retry behavior
- persistence behavior
- output artifact

Example:

`Run: kb-1842`

`Stage: audio`

`Input: editorial/core.md`

`Expected: one audio asset`

`Actual: two audio assets`

`Retry: stage executed twice`

`Persistence: first completion was not recorded`

`Result: duplicate R2 objects`

## Final check

Before sending a technical response, check:

- Is the conclusion visible immediately?
- Did I mix observation with interpretation?
- Did I use vague verbs such as `handle`, `leverage`, `improve`, `optimize`, `support`, or `manage` where a specific action exists?
- Did I use multiple names for the same concept?
- Did I hide uncertainty?
- Is the next action clear when one exists?

Rewrite if needed.

## Do not over-apply the style

Do not make the prose robotic.

Do not force every sentence onto a separate line.

Do not shorten sentences when doing so makes the explanation harder to understand.

Do not remove reasoning that another engineer or agent needs to make a decision.

The objective is reduced ambiguity, not minimum word count.
