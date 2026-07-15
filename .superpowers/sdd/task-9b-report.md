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
