# Task 9a Report

## Status

Complete.

## Delivered

- Added strict request and response contracts for legacy revision preparation.
  The request requires an optimistic revision and checksum fence, a non-empty
  NotebookLM notebook ID, a strict Nuglet replacement brief, and an operator
  comment. The response returns the prepared run plus the previous revision and
  package checksum.
- Added `POST /runs/:id/prepare-legacy-revision`. It requires the existing
  review token and authenticated review principal. API credentials are rejected.
  Not found, validation, and conflict failures use the same route mappings as
  the other review operations.
- Added `prepareLegacyRevision` to the repository contract, Prisma store, and
  in-memory store. The Prisma implementation locks the run and performs all
  state changes in one transaction.
- The operation accepts only an unapproved `human_review` run whose current
  revision and checksum match the submitted fences, whose legacy brief is not
  already strict, and whose NotebookLM binding is unchanged.
- Success preserves immutable package versions, reviews, artifacts, and prior
  execution history. It increments the revision once, stores the strict brief,
  clears package approval state, resets every stage to queued with cleared
  reasons and zero revision attempts, supersedes queued or running old jobs,
  and queues one research job for the new revision.
- A durable workflow effect records the operator, comment, prior revision,
  prior checksum, and replacement brief checksum. The effect does not store the
  replacement brief or prompt content. Its key uses the run, expected revision,
  expected checksum, and canonical replacement-brief checksum. Exact replays
  return the prepared run; changed comments or stale fences conflict.
- No database migration was added or changed.

## Tests

Tests were written before the implementation. The initial contract test failed
because the new schemas did not exist. The initial repository and route tests
failed because the preparation method and route did not exist.

Focused coverage now includes:

- Contract validation for strict Nuglet plan and notebook bindings.
- Review-principal authorization, API-token rejection, replay, stale conflicts,
  and request validation at the route.
- In-memory success, unchanged-state guard failures, superseded leased jobs,
  stage reset, one research job, preserved immutable package access, and replay
  identity.
- Prisma success against the local OrbStack Docker engine. It proves that the
  old package version remains queryable, the notebook binding is unchanged, old
  jobs are superseded with leases and deadlines cleared, exactly one research
  job exists, no human-review worker job exists, and the audit effect contains
  no prompt body.

## Verification

All commands used Node `24.18.0`.

```text
pnpm --filter @knowledge-bits/contracts build
pnpm --filter @knowledge-bits/contracts test
pnpm --filter @knowledge-bits/api exec tsx --test \
  src/repositories/workflow-repository.test.ts \
  src/repositories/workflow-repository.integration.test.ts \
  src/routes/reviews.test.ts
pnpm --filter @knowledge-bits/contracts typecheck
pnpm --filter @knowledge-bits/api typecheck
git diff --check
```

Results: 30 contract tests passed. 45 focused API tests passed, including the
OrbStack-backed Prisma integration path. Both affected typechecks and the diff
check passed.

## Repair Verification

All repair verification commands used Node `24.18.0`.

```text
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" node --version
```

Result: `v24.18.0`.

```text
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @knowledge-bits/api exec tsx --test src/repositories/workflow-repository.test.ts
```

Result: exit 0. 34 tests passed, 0 failed.

```text
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @knowledge-bits/api exec tsx --test src/repositories/workflow-repository.integration.test.ts
```

Result: exit 0. 4 tests passed, 0 failed, including the OrbStack-backed Prisma
legacy revision test.

```text
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @knowledge-bits/api typecheck
```

Result: exit 0.

```text
git diff --check
```

Result: exit 0 with no output.
