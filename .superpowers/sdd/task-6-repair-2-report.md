# Task 6 Repair 2 Report

## Status

DONE

## Repairs

- Nuglet validates the descriptor's repository-relative run folder, run ID, and NotebookLM notebook ID against the source folder and manifest before shadow serialization.
- Knowledge Bits requires the media baseline run and notebook identities to match the enclosing brief.
- Brief and Discussion use only `audio/notebooklm-short-brief.m4a` and `audio/notebooklm-medium-debate.m4a`.
- Both contracts reject shared audio paths, provider artifact IDs, and final-byte checksums. The worker also rejects identical returned audio bytes.
- Nuglet validates the manifest notebook identity before reading baseline media.
- PNG metadata probing requires the full 13-byte IHDR data, valid PNG field combinations, and a matching IHDR CRC.
- Existing provenance pairs, four media kinds, hero behavior, no-fallback behavior, and the Task 7 boundary remain unchanged.

## TDD Evidence

The new tests failed first for all three reviewed gaps: source identity drift, Discussion mapped to Brief, and a truncated 24-byte PNG header. After the implementation changes, the same focused suites passed.

## Verification

- `pnpm --filter @knowledge-bits/contracts test`: 27 passed.
- `pnpm --filter @knowledge-bits/worker exec tsx --test src/providers/media.test.ts src/providers/notebooklm.test.ts src/runtime.test.ts`: 34 passed.
- `pnpm test`: 262 passed, 4 skipped by existing Docker guards.
- `pnpm build`: 5 of 5 workspace builds passed.
- `pnpm typecheck`: 5 of 5 workspace typechecks passed.
- `pnpm scan:forbidden-credentials`: passed for 148 tracked files.
- `node --test apps/nuglet-lab/test/knowledge-bits-media-command.test.mjs`: 12 passed.
- `node --test apps/nuglet-lab/test/knowledge-bits-shadow-run.test.mjs`: 4 passed.
- `pnpm --filter @nuglet/nuglet-lab test`: 171 passed.
- `pnpm --filter @nuglet/nuglet-lab typecheck`: passed.
- `pnpm --filter @nuglet/nuglet-lab recipes:validate -- --base-ref b05e2a6`: 8 recipes passed.
- `pnpm test:repo-scripts`: 42 passed.
- `pnpm ci:secrets`: passed.
- `git diff --check`: passed in both worktrees.

## Changed Files

Knowledge Bits:

- `packages/contracts/src/knowledge-bits.ts`
- `packages/contracts/test/contracts.test.mjs`
- `apps/worker/src/providers/media.ts`
- `apps/worker/src/providers/media.test.ts`
- `apps/worker/src/providers/notebooklm.test.ts`
- `apps/worker/src/runtime.test.ts`
- `.superpowers/sdd/task-6-report.md`
- `.superpowers/sdd/task-6-repair-2-report.md`

Nuglet:

- `apps/nuglet-lab/src/scripts/knowledge-bits-shadow-run.ts`
- `apps/nuglet-lab/test/knowledge-bits-shadow-run.test.mjs`
- `apps/nuglet-lab/scripts/knowledge-bits-media-command.mjs`
- `apps/nuglet-lab/test/knowledge-bits-media-command.test.mjs`

## Concerns

- Node `v26.5.0` was active while both repositories declare `>=24 <25`.
- Docker was unavailable, so three Knowledge Bits migration tests and one end-to-end test used their existing skip paths.
- Live Vertex image generation and transcription were not run. Provider boundaries were exercised with injected test implementations.
- The repository-required `/humanizer` skill was unavailable, so both reports were checked manually against the documented writing standard.
