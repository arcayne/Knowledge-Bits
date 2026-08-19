# Run notes

## Implementation

- Added `NotebookLmNotebookProvisioner` with list-before-create behavior.
- Added `NOTEBOOKLM_COMMAND` configuration. The default command is `nlm`.
- Added worker preparation before Joan `collect_sources` execution.
- Added lease-scoped `POST /jobs/:id/notebook` binding.
- Added run and research-job persistence with NotebookLM ID uniqueness checks.

## Validation

- Contracts build and tests passed: 45 tests.
- Worker typecheck passed.
- Worker executor tests passed: 34 tests.
- NotebookLM provisioning tests passed: 5 tests.
- API jobs route tests passed: 12 tests.
- `git diff --check` passed.
- API typecheck is blocked by the existing generated Prisma client mismatch in the local checkout.

## Remaining boundary

Run the first YouTube use case with the PostgreSQL-backed API and authenticated worker. The next
implementation slice is Joan-specific research capture and source synchronization.
