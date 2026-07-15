# Notes

The existing failure discarded the parseable editorial response before artifacts were uploaded. This made the next revision blind and prevented a human from judging the candidate.

The approved policy preserves hard machine gates while treating editorial judgment as advisory evidence for the final human decision.

## Implementation evidence

Blocking editorial findings now remain in the successful QA artifact for both legacy and Story/Playbook Pi checks. The worker keeps raw response bytes, parsed QA, the execution report, and Story/Playbook prompt provenance before reporting the check complete.

Media eligibility now requires only a passing deterministic check with the current semantic content checksum. Editorial warnings no longer stop asset production. The API sequence test confirms that a successful warning-bearing check queues asset production, then reaches a decision-ready human review package when media and all hard gates pass.

The review read model now has separate `issues` and `warnings` arrays. Blocking editorial findings populate `warnings`; unreadable assembly, missing media, deterministic QA failures, checksum mismatches, stale media inputs, review state, and package checksum mismatches remain hard blockers. The review page displays the warning beside the one overall decision without disabling Approve or Request changes.

Red evidence: the new runtime tests failed before the runtime fix because blocking editorial findings set `passedCheck` to false for legacy and Story/Playbook candidates.

Green evidence:

- `pnpm --filter @knowledge-bits/worker typecheck && pnpm --filter @knowledge-bits/worker test` passed, 138 tests.
- `pnpm --filter @knowledge-bits/contracts typecheck && pnpm --filter @knowledge-bits/contracts test` passed, 32 tests.
- `pnpm --filter @knowledge-bits/pipeline typecheck && pnpm --filter @knowledge-bits/pipeline test` passed, 34 tests.
- `pnpm --filter @knowledge-bits/api typecheck && pnpm --filter @knowledge-bits/api test` passed, 112 tests.
- `pnpm --filter @knowledge-bits/review typecheck && pnpm --filter @knowledge-bits/review build && pnpm --filter @knowledge-bits/review test` completed with zero Astro diagnostics and a successful production build.

No live database or run was changed. No provider was called, and no secret or deployment surface was touched. Validation used Node 26.5.0 while the repository declares Node 24; pnpm reported the engine mismatch and the review build reported that Vercel will use Node 24.

Committed with `feat(worker): surface editorial QA warnings in review`.
