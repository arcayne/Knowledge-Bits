# NotebookLM public preview video flow

## Objective

Finish the reusable NotebookLM Short path so a Nuglet can request a branded public-preview video, keep it attached to the immutable review package, and hand it to the downstream delivery boundary after human approval.

## Scope

- Validate the existing NotebookLM Short creation, idempotency, post-processing, and protected-content checks.
- Preserve completed `public_preview` artifacts when the repository assembles successful review media.
- Keep the video available to the review package and delivery payload without changing the Nuglet lesson page yet.

## Non-goals

- Do not fit the video into the public Nuglet preview page in this change.
- Do not auto-approve a generated Short or bypass source, narrative, technical, or protected-content review.
- Do not regenerate or mutate a live Nuglet run while validating the flow.

## Acceptance criteria

1. A `public_preview` regeneration request queues one media job for any compatible Nuglet run.
2. NotebookLM output is post-processed into a 40–65 second, near-9:16 MP4 with the Nuglet end card and retained audio.
3. Idempotency and provider state prevent duplicate work for the same current prompt and source input.
4. Technical and protected-content checks fail closed, and successful output remains pending human review.
5. A completed `public_preview` artifact survives successful-stage selection, appears in the review package, and remains in the approved delivery artifact inventory.
6. Existing content, media, delivery, and review behavior remains covered by focused tests.

## Verification

- Repository regression test for completed `public_preview` retention.
- Focused NotebookLM media command, renderer, worker runtime, API route, review package, and review-client tests.
- Typechecks/builds for contracts, worker, API, and review packages where the current checkout permits.
