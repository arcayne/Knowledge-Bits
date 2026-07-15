# Notes

The previous change treated every parseable editorial response as advisory. That was correct only for the current Story/Playbook 1.1.0 path. It also let legacy Pi checks succeed even though legacy inputs have no generation plan for media production.

The approved policy preserves hard machine gates while treating editorial judgment as advisory evidence for the final human decision only in the current Story/Playbook 1.1.0 pipeline.

## Implementation evidence

Blocking Story/Playbook editorial findings remain in the successful QA artifact. The worker keeps raw response bytes, parsed QA, the execution report, and prompt provenance before reporting the check complete. Legacy Pi checks again raise `editorial_check_failed` for blocking findings, so they cannot schedule an asset job that lacks a 1.1.0 generation plan.

Story/Playbook media eligibility still requires a passing deterministic check with the current semantic content checksum and the validated 1.1.0 plan. Editorial warnings no longer stop that path. A focused runtime test confirms the media adapter is invoked for a warning-bearing Story/Playbook package, while a legacy context stops before any media client call.

Editorial summaries now reject empty and whitespace-only strings at parsing and contract validation time. The review read model keeps separate `issues` and `warnings` arrays. Blocking Story/Playbook editorial findings populate `warnings`; unreadable assembly, missing media, deterministic QA failures, checksum mismatches, stale media inputs, review state, and package checksum mismatches remain hard blockers. When a later hard assembly failure occurs, readable warnings remain in the fallback response. The review page bounds warning height with scrolling and reserves space below the document so its fixed decision area does not cover review content.

Red evidence:

- `pnpm --filter @knowledge-bits/worker exec tsx --test src/checks/checks.test.ts src/providers/pi.test.ts` failed before the fix because blank summaries were accepted and legacy Pi returned success for blocking findings.
- `pnpm --filter @knowledge-bits/contracts test` failed before the contract build because whitespace-only summaries were accepted by the QA schema.
- `pnpm --filter @knowledge-bits/api exec tsx --test src/services/review-packages.test.ts` failed before the fallback fix because the warning list was empty after a media assembly error.
- `pnpm --filter @knowledge-bits/review exec node --test src/review-browser.test.mjs` failed before the CSS fix because the decision area had no bounded warning height.

Green evidence:

- `pnpm --filter @knowledge-bits/worker exec tsx --test src/checks/checks.test.ts src/providers/pi.test.ts src/runtime.test.ts` passed, 28 tests.
- `pnpm --filter @knowledge-bits/contracts build && pnpm --filter @knowledge-bits/contracts test` passed, 32 tests.
- `pnpm --filter @knowledge-bits/api exec tsx --test src/services/review-packages.test.ts` passed, 14 tests.
- `pnpm --filter @knowledge-bits/review exec node --test src/review-browser.test.mjs src/review-client.test.mjs` passed, including a 390px-wide mobile Playwright check.
- `pnpm --filter @knowledge-bits/contracts typecheck && pnpm --filter @knowledge-bits/contracts build && pnpm --filter @knowledge-bits/contracts test` passed, 32 tests.
- `pnpm --filter @knowledge-bits/pipeline typecheck && pnpm --filter @knowledge-bits/pipeline test` passed, 34 tests.
- `pnpm --filter @knowledge-bits/worker typecheck && pnpm --filter @knowledge-bits/worker test` passed, 139 tests.
- `pnpm --filter @knowledge-bits/api typecheck && pnpm --filter @knowledge-bits/api test` passed, 113 tests.
- `pnpm --filter @knowledge-bits/review typecheck && pnpm --filter @knowledge-bits/review build && pnpm --filter @knowledge-bits/review test` completed with zero Astro diagnostics and 16 passing tests.

No live database or run was changed. No provider was called, and no secret or deployment surface was touched. Validation used Node 26.5.0 while the repository declares Node 24; pnpm reported the engine mismatch and the review build reported that Vercel will use Node 24.

The repair is ready to commit on `codex/nuglet-generation-v03`.
