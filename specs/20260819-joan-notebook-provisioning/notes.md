# Run notes

## Implementation

- Added `NotebookLmNotebookProvisioner` with list-before-create behavior.
- Added `NOTEBOOKLM_COMMAND` configuration. The default command is `nlm`.
- Added worker preparation before Joan `collect_sources` execution.
- Added `NotebookLmResearchSourceDiscoveryClient`. It obtains YouTube oEmbed title and author
  metadata, runs `nlm research start --source web`, polls `nlm research status`, and returns
  candidate URLs for deterministic verification.
- NotebookLM web-research output is discovery evidence only. The existing verifier controls which
  candidates are imported with `nlm source add`.
- Added lease-scoped `POST /jobs/:id/notebook` binding.
- Added run and research-job persistence with NotebookLM ID uniqueness checks.

## Validation

- Contracts build and tests passed: 45 tests.
- Worker typecheck passed.
- Worker executor tests passed: 34 tests.
- NotebookLM provisioning tests passed: 5 tests.
- NotebookLM research adapter and runtime tests passed: 88 tests in the combined selected suite.
- API jobs route tests passed: 12 tests.
- `git diff --check` passed.
- API typecheck is blocked by the existing generated Prisma client mismatch in the local checkout.

## Remaining boundary

Run the first YouTube use case with the PostgreSQL-backed API and authenticated worker. The next
validation slice is to execute Joan `collect_sources` end to end and confirm that verified
NotebookLM research candidates are attached to the bound notebook.
