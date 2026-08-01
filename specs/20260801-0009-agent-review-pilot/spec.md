# Knowledge Bits independent-review pilot

Status: approved by the attached Days 1–5 implementation brief  
Date: 2026-08-01  
Task fit: broad ticket  
Risk tier: Orange (repository-wide delivery policy and CI configuration)

## Objective

Turn the current agent-build/human-merge flow into a small, auditable pilot in which Knowledge Bits changes have an explicit risk classification, fresh-context reviewer evidence, and independently reproduced CI evidence before merge.

## Scope

1. Add a concise system map for the Knowledge Bits API, worker, review app, artifact storage, and the Nuglet delivery boundary.
2. Baseline the 20 most recent merged pull requests available before PR #51 (#31–#50) using the exact CSV schema and value rules below. Preserve unknowns instead of converting elapsed PR time or deployment statuses into human-review evidence.
3. Add a risk map with Red, Orange, Yellow, and Green classifications and explicit approval expectations.
4. Document the first 10-PR advisory reviewer-agent pilot, its required output, and the PR #51 questions from the brief.
5. Perform a fresh-context independent review of PR #51 at pinned head `5b2e7a932b7f6eda9e1735ed06bb7bba329e07a2`, preserve the evidence and verdict in a SHA-named artifact, and post the verdict only if the live PR head is still identical.
6. Restore independently reproduced CI for future pull-request and `main` commits. The repository's existing `Quality` workflow already contains the required install, typecheck, test, and build commands, but GitHub currently reports it as manually disabled. Validate the workflow contract locally and enable it remotely. Enabling is not retroactive and must not be described as exact-head Actions evidence for PR #51.
7. Recheck required-check capabilities read-only. GitHub has already rejected both branch-protection and ruleset reads with an HTTP 403 plan limitation, so do not attempt a blind enforcement write. Record the exact blocker and leave enforcement explicitly not active.

## Non-goals

- No Knowledge Bits runtime, database, workflow, provider, media, or delivery behavior changes.
- No changes to PR #51's implementation.
- No Nuglet repository audit or compatibility implementation.
- No mandatory reviewer-agent GitHub rule during the first 10 PRs.
- No large metrics dashboard or targeted CI optimization.
- No claim that a Vercel status proves a preview was inspected.

## Current-state evidence

