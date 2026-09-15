# Joan NotebookLM provisioning implementation

## Objective

Remove `notebookLmNotebookId` from Joan operator input. The research worker must provision or reuse
one dedicated NotebookLM notebook and persist the binding before the NotebookLM research provider
runs.

## Acceptance criteria

1. Joan intake remains URL-only.
2. A worker-owned adapter calls `nlm notebook list --json` and, when needed,
   `nlm notebook create <title> --json`.
3. The adapter adds every required source URL with `nlm source add ... --wait` before returning.
4. For Joan research, the worker asks NotebookLM web research for related sources using the
   YouTube title, author, topic, objective, and audience; the research task is polled to completion.
5. NotebookLM research candidates are passed through deterministic URL verification before any
   related source is imported into the notebook.
6. Retries use a deterministic title derived from the canonical video ID and do not intentionally
   create a second notebook after a successful create.
7. The worker binds the returned notebook ID through the API using the active research lease.
8. The API persists the ID on both the run and the research job input.
9. Invalid CLI output, authentication failure, timeout, rate limit, missing source URL, and lease conflicts produce
   typed workflow outcomes.
10. No real YouTube, NotebookLM, X, or LinkedIn call is made by automated tests.

## Boundary

The NotebookLM session and CLI credentials remain on the worker host. The API owns the durable
notebook assignment and lease authorization. Operator input contains no NotebookLM ID.
