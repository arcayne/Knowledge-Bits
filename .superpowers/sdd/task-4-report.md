# Task 4 Report

## Result

Implemented file-backed Nuglet recipe verification and immutable generation provenance without activating product-specific recipe semantics. The worker resolves trusted recipe bindings by canonical checksum, normalizes rendered prompt bytes, keeps execution evidence separate from learner media, sanitizes reports and provenance, and uploads the three versioned generation artifact kinds under the active worker lease when a provider returns them.

## Fourth Repair Follow-up

Resolved both Important findings from the final fresh review.

### Changes

- Support artifacts remain optional for all jobs. When recipe snapshots or rendered prompts are present, each recipe identity must match a binding in `brief.generationPlan.recipes`, regardless of content kind. Jobs with no claimed plan reject that evidence before upload.
- Generic and legacy jobs that omit support artifacts retain their existing success path.
- URL values are classified before safe URLs are shielded and restored. The worker redacts `file:` URLs, known environment secrets in URLs, credential-bearing query and fragment parameters, and URL userinfo.
- Path redaction now covers UNC paths and extended Windows paths, including quoted paths with spaces.

### Regression coverage

- Updated the generic support-artifact success fixture to declare a matching generic plan.
- Added explicit no-plan recipe and prompt evidence rejection.
- Added neutral-key `endpoint` coverage for environment secrets in URLs, query and fragment credentials, URL userinfo, `file:` URLs, UNC paths, and extended Windows paths.
- Preserved the Task 4 provider boundary: no Story, Playbook, Pi, or media recipe activation, provider semantic changes, or provider call-count changes.

### Verification

- Focused recipe, executor, runtime, provider, checks, and configuration tests: 72 passed.
- Full worker suite: 80 passed.
- Worker build: passed.
- API repository and artifact-route compatibility tests: 41 passed.
- Forbidden-credential scan: passed for 141 tracked files.
- Workspace typechecks: all 5 participating projects passed.
- `git diff --check`: passed.

### Concerns

- Tests ran on Node `v26.5.0`, while the workspace declares `>=24 <25`. Pnpm emitted the existing engine warning and TSX emitted the existing `module.register()` deprecation warning.

## Third Repair Follow-up

Corrected the Task 4 sequencing boundary after the final review. This section supersedes the provider-activation claims in the Second Repair Follow-up below.

### Boundary correction

- Task 4 keeps generic recipe resolution, prompt rendering, support-artifact builders and types, executor validation and upload, runtime configuration, and API authorization.
- NotebookLM continues to use the legacy research and Create prompts and parsers. It does not select Story or Playbook recipes in Task 4.
- Pi continues to use the legacy structured editorial request. It does not select the editorial QA recipe in Task 4.
- Media continues to make one bounded request for the existing `hero`, `infographic`, and `audio` kinds. It does not select media recipes or split work into per-kind calls in Task 4.
- Resolved recipes remain available through neutral runtime context for Tasks 5 and 6 to consume without redesign.
- `supportArtifacts` remains optional for current Nuglet jobs. When a provider returns generation recipe or prompt artifacts, the executor still requires complete immutable pairs, validates recipe and prompt bodies against checksums, binds recipe identity to the claimed plan, and applies executor-owned provenance.
- Quoted, backtick-wrapped, and angle-bracketed POSIX and Windows absolute paths containing spaces are redacted as complete values.

### Regression coverage

- Replaced premature Story, media, and Pi activation assertions with sequencing-boundary tests.
- Added compatibility coverage for omitted and empty support-artifact arrays on current Nuglet jobs.
- Kept generic support-artifact pairing, plan-binding, checksum, body, provenance, stage restriction, and API authorization coverage.
- Added path-redaction cases for quoted and angle-bracketed POSIX and Windows paths containing spaces.

### Verification

- Focused recipe, executor, runtime, and provider tests: 71 passed.
- Worker build: passed.
- Full worker suite: 79 passed.
- API repository and artifact-route compatibility tests: 41 passed.
- Forbidden-credential scan: passed for 141 tracked files.
- Workspace typechecks: all 5 participating projects passed.
- `git diff --check`: passed.