- Current `origin/main` is commit `d830986` (merged PR #50).
- `.github/workflows/quality.yml` exists and declares install, credential scan, build, test, and typecheck steps.
- GitHub reports workflow `Quality` (`312160979`) as `disabled_manually`; its recorded runs are cancelled.
- PR #51 is open at commit `5b2e7a9`, changes 42 files, has no reviews, and exposes only Vercel status/check contexts.
- GitHub's branch-protection and ruleset APIs return HTTP 403 for this private repository with a plan-upgrade requirement.
- The user's active checkout contains unrelated changes and is 53 commits behind; implementation is isolated on `codex/agent-review-pilot` from current `origin/main`.

## Architecture and contract decisions

- Knowledge Bits owns run state, worker leases, evidence, artifacts, package checksums, review decisions, and delivery history.
- The local worker owns provider execution and artifact production but does not receive Nuglet production credentials.
- The review app authenticates human decisions and calls the API; it does not own workflow state.
- R2 is treated as an engine-owned artifact boundary under the current README and runtime. `docs/V1_DESIGN.md` still says Nuglet supplies a scoped storage adapter; the system map must expose this documentation drift instead of silently choosing one statement.
- Nuglet is represented only as the downstream import/publish boundary described by the current Knowledge Bits runtime. Its internal architecture and capability support remain unverified in this run. Older design language that describes import-only behavior must be marked as stale or unresolved.
- Risk classification is based on the highest-risk boundary touched by a change.
- Historical `accepted` requires independent evidence of a working preview/production acceptance scenario and no same-defect corrective PR within 48 hours. Because that evidence is absent for #31–#50, every historical value remains `unknown`; inferred corrective relationships do not change it automatically.
- A CI status is independent evidence only when GitHub Actions runs the repository workflow against the exact PR commit.

## Historical CSV contract

The header is exactly:

```text
date,repository,pr,change_area,risk_tier,builder_agent,reviewer_agent,automated_checks,preview_verified,human_minutes,merged,accepted,corrective_pr_within_48h,failure_category,notes
```

Value rules:

- `date`: merge date in `YYYY-MM-DD`.
- `repository`: `arcayne/Knowledge-Bits`.
- `pr`: `#31` through `#50`, once each.
- `change_area`: one of `local_runtime`, `intake_and_similarity`, `review_routing`, `shorts_prompt_and_rendering`, `infographic_pipeline`, `artifact_regeneration`, `review_auth`, `review_dashboard`, `review_artifacts`, or `delivery_contract`.
- `risk_tier`: `Green`, `Yellow`, `Orange`, or `Red`, using the highest touched boundary.
- `builder_agent`: `unrecorded_codex_branch` because the branch names are evidence of a Codex convention, not proof of which agent/model built them.
- `reviewer_agent`: `none_recorded` when GitHub has zero submitted reviews; otherwise `github:<login>` for a submitted GitHub review or `agent:<recorded-id>` for a repository-recorded reviewer artifact, joined with `+` in submission order when multiple values exist.
- `automated_checks`: `vercel_status_only_no_actions` for this sample; builder-reported local commands remain in `notes` and are not promoted to independent checks.
- `preview_verified`: `unknown` unless a human inspection record exists; a Vercel success context is insufficient.
- `human_minutes`: `unknown`; open-to-merge elapsed seconds belong in `notes` only.
- `merged`: `true` for the sampled merged PRs.
- `accepted`: `unknown` for this historical sample because independent acceptance evidence is unavailable.
- `corrective_pr_within_48h`: `inferred_yes`, `no_observed_in_sample`, or `unknown`. `inferred_yes` must name the follow-up PR in `notes`.
- `failure_category`: `Specification`, `Model`, `Environment`, `Tooling`, `Architecture`, `Review`, or `none_observed`; this describes the signal represented by the PR/follow-up, not a confirmed incident root cause.
- `notes`: semicolon-delimited evidence, including exact open-to-merge seconds and any inference caveat; no commas.

## Risk-tier mapping

Use the highest tier touched by the diff:

- `Red`: production database migrations or migration-owner credentials; approval/package-checksum logic; Nuglet delivery/publication or its token; destructive run/artifact operations.
- `Orange`: worker permissions; external source ingestion; NotebookLM/Vertex/writer/provider configuration; R2 writes or signed URLs; OIDC/CSRF; recipe or content-contract versions; workflow leasing/idempotency; Knowledge Bits↔Nuglet delivery contracts.
- `Yellow`: normal API behavior; review UI; media generation; prompts/recipes that do not version a contract; read-only dashboards.
- `Green`: documentation; tests; internal refactors; copy; isolated styling.

## Reviewer pilot state machine

- Scope: PR #51 is the pilot sample; the next 10 PRs use the process as an advisory reviewer-agent gate, not a GitHub-required reviewer rule.
- Every review is bound to one exact head SHA. A new commit makes the verdict stale and returns the PR to `pending_review`.
- `Green`: automated checks plus fresh-context agent review; human merges.
- `Yellow`: fresh-context agent review; blocking findings must be fixed or explicitly accepted by a human.
- `Orange`: fresh-context agent review plus a named human domain decision is mandatory.
- `Red`: fresh-context agent review plus explicit named human approval is mandatory before merge or production action.
- Reviewer verdicts are `approve`, `comment`, or `request_changes`. A builder's validation summary never satisfies independent evidence.
- For the PR #51 artifact and comment, return exactly: `Risk tier`, `Acceptance scenarios checked`, `Independent evidence`, `Blocking findings`, `Non-blocking findings`, `Unproven assumptions`, and `Verdict`.
- Explicitly answer for PR #51: PDF evidence reachability; source-text instruction influence; maximum total writer context; missing writer credentials; delivery before Nuglet V2 support; and whether a real review preview deployed.

## Safety and integrity constraints

- Preserve the dirty active checkout and all unrelated user changes.
- Do not expose credentials or inspect secret values.
- Do not approve, merge, deliver, publish, migrate, or delete production data.
- Do not present branch protection as active unless the authoritative GitHub API confirms it.
- Do not present PR #51 as preview-verified merely because Vercel emitted success contexts.
- Keep builder claims, reviewer evidence, and human decisions distinct.
- Immediately before posting, read the live PR #51 head again and record that SHA plus the UTC check timestamp in the review artifact. Do not post if it differs from the reviewed SHA; preserve the artifact only as stale historical evidence and run a new review.

## Failure modes and handling

- Historical PR metadata is incomplete: use `unknown` and explain the proxy or absence in `notes`.
- Corrective relationships are inferred from titles/descriptions: label them as inferred, not incident-confirmed.
- Full PR #51 checks fail due to the PR itself or the environment: record exact commands, failures, Node version, and limits without altering the PR.
- GitHub Actions can be enabled but cannot be required: record enforcement as blocked and give the minimum account/repository next action. Do not call the PR independently verified by Actions until a successful exact-head run exists.
- The existing workflow is already sufficient: avoid a duplicate workflow; add only a regression contract if needed to prevent removal of the required commands.

## Acceptance criteria

- `docs/engineering/system-map.md` identifies ownership, calls, credentials, and production-write boundaries and stays concise.
- `docs/engineering/pr-baseline.csv` contains exactly 20 historical rows (#31–#50) plus the exact requested header and follows all value rules above.
- `docs/engineering/risk-map.md` contains all tiers and the Red/Orange approval guardrail.
- `docs/engineering/independent-review.md` defines the advisory 10-PR flow, reviewer prompt/output, evidence standard, PR #51 questions, and first metrics.
- A SHA-named PR #51 review artifact records the exact reviewed base/head, risk tier, scenarios, independent evidence, findings, assumptions, and verdict; any posted comment matches that artifact and is skipped if the head changed.
- A repository test asserts that the CI workflow triggers for PRs and main and includes frozen install, typecheck, test, and build.
- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and `pnpm build` are run in the isolated worktree and results are recorded.
- GitHub Actions workflow state is verified as `active` after the enable attempt. A successful exact-head Actions run is explicitly a known gap until a future PR event triggers one.
- Branch-protection status is verified read-only through GitHub, with the exact plan blocker and no enforcement-write attempt while capability reads fail.

## Verification plan

1. Parse the CSV and assert the header, 20 data rows, unique sequential PR numbers #31–#50, and allowed enumerated values.
2. Run the repository deployment-contract tests, including the new CI workflow contract.
3. Run the four required root commands on Node 24/pnpm 9.12.0.
4. Inspect `git diff --check`, the complete diff, and repository status.
5. Compare PR #51 reviewer claims with the exact head commit and independently produced command output.
6. Query GitHub workflow state after enablement and recheck branch-protection/ruleset capabilities read-only.

## Implementation checklist

- [ ] Add system map.
- [ ] Add 20-PR baseline.
- [ ] Add risk map.
- [ ] Add independent review/pilot guide and metrics.
- [ ] Add PR #51 independent review evidence.
- [ ] Add CI workflow regression contract without duplicating the workflow.
- [ ] Enable the existing Quality workflow.
- [ ] Recheck required-check capability read-only and record the blocker; do not attempt a blind write.
- [ ] Run validation and record closeout.

## QA checklist

- [ ] No unrelated runtime code changes.
- [ ] No unsupported current-state claims.
- [ ] No inferred corrective PR labeled as confirmed.
- [ ] No elapsed-time proxy labeled as human minutes.
- [ ] No deployment status labeled as preview verification.
- [ ] Risk tiers match the highest boundary touched.
- [ ] Reviewer output separates defects, risks, and assumptions.
- [ ] CI commands are machine-checked against the workflow.
- [ ] External enforcement state is stated honestly.

## Open questions

- GitHub required-check enforcement is technically blocked unless the repository becomes public or the account gains a plan that supports private-repository branch rules. This is not a blocker to the advisory pilot or to enabling CI.
