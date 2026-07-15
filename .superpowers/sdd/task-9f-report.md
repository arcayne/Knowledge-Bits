# Task 9f Report

## Status

Complete.

## Scope

This change is limited to the NotebookLM provider, its focused tests, and this
report. It does not change recipes, generation contracts, deterministic checks,
timeouts, rate limits, the worker state machine, database state, or R2 objects.

## Behavior

- Recipe create prompts now serialize named inputs, the contract descriptor,
  and all three resolved recipe values as compact JSON.
- The prompt keeps the strict response instruction, every accepted source ID,
  the full recipe content, the complete contract descriptor, and all
  cross-format requirements. Section labels and minimal whitespace keep the
  result readable.
- Semantic repair prompts use the same compact contract descriptor while
  retaining the exact root envelope, bounded safe validation issues, bounded
  deterministic findings, accepted-citation instruction, and cross-format
  requirements.
- Every NotebookLM query passes through one shared UTF-8 byte preflight. Prompts
  above 8,000 bytes fail before the query process starts with the stable
  configuration error `notebooklm_prompt_too_large`.
- The size error does not include prompt content or provider-controlled values.
- Conversation IDs, repair-count limits, citation validation, deterministic
  validation, provider classification, and exact rendered-prompt provenance are
  unchanged.
- Recipe snapshot artifacts still store the original canonical recipe bytes.
  Rendered-prompt artifacts and execution reports store the exact compact prompt
  sent to NotebookLM.

## Tests

Focused coverage proves:

- A realistic Story and Playbook create prompt contains three accepted source
  IDs, all three compact recipe values, the complete compact contract, and every
  cross-format rule while remaining below 8,000 UTF-8 bytes.
- A semantic repair with the maximum 20 safe validation issues remains below
  8,000 bytes and retains the root envelope, compact contract, and cross-format
  rules.
- A multibyte UTF-8 prompt above the ceiling is rejected before the NotebookLM
  query process call.
- The oversized error is stable, typed as configuration work, and sanitized.
- Existing prompt provenance, conversation, repair limit, deterministic,
  citation, timeout, and provider-classification coverage remains green.

## TDD Evidence

The baseline focused suite had 45 passing tests. After adding the Task 9f tests
and before changing the provider, the focused run had 42 passing and 5 failing
tests. The failures showed the pretty-printed inputs and contract, oversized
repair prompt, and missing query preflight. After the provider change and one
legacy whitespace assertion update, all 47 focused tests passed.

## Verification

Commands ran in
`/Users/dearkane/Documents/dev/.worktrees/knowledge-bits-generation-v03` under
Node `24.18.0` through `npm exec --package=node@24.18.0`.

- Focused NotebookLM provider tests: 47 passing, 0 failing.
- Worker typecheck: passed.
- `git diff --check`: passed with no output.

The live workflow was not run. No database or R2 mutation was performed.

## Concerns

None.