### Concerns

- Tests ran on Node `v26.5.0`, while the workspace declares `>=24 <25`. Pnpm emitted the existing engine warning and TSX emitted the existing `module.register()` deprecation warning.

## Second Repair Follow-up

Resolved both Important findings from `task-4-rereview.md`.

### Changes

- Nuglet-plan jobs now fail closed when support artifacts are omitted or empty. Generic jobs without a recipe plan keep the existing optional support-artifact behavior.
- Runtime recipe resolution now carries the trusted canonical bytes into provider context instead of reducing resolution to a boolean check.
- NotebookLM sends the trusted Story recipe bytes in its exact rendered request prompt. A structured-output repair records a separate immutable recipe and prompt pair for the repair prompt.
- Pi sends the trusted editorial recipe and exact review context through the rendered prompt used by the local SDK adapter.
- Media sends one recipe-bound prompt per current media request. Hero, infographic, and audio requests use distinct idempotency keys and emit one immutable recipe and prompt pair each.
- The executor accepts multiple material recipe and prompt pairs, requires exactly one snapshot and one prompt in each pair, verifies both bodies, and rejects recipe identities that are not bound to the claimed Nuglet plan.
- The executor remains the sole writer of the sanitized `generation.execution.report` artifact.
- Report redaction now parses absolute URLs and removes any URL carrying username or password userinfo. Absolute local paths are removed when wrapped in backticks or angle brackets, without relying on a narrow punctuation prefix list.

### Files changed

- `apps/worker/src/checks/checks.test.ts`
- `apps/worker/src/executor.ts`
- `apps/worker/src/executor.test.ts`
- `apps/worker/src/providers/media.ts`
- `apps/worker/src/providers/notebooklm.ts`
- `apps/worker/src/providers/notebooklm.test.ts`
- `apps/worker/src/providers/pi.ts`
- `apps/worker/src/providers/pi.test.ts`
- `apps/worker/src/recipes/file-registry.ts`
- `apps/worker/src/recipes/support-artifacts.ts`
- `apps/worker/src/recipes/types.ts`
- `apps/worker/src/runtime.ts`
- `apps/worker/src/runtime.test.ts`

### Test-driven evidence

- Before the implementation changes, `pnpm --filter @knowledge-bits/worker exec tsx --test src/executor.test.ts src/providers/notebooklm.test.ts src/providers/pi.test.ts src/checks/checks.test.ts` reported 42 passed and 7 failed. The failures were the omitted and empty support-artifact bypass, all three real provider provenance paths, and the two redaction cases.
- Before plan-binding validation was added, `pnpm --filter @knowledge-bits/worker exec tsx --test src/executor.test.ts` reported 28 passed and 1 failed because valid artifact bytes from an unbound recipe were accepted.

### Verification

- `pnpm --filter @knowledge-bits/worker exec tsx --test src/recipes/file-registry.test.ts src/executor.test.ts src/runtime.test.ts src/providers/notebooklm.test.ts src/providers/pi.test.ts src/checks/checks.test.ts`: 70 passed.
- `pnpm --filter @knowledge-bits/worker test`: 80 passed.
- `pnpm --filter @knowledge-bits/api exec tsx --test src/repositories/workflow-repository.test.ts src/routes/artifacts.test.ts`: 41 passed.
- `pnpm scan:forbidden-credentials`: passed for 141 tracked files.
- `pnpm -r typecheck`: all 5 workspace projects passed.

### Concerns

- The available runtime is Node `v26.5.0`, while the workspace declares `>=24 <25`. Pnpm emitted the existing engine warning and TSX emitted the existing `module.register()` deprecation warning. The tests and typechecks above completed successfully.

## Repair Follow-up

Addressed every Important finding from `task-4-review.md`.

### Files changed

- `apps/worker/src/recipes/file-registry.ts`
- `apps/worker/src/recipes/file-registry.test.ts`
- `apps/worker/src/executor.ts`
- `apps/worker/src/executor.test.ts`

