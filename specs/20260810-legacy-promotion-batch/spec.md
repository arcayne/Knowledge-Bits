# Legacy promotion batch and default video pipeline

## Objective

Move ten approved legacy Nuglets into new revisions that generate a grounded social post and every required media asset, including `public_preview`, then stop at checksum-bound human review.

## Batch

1. Why ChatGPT keeps misunderstanding you
2. You do not need to catch up to all of AI
3. Attention Span Recovery After Short-Form Video
4. Why do people procrastinate even when they care?
5. The Work Behind the Work
6. $100M Offers: Build an Offer People Want
7. AI Tool FOMO vs. Actual Usefulness
8. And then what? The question behind every good decision
9. Confidence is not accuracy
10. Decide before the moment decides for you

## Architecture

The operator conversation prepares and authorizes the batch. The existing Research and Create LLM stages remain responsible for grounded lesson generation. Create must emit the canonical `socialPost`. Produce Assets must generate hero, infographic, both audio formats, and `public_preview` by default for strict generated Nuglets. The preview must be checksummed against the canonical social post.

Approved packages are immutable. Each legacy lesson starts a fenced source revision using its current revision, approved checksum, existing NotebookLM notebook, and previously accepted source URLs. The previous revision remains preserved. The new revision clears approval and stops at human review.

## Non-goals

- Do not approve, deliver, or publish any of the ten revisions.
- Do not mutate an approved package in place.
- Do not invent reviewer identity or approval metadata.
- Do not bypass Research, Create, Check, or media validation.

## API and state behavior

- Add review-authenticated `POST /runs/:id/prepare-source-revision` for approved strict Nuglet runs.
- Fence on current revision, approved package checksum, NotebookLM notebook, and no active non-delivery work.
- Supersede stale queued delivery work, increment revision, clear package and approval checksums, and queue Research.
- Preserve historical artifacts, packages, and reviews.
- Honor explicit `brief.mediaRegeneration.regeneratedKinds` when Produce Assets is queued.
- For ordinary strict generated Nuglets without an override, request all required media plus `public_preview`.
- Mark standard strict intake with a promotion bundle and treat its `public_preview` as required in review. Explicit source revisions that request `public_preview` are required as well.
- Reject preview compilation when the canonical social post is absent, malformed, or has fewer than three hashtags.

## Failure modes

- Stale revision/checksum, changed notebook, active jobs, or invalid source URLs: reject without mutation.
- Research/provider credential failure: leave the individual run at its typed recoverable state; do not approve or publish.
- Invalid generated social post: fail deterministic Check before media generation.
- Video/provider failure: stop the individual run in Produce Assets with the other runs unaffected.

## Acceptance criteria

1. Contract, repository, and route tests cover fenced source revision and replay.
2. Produce Assets defaults include `public_preview` and respect explicit regeneration kinds.
3. Review assembly requires a preview for strict generated Nuglets and binds it to `socialPost`.
4. Preview compilation rejects missing or invalid social posts.
5. Focused tests and workspace typechecks pass.
6. A deploy PR is merged with the deploy label and its deployment is ready.
7. All ten live runs are queued as new revisions and monitored to human review.
8. Final handoff includes one review link per run and reports complete/missing assets accurately.

## Verification

- Contracts tests.
- API repository, route, and review-package tests.
- Worker public-preview and media tests.
- Workspace typecheck.
- Live API snapshots for revision, stage/state, review status, package checksum, social post, and five asset states.
