# Run notes

## Implementation status

The URL-only intake and server-owned NotebookLM provisioning slices are implemented.

Implemented boundaries:

- `POST /runs/joan` accepts only `youtubeUrl`.
- YouTube `watch`, `shorts`, and `youtu.be` URLs are canonicalized.
- The brief is validated as `joan.ai-video-brief.v1`.
- Duplicate canonical video intake returns HTTP 409.
- The route creates the normal leased workflow with `research` queued.

NotebookLM provisioning boundary:

- The worker calls `nlm notebook list --json` and reuses an exact deterministic Joan title when it
  exists.
- On a miss, the worker calls `nlm notebook create <title> --json`.
- The worker binds the returned ID through `POST /jobs/:id/notebook`.
- The API persists the ID on the run and the active research job input.
- The API accepts the binding only from the current research lease owner and rejects conflicting or
  already-assigned notebook IDs.
- Authentication failures become `needs_human`; timeouts and rate limits become scheduler waits.

## Validation

- Contracts typecheck, build, and 44 tests passed.
- Pipeline build passed.
- API route suite passed: 11 tests.
- API typecheck is blocked by the local generated Prisma client state. The failure is in existing
  repository Prisma types and is not caused by the Joan route changes.
- The environment uses Node 20.11.0. The repository declares Node 24 as its supported engine.
- The real first-usecase run still needs a configured PostgreSQL-backed API and a worker process to
  execute this boundary end to end.
