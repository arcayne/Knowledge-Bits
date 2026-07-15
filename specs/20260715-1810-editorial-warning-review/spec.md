# Story Playbook Editorial QA Warning Review

## Objective

Keep valid editorial QA findings attached to the current Story/Playbook 1.1.0 package and continue it to human review instead of opening a blind content revision.

## Decision

A parseable editorial QA response is advisory evidence only for the current Story/Playbook 1.1.0 pipeline with a validated generation plan and resolved recipes. Blocking editorial findings become review warnings. That pipeline continues through asset production and then requests one overall human decision.

The human may approve the package despite the warning or request changes with a comment.

Legacy Pi checks retain their existing blocking behavior. A legacy candidate has no 1.1.0 generation plan, so it cannot produce media and must not be advanced into that path by this policy.

## Non-goals

- Do not weaken deterministic schema, checksum, citation, or artifact checks.
- Do not convert provider authentication, configuration, malformed responses, or unavailable providers into review warnings.
- Do not add legacy media support or alter legacy output contracts.
- Do not change delivery or publication behavior.
- Do not mutate the paused Personal Finance run as part of implementation.

## Required behavior

1. A Story/Playbook 1.1.0 editorial provider persists raw response, parsed QA, execution report, and prompt provenance even when editorial findings are blocking.
2. A parseable Story/Playbook 1.1.0 editorial response completes `check` and reaches the real media eligibility gate.
3. A blocking legacy Pi response remains a quality failure before asset production; legacy media generation remains unavailable without a 1.1.0 plan.
4. Empty or whitespace-only editorial summaries are malformed at both parser and QA contract boundaries.
5. The review package separates hard assembly issues from editorial warnings, including fallback responses after an independent media, provenance, or assembly failure.
6. Blocking editorial findings appear as explicit warnings in the review UI and do not disable Approve or Request changes when every hard package gate passes.
7. Long warnings in the fixed decision area use bounded scrolling and leave safe document space below the review content.
8. Deterministic QA failure remains a quality failure under the existing bounded revision policy.
9. Provider/configuration and malformed editorial responses keep their existing retry or intervention behavior.

## Verification

- Provider tests prove Story/Playbook blocking findings return a successful execution with persisted QA, while legacy Pi findings retain the quality block.
- Runtime tests prove Story/Playbook warning-bearing QA reaches the real media adapter and legacy contexts cannot invoke media generation.
- Parser and contract tests reject empty and whitespace-only editorial summaries.
- Review service tests prove warnings remain visible while the package remains decision-ready and when an independent media assembly failure blocks decisions.
- A mobile Playwright test proves long warnings scroll within a bounded decision area without covering decision controls.
- Worker, pipeline, API, contracts, and review test suites pass.
