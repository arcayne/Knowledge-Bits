# Task 9f Repair Report

## Status

Complete.

## Scope

This repair is limited to the NotebookLM provider, its focused test, and this
report. It does not change approved Task 9d conversation behavior, Task 9e
deterministic validation, Task 9f prompt content or limits, recipes, contracts,
timeouts, rate limits, the worker state machine, database state, or R2 objects.

## Repair

- The provider now renders and checks the initial prompt immediately after
  resolving its context and recipes.
- An initial prompt above the 8,000-byte UTF-8 limit fails before NotebookLM CLI
  version discovery, source listing, source import, or query execution.
- The shared guard in the query helper remains in place, so initial and repair
  queries are still checked at the process boundary.
- The oversized-prompt regression includes a source URL that would otherwise be
  listed and imported, and asserts that the process runner receives zero calls.
- The stable sanitized `notebooklm_prompt_too_large` configuration error is
  unchanged.

## TDD Evidence

With the stronger regression test in place and before the provider change, the
focused suite had 46 passing tests and 1 failing test. The failure showed an
unexpected source-list process invocation after version discovery. After moving
the initial prompt preflight ahead of all NotebookLM process work, all 47 tests
passed.

## Verification

Commands ran in
`/Users/dearkane/Documents/dev/.worktrees/knowledge-bits-generation-v03` under
Node `24.18.0` through `npm exec --package=node@24.18.0`.

- Focused NotebookLM provider tests: 47 passing, 0 failing.
- Worker typecheck: passed.
- `git diff --check`: passed with no output.

The live workflow was not run. No database or R2 mutation was performed.
