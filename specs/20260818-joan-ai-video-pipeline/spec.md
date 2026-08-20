# Joan AI video pipeline implementation

## Objective

Start the Joan AI video pipeline with one YouTube URL and preserve the existing agentic delivery
framework: leased stages, immutable artifacts, human review, and human-controlled publication.

## Current slice

- Add a versioned `joan.ai-video-brief.v1` run brief.
- Add URL-only Joan intake at `POST /runs/joan`.
- Canonicalize supported YouTube URL forms to one video ID and URL.
- Reject duplicate intake for the same video within the current repository read model.
- Keep the NotebookLM account outside the API and repository.
- Provision or reuse one dedicated NotebookLM notebook during the leased research job, using the
  authenticated worker-side `nlm` command.
- Persist the provisioned notebook ID through an API-owned, lease-scoped binding transition.

## Non-goals

- Do not call YouTube, NotebookLM, X, or LinkedIn during tests.
- Do not fabricate a NotebookLM notebook ID.
- Do not publish content.
- Do not change Nuglet content contracts or delivery behavior.

## Acceptance criteria

1. A Joan run can be created with only a YouTube URL.
2. Supported URL forms canonicalize to one HTTPS watch URL and one video ID.
3. The created brief contains the default Joan audience, voice, research policy, and two-to-five-minute target.
4. A second run for the same canonical video is rejected.
5. Invalid or non-YouTube URLs are rejected.
6. Existing run creation and Nuglet tests remain unchanged in behavior.

## Next vertical slice

Implement a Joan research provider that captures the YouTube page, description, transcript, and
author links. The notebook-provisioning boundary is implemented. The worker must now use the bound
notebook to synchronize accepted sources and execute the Joan research prompts.
