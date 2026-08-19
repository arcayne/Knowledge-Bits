# Joan NotebookLM provisioning implementation

## Objective

Remove `notebookLmNotebookId` from Joan operator input. The research worker must provision or reuse
one dedicated NotebookLM notebook and persist the binding before the NotebookLM research provider
runs.

## Acceptance criteria

1. Joan intake remains URL-only.
2. A worker-owned adapter calls `nlm notebook list --json` and, when needed,
   `nlm notebook create <title> --json`.
3. Retries use a deterministic title derived from the canonical video ID and do not intentionally
   create a second notebook after a successful create.
4. The worker binds the returned notebook ID through the API using the active research lease.
5. The API persists the ID on both the run and the research job input.
6. Invalid CLI output, authentication failure, timeout, rate limit, and lease conflicts produce
   typed workflow outcomes.
7. No real YouTube, NotebookLM, X, or LinkedIn call is made by automated tests.

## Boundary

The NotebookLM session and CLI credentials remain on the worker host. The API owns the durable
notebook assignment and lease authorization. Operator input contains no NotebookLM ID.
