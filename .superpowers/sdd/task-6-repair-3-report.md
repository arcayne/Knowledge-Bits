# Task 6 Repair 3 Report

## Result

DONE

The remaining Knowledge Bits consumer-side trust-boundary finding is repaired. Strict Nuglet run brief validation now runs at live API intake and again before worker execution. Request-level and worker job-level NotebookLM notebook IDs cannot override or disagree with the validated brief identity.

## Scope

- Added a Knowledge Bits run request schema that composes the generic request shape with `knowledgeBitsRunBriefSchema` only when the brief targets `nuglet.lesson.v1`.
- Switched `POST /runs` to the composed schema.
- Compared an explicit request-level NotebookLM notebook ID with the validated brief before run bootstrap.
- Revalidated the complete brief and job-level NotebookLM notebook ID before worker recipe verification, dependency reads, NotebookLM, editorial, or media work.
- Preserved generic handling for other target kinds and historical briefs.
- Left Task 6 media behavior unchanged and added no Task 7 review assembly or UI.
- Did not edit Nuglet.

## TDD Evidence

### Red

```bash
pnpm --filter @knowledge-bits/contracts build && pnpm --filter @knowledge-bits/contracts test
```

Failed because `knowledgeBitsCreateRunRequestSchema` did not exist or export yet.

```bash
pnpm --filter @knowledge-bits/contracts build >/dev/null 2>&1; pnpm --filter @knowledge-bits/api exec tsx --test src/routes/runs.notebooklm.test.ts
```

Failed with 2 passed and 1 failed. The mismatched descriptor run ID was accepted with `201` instead of rejected with `400`.

```bash
pnpm --filter @knowledge-bits/worker exec tsx --test src/runtime.test.ts
```

Failed with 13 passed and 1 failed. The mismatched run brief reached the NotebookLM process instead of returning `run_brief_invalid`.

### Repair Cycle

The first worker green attempt exposed a missing local test helper. The next run passed 10 and failed 4 because three direct `LeaseScopedJobContextResolver` paths had not yet received the run-level notebook identity. Those paths were wired to the same validator. Initial API and worker typechecks then identified test-only implicit and literal types, which were corrected without changing production behavior.

### Focused Green

```bash
pnpm --filter @knowledge-bits/contracts build && pnpm --filter @knowledge-bits/contracts test
```

Passed: 28 tests.

```bash
pnpm --filter @knowledge-bits/contracts build >/dev/null 2>&1 && pnpm --filter @knowledge-bits/api exec tsx --test src/routes/runs.notebooklm.test.ts && pnpm --filter @knowledge-bits/api typecheck
```

Passed: 3 route tests and API typecheck.

```bash
pnpm --filter @knowledge-bits/contracts build >/dev/null 2>&1 && pnpm --filter @knowledge-bits/worker exec tsx --test src/runtime.test.ts && pnpm --filter @knowledge-bits/worker typecheck
```

Passed: 14 runtime tests and worker typecheck.

## Broader Verification

```bash
pnpm --filter @knowledge-bits/contracts test
```

Passed: 28 tests.

```bash
pnpm --filter @knowledge-bits/api test
```

Passed: 91 tests. Three existing Docker-guarded migration tests skipped.

```bash
pnpm --filter @knowledge-bits/worker test
```

Passed: 96 tests.

```bash
pnpm build
```

Passed: 5 of 5 workspace builds.

```bash
pnpm typecheck
```

Passed: 5 of 5 workspace typechecks.

```bash
pnpm test
```

Passed: 265 tests. Four existing Docker-guarded tests skipped, including the end-to-end test.

```bash
pnpm scan:forbidden-credentials
```

Passed for 149 tracked files.

```bash
git diff --check
```

Passed with no whitespace errors.

## Changed Files

- `.superpowers/sdd/task-6-report.md`
- `.superpowers/sdd/task-6-repair-3-report.md`
- `packages/contracts/src/knowledge-bits.ts`
- `packages/contracts/test/contracts.test.mjs`
- `apps/api/src/routes/runs.ts`
- `apps/api/src/routes/runs.notebooklm.test.ts`
- `apps/worker/src/runtime.ts`
- `apps/worker/src/runtime.test.ts`

## Concerns

- Verification ran on Node `v26.5.0`, while the workspace declares `>=24 <25`. The existing engine and TSX deprecation warnings remain.
- Docker was unavailable, so three API migration tests and one end-to-end test used their existing skip paths.
- No live NotebookLM, Vertex, or media command execution was needed for this consumer-side validation repair.