### Repairs

- Prompt rendering now normalizes CRLF and removes trailing horizontal whitespace and terminal separator-only blank lines without stripping leading indentation.
- Generation support artifacts now require one recipe snapshot and one rendered prompt, complete and consistent recipe, prompt, model, and reference-checksum provenance, and checksums that match the immutable artifact bodies. Invalid provenance is rejected before artifact upload and recorded as a configuration need.
- The executor binds action, idempotency key, job ID, provider, and attempt after sanitizing provider provenance. Provider values cannot override those fields.
- Redaction now removes broader credential field names and literals, explicit local path fields such as `cwd`, `loadedFrom`, and `filename`, and general absolute paths embedded in report strings, including `/srv`, `/opt`, `/workspace`, and `/mnt` paths.

### Repair verification

- `pnpm --filter @knowledge-bits/worker exec tsx --test src/recipes/file-registry.test.ts src/executor.test.ts`: 29 passed.
- `pnpm --filter @knowledge-bits/worker test`: 71 passed.
- `pnpm --filter @knowledge-bits/api exec tsx --test src/repositories/workflow-repository.test.ts src/routes/artifacts.test.ts`: 41 passed.
- `pnpm --filter @knowledge-bits/worker typecheck`: passed.
- `pnpm -r typecheck`: all 5 workspace projects passed.
- `git diff --check`: passed.

### Concerns

- The local runtime is Node `v26.5.0`; the workspace declares `>=24 <25`, so pnpm emitted an engine warning and TSX emitted a Node deprecation warning. All requested tests and typechecks passed under the available runtime.

## Changes

- Added `FileRecipeRegistry` as the concrete Task 3 recipe binding verifier.
- Recomputed canonical JSON bytes at resolution time and rejected manifest or run checksum mismatches.
- Confined recipe paths to their configured content-kind root and omitted local roots from resolved values.
- Added deterministic prompt-section rendering with UTF-8 bytes, LF line endings, stable section order, and no trailing whitespace.
- Added `PRODUCT_RECIPE_ROOTS` parsing as worker-only startup configuration.
- Added a distinct `ProviderSupportArtifact` flow for recipe snapshots, rendered prompts, and execution reports.
- Preserved learner media restrictions: product assets remain limited to `produce_assets`, with source snapshots allowed during `research`.
- Replaced new `execution_report` writes with `generation.execution.report` while retaining API authorization for legacy `execution_report` artifacts.
- Added recipe, prompt, provider, model, attempt, and reference checksum provenance to generation artifacts.
- Removed credential fields, environment secret values, and local filesystem paths from execution report bodies and artifact provenance.

### API repository and route support

The API repository and route changes are required support-artifact allowlist work. The worker cannot persist immutable recipe snapshots, normalized prompts, or sanitized execution reports unless the active-lease authorization path accepts their artifact kinds. The Prisma repository path and raw SQL fallback now allow `generation.recipe.snapshot`, `generation.prompt.rendered`, and `generation.execution.report` for automated stages, and the artifact routes test that authorization explicitly. Legacy `execution_report` remains allowlisted so existing runs stay readable and compatible. These changes do not make support artifacts learner-facing and do not relax product-asset stage restrictions.

## Verification

- Focused worker tests: 26 passed.
- Worker suite: 66 passed.
- Artifact route tests: 10 passed.
- Full repository suite: all runnable tests passed, including 90 API tests.
- Full repository typecheck: all 5 packages passed.
- Real Nuglet registry probe: all 8 recipe bindings verified against the current recipe files.
- `git diff --check`: passed.

## Environmental limitation

- Three API database integration tests and one end-to-end test were skipped because Docker was unavailable to this process. Their migration and static contract coverage still ran, and the non-Docker artifact authorization route suite passed.

## Compatibility

- Existing `execution_report` artifacts remain authorized and readable.
- New executions write `generation.execution.report`.
- Generic non-Nuglet briefs still run without a recipe registry. Nuglet `1.1.0` plans fail closed when the configured registry is absent or any binding does not match.
