# Task 5 Report

## Result

Repaired Task 5 for `nuglet.lesson.v1` schema `1.1.0`. NotebookLM now renders a generic request from stable named inputs, the exported shared contract descriptor, and the exact canonical Story, Playbook, and Challenge recipe bytes. Those three resolved recipes are the only editorial guidance in the active Create request.

Legacy `1.0.0` behavior remains separate. Legacy PI calls retain the pre-Task-5 request object and exact JSON wire shape, and legacy claim-coverage findings retain their original messages, order, and cardinality.

## Shared Contract

- Added the exported `nuglet.lesson.story-playbook-draft.contract.v1` descriptor in `@knowledge-bits/contracts`.
- Moved the `1.1.0` target, payload anatomy, Story and Playbook structure, Challenge counts, claim-coverage paths, and draft-only media boundary into that descriptor.
- Added required non-empty `learning.terminology` to the `1.1.0` schema and updated contract, worker, and pipeline fixtures.
- Added the exported canonical term normalizer: Unicode NFKC, locale-independent lowercase, non-letter-or-number runs converted to one space, then trim and whitespace collapse.
- Rejects canonical terms that are empty or duplicate after normalization.

## NotebookLM

- Removed active Nuglet product instructions and hero direction from `apps/worker/src/providers/notebooklm.ts`.
- The active request now contains only a generic strict-JSON transport instruction, stable named inputs, the shared contract descriptor, and resolved canonical recipe bytes.
- Kept the Story, Playbook, and Challenge recipe snapshots and exact prompt artifacts for the initial request and the single structured-output repair request.
- Kept the result semantic and draft-only. No Task 6 assets, media metadata, audio bytes, or transcripts were introduced.

## PI And Deterministic QA

- Branches PI explicitly on both generation-plan schema `1.1.0` and the versioned candidate envelope, failing closed when they disagree.
- Uses the resolved editorial recipe, rendered prompt, and Task 4 support artifacts only for `1.1.0` candidates.
- Legacy PI omits `renderedPrompt` from the provider request and sends the exact prior `JSON.stringify({ candidate, evidence, rubric })` wire payload.
- Requires every canonical terminology term to occur in both Story and Playbook under the shared normalization, while preserving the existing central idea, line, action, and non-duplication checks.
- Restored the legacy duplicate-path finding followed by one path-specific finding for every missing or invalid legacy learner field.
- Kept exactly three Challenge questions and all semantic and nested claim-coverage checks.

## Test-Driven Evidence

- Contract red run: 21 passed, 3 failed for the missing terminology field, descriptor, and normalizer.
- Focused Task 5 red run: 23 passed, 5 failed for terminology drift, legacy claim diagnostics, generic provider rendering, legacy PI provider shape, and legacy PI wire JSON.
- Downstream compatibility red run: 32 passed, 1 failed for the pipeline's pre-terminology `1.1.0` fixture.
- Each red run failed on the intended missing behavior before its implementation or fixture repair.

## Verification

- Contract tests: 24 passed.
- Contract typecheck: passed.
- Focused NotebookLM, deterministic, and PI tests: 28 passed.
- Full worker suite: 92 passed.
- Worker build: passed.
- Pipeline suite: 33 passed.
- Workspace typechecks: 5 of 5 passed.
- Forbidden credential scan: passed for 146 tracked files.
- `git diff --check`: passed.

## Concerns

- Verification ran on Node `v26.5.0`, while the workspace declares `>=24 <25`. Pnpm emitted the existing engine warning, and TSX emitted the existing `module.register()` deprecation warning. All required checks completed successfully.
