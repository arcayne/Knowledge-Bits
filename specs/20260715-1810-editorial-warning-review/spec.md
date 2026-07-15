# Editorial QA Warning Review

## Objective

Keep valid editorial QA findings attached to the package and continue the Nuglet to human review instead of opening a blind content revision.

## Decision

A parseable editorial QA response is evidence, not a pipeline failure. Blocking editorial findings become review warnings. The pipeline continues through asset production and then requests one overall human decision.

The human may approve the package despite the warning or request changes with a comment.

## Non-goals

- Do not weaken deterministic schema, checksum, citation, or artifact checks.
- Do not convert provider authentication, configuration, malformed responses, or unavailable providers into review warnings.
- Do not change delivery or publication behavior.
- Do not mutate the paused Personal Finance run as part of implementation.

## Required behavior

1. The editorial provider persists raw response, parsed QA, execution report, and prompt provenance even when editorial findings are blocking.
2. A parseable editorial response completes `check` and queues `produce_assets`.
3. The review package separates hard assembly issues from editorial warnings.
4. Blocking editorial findings appear as explicit warnings in the review UI.
5. Editorial warnings do not disable Approve or Request changes when every hard package gate passes.
6. Deterministic QA failure remains a quality failure under the existing bounded revision policy.
7. Provider/configuration and malformed editorial responses keep their existing retry or intervention behavior.

## Verification

- Provider test proves blocking findings return a successful execution with persisted QA.
- State/API test proves successful check queues asset production.
- Review service test proves editorial warnings are visible while the package remains decision-ready.
- Browser/page test proves the warning is visibly rendered near the overall decision.
- Worker, pipeline, API, contracts, and review test suites pass.

