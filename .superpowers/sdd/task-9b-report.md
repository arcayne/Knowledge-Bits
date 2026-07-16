# Task 9b Report

## Status

Complete.

## Root Cause

NotebookLM could return a grounded, citation-valid Story/Playbook draft as a
well-formed provider envelope while omitting the required `kind`,
`schemaVersion`, and `payload` root. The original provider repaired only JSON
and envelope parsing failures. Once such an answer parsed, strict schema
validation raised `notebooklm_content_invalid` without a correction attempt.

## Changes

- Expanded the provider-facing Story/Playbook contract descriptor with the
  exact root envelope, payload constants, UUID requirements for claims and
  references, required non-empty string arrays, hero accessibility enum, and
  prohibition on alternate intermediate output shapes.
- Added a single semantic repair query for recipe-backed schema `1.1.0`
  creation responses after citation validation and strict Story/Playbook
  validation identify a structural failure.
- The repair prompt repeats the deterministic original prompt, identifies the
  previous answer as structurally invalid, preserves grounded meaning and
  accepted citations, supplies at most 20 deterministic Zod issue paths and
  messages, repeats the exact root envelope and full descriptor, and requires
  one JSON object without markdown.
- The prompt contains no raw invalid provider output or source snapshot text.
- Repaired responses are checked again for accepted-source citation binding and
  the complete strict Story/Playbook schema. A second structural failure remains
  `ProviderNeedsHumanError('notebooklm_content_invalid', 'quality')`.
- Existing malformed JSON repair, transport timeout, cooldown behavior, and
  citation enforcement remain on their existing paths.
- Successful semantic repairs record both prompts, create support artifacts for
  both prompts, and select the repaired provider envelope as `rawResponse`.

## TDD Evidence

The new focused tests were added before production changes. The initial run
failed as expected: the descriptor had no exact-contract fields, and a direct
unwrapped Story/Playbook response reached `notebooklm_content_invalid` without
a semantic repair query.

The final tests cover:

- Exact, JSON-serializable descriptor constraints.
- One semantic repair for a direct unwrapped response resembling the production
  failure.
- Deterministic repair issue paths, original-prompt reuse, exact envelope,
  descriptor repetition, and absence of invalid raw output or source snapshot
  text.
- Repaired prompt provenance, support artifacts, and selected raw response.
- Typed quality failure after a second invalid semantic response.
- Citation source binding after semantic repair.
- One provider query for valid first responses and bounded existing malformed
  JSON repair behavior.

## Verification

All checks used Node `24.18.0`:

- `pnpm --filter @knowledge-bits/contracts build`
- `pnpm --filter @knowledge-bits/contracts test`: 31 passing
- `pnpm --filter @knowledge-bits/worker exec tsx --test src/providers/notebooklm.test.ts`: 18 passing
- `pnpm --filter @knowledge-bits/worker typecheck`: passing
- `git diff --check`: passing

## Scope and Safety

Changed only the Story/Playbook descriptor, NotebookLM provider, and focused
contract/provider tests. No Zod schema was loosened. No claim IDs, payload
wrappers, strings, or accessibility values are normalized or locally coerced
by the semantic repair path. No transport waits, timeouts, or cooldown rules
were changed.

## Blocker Repair, 2026-07-15

### Status

All three review blockers are repaired.

### Changes

- Replaced raw Zod messages with allowlisted path segments and fixed messages
  selected by safe path or issue code. Semantic diagnostics are capped at 20
  issues and 2,000 rendered characters, including list markers and separators.
- Added the strict `storyPlaybookDraftTargetSchema` for the exact
  `{kind,schemaVersion,payload}` root. Schema 1.1.0 validation no longer
  normalizes `claimCoverage`; it only enriches citation snapshot artifact IDs
  from accepted evidence before strict validation.
- Parsed the one semantic repair response directly. Malformed JSON or an
  invalid provider envelope now raises `notebooklm_malformed_output` without a
  fourth provider call.
- Added provider tests for secret enum values, many oversized unknown keys,
  issue count and character bounds, support artifact redaction, extra root
  keys, object-shaped `claimCoverage` before and after repair, and malformed
  semantic output with an unused fourth response.

### TDD Evidence

Tests were added before the blocker repairs. This command used Node 24.18.0:

```bash
PATH="/Users/dearkane/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @knowledge-bits/contracts test
PATH="/Users/dearkane/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm --filter @knowledge-bits/worker exec tsx --test src/providers/notebooklm.test.ts
```

Initial result: contract tests reported 30 passing and 2 failing. Provider
tests reported 18 passing and 9 failing. The failures reproduced the missing
strict target export, secret and oversized-key disclosure, acceptance of extra
root keys and object-shaped `claimCoverage`, and the fourth-query path.

### Final Verification

All commands ran with this Node selection:

```bash
export PATH="/Users/dearkane/.nvm/versions/node/v24.18.0/bin:$PATH"
node --version
pnpm --filter @knowledge-bits/contracts build
pnpm --filter @knowledge-bits/contracts test
pnpm --filter @knowledge-bits/worker exec tsx --test src/providers/notebooklm.test.ts
pnpm --filter @knowledge-bits/worker typecheck
git diff --check
```

Exact results:

- `node --version`: `v24.18.0`.
- Contracts build: passed, exit 0.
- Contract tests: 32 passed, 0 failed.
- Focused NotebookLM provider tests: 27 passed, 0 failed.
- Worker typecheck: passed, exit 0.
- `git diff --check`: passed with no output, exit 0.

### Concerns

None.
