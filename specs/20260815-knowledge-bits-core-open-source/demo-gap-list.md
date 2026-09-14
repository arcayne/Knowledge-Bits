# Clean-clone local-demo gap list

Date: 2026-09-14
Status: implementation added; Docker-backed runtime proof remains pending

## Existing verified pieces

- The repository has six workflow stages: `research`, `create`, `check`, `produce_assets`, `human_review`, and `deliver`.
- Fixture provider code exists at `apps/worker/src/providers/fixture.ts`.
- Fixture destination and filesystem-style test adapters exist in the API test surface.
- `test/e2e/review-flow.test.mjs` exercises PostgreSQL, fixture providers, worker lease interruption and reclaim, review authentication, checksum-bound approval, delivery verification, and idempotency.
- The review application is started by the end-to-end test and exposes the review page and review mutation path.
- The CI workflow installs dependencies, generates Prisma output, builds, runs tests, typechecks, and runs the repository credential scanner.
- The end-to-end proof starts a temporary PostgreSQL 16-compatible container and applies Prisma migrations.

These pieces are test infrastructure. They are not yet a contributor-facing local workflow.

## Gaps for the readiness-plan demo

| Gap | Evidence | Required change |
| --- | --- | --- |
| No `compose.yaml` | No compose file exists at repository root. | Add a PostgreSQL 16 local service bound to localhost with documented lifecycle commands. |
| No portable demo environment file | `.env.example` is production-oriented and includes Nuglet endpoints, R2, provider paths, and production mode defaults. | Add a demo-specific environment template with local-only values and fixture mode enabled. Keep production configuration separate. |
| Filesystem artifact mode is unavailable at runtime | `apps/api/src/services/r2-artifacts.ts` returns the unavailable adapter for every mode except `r2`, while local supervisor scripts select `filesystem`. | Implement a persistent local filesystem artifact adapter or choose another explicitly local supported mode. Do not route the demo through R2. |
| No durable local destination | `FixtureDeliveryAdapter` is an in-memory test class. Runtime delivery is HTTP-only and is omitted when `DELIVERY_ADAPTER_URL` is blank. | Add a local destination implementation that records a durable receipt and exposes a verification endpoint or equivalent local adapter. |
| No setup command | Root scripts contain build, test, Prisma generation, scanning, and release commands, but no demo setup or seed command. | Add idempotent setup/migration/seed commands or a single documented setup entrypoint. |
| No start/stop/reset command | The README documents deployed and supervisor flows. It does not provide one portable local API, worker, review, and database lifecycle. The existing launchd scripts are Mac-specific and production-oriented. | Add explicit start, stop, reset, and status commands. Bind demo services to `127.0.0.1`. |
| No contributor-facing fixture input package | Existing fixture data is distributed across `test/e2e`, `test/fixtures`, and provider fixtures. | Add one redistributable example with bundled source evidence and fixture outputs. Label simulated generation. |
| Fixture mode is not the default | `.env.example` sets `WORKER_PROVIDER_MODE="production"`; fixture mode is described only in test code and README. The worker credential example advertises only `collect_sources`, while the six-stage flow needs all automated-stage capabilities. | Make the demo path select fixture mode explicitly, grant all required fixture capabilities, and fail closed against paid providers. |
| Existing proof is test-driven, not operator-driven | `test/e2e/review-flow.test.mjs` creates processes and credentials internally. It proves lease reclaim, approval, delivery verification/retry/idempotency, and all six stages, but it does not start the normal API and worker entrypoints for a contributor. | Wrap the proven flow in contributor commands or a script that prints the review URL, approval action, delivery receipt, and package revision reapproval result. |
| Seed and review identity are not documented for local use | The review test injects a fixture identity. The current README describes external identity proxy configuration. The local bypass is allowed only when `NODE_ENV !== production` and `REVIEW_LOCAL_OPERATOR_ID` is set. | Configure a server-owned local reviewer identity only in demo mode and state that it is unavailable in production mode. |
| Restart persistence is only asserted inside the test | The test verifies lease reclaim and database persistence, but no README path tells a contributor how to restart and inspect the same run. | Add a restart demonstration and a check that the persisted run remains visible. |
| Package revision reapproval is not a documented demo step | The test covers stale approval and checksum-bound approval, but the current README does not show a revision requiring a second approval. | Add a deterministic demo action and assertion for changed package bytes, invalidated approval, and renewed approval. |
| CI depends on Docker and Node 24 | `.github/workflows/quality.yml` pulls PostgreSQL and the current shell reports Node 22 locally. | Document Node 24 and Docker as demo prerequisites. Keep CI validation separate from credentialed provider flows. |
| Existing documentation exposes production setup before local setup | `README.md` leads with Supabase, deployment values, Nuglet endpoints, and provider paths. | Rewrite the quickstart around the portable demo. Move optional integrations into separate documentation. |

## Implemented in the local-demo slice

- `compose.yaml` provides PostgreSQL 16 on loopback with a healthcheck and named volume.
- `.env.demo.example` selects fixture providers, local filesystem artifacts, local durable delivery, full worker capabilities, and a server-configured development reviewer.
- `scripts/local-demo.mjs` provides setup, seed, start, stop, reset, status, and demo commands with scoped state and process environment isolation.
- `examples/local-demo/` provides a checked-in fixture brief and source explanation.
- README quickstart documents the local workflow, explicit approval, receipt location, restart persistence, and revision/reapproval behavior.
- P1 lifecycle defects found by review were fixed: worker token configuration, receipt checksum selection, child environment isolation, and env-file ignore rules.

## Remaining blockers and follow-ups

1. Docker/OrbStack is unavailable in the current environment, so the complete clean-clone runtime flow is not yet executed here.
2. The local-demo process stop path records PIDs but does not verify process identity before signalling.
3. Local artifact payload and metadata files are installed in two filesystem operations; a crash between them can leave an unreadable orphan.
4. Cross-adapter artifact race and receipt fault-injection tests remain follow-up coverage.
5. The existing end-to-end proof remains Docker/test-driven; the operator workflow needs runtime verification from a clean clone.

## Proposed next slice

Implement only the local demo foundation:

1. Add `compose.yaml` for PostgreSQL 16 on localhost.
2. Implement persistent local filesystem artifact storage and a durable local destination receipt path.
3. Add a portable demo environment template and local-only defaults.
4. Add idempotent setup, seed, start, stop, reset, and status commands.
5. Add one bundled synthetic or rights-cleared Nuglet example with source evidence and fixture outputs.
6. Add an operator-facing demo script that starts the normal API, fixture worker, review app, and local destination, then prints a delivery receipt.
7. Add tests for setup idempotency, local-only provider selection, restart persistence, and revision reapproval.
8. Update the README quickstart only for the commands added in this slice; defer full documentation rewrite to milestone 3.

## Non-goals

- Do not publish the repository.
- Do not change repository visibility or publish a release from the demo slice. MIT metadata is maintained in the release-preparation slice.
- Do not rewrite Git history.
- Do not remove Nuglet integrations.
- Do not call NotebookLM, Vertex, media providers, external delivery endpoints, Supabase, or paid services from the demo path.
- Do not modify unrelated dirty-worktree files.
