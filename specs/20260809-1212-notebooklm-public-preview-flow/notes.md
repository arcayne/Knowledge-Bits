# Run notes

The Knowledge Bits checkout already contained the NotebookLM Short implementation: deterministic public-preview source compilation, current-prompt idempotency, NotebookLM polling and download, local ffmpeg post-processing, transcript/protected-content checks, review-package asset wiring, and a review-page video element.

The missing persistence boundary was `REVIEW_MEDIA_ARTIFACT_KINDS` in the workflow repository. It omitted `public_preview`, so `listArtifactsForSuccessfulStageJobs` could discard a completed Short before `ReviewPackageService` assembled the package. The allowlist now includes `public_preview`, with an in-memory repository regression test that records and completes a Short-producing job before loading the successful media set.

No provider was called and no live run was changed. The public Nuglet lesson page remains intentionally untouched for the next step.

## Validation

- API repository, review route, and review-package tests: 72 passed.
- NotebookLM media-command tests: 14 passed.
- Public-preview source and renderer tests: 10 passed.
- Review package and browser tests: 22 passed.
- Contracts: typecheck, build, and 38 tests passed.
- Worker typecheck and review Astro check passed with zero diagnostics.
- API typecheck remains blocked by the unrelated pre-existing `delete mediaArtifacts.hero` test edit described above.
