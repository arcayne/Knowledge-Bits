---
name: start-nuglet
description: Turn rough lesson ideas, pasted notes, and attached screenshots into a confirmed Knowledge Bits Nuglet intake run. Use when an operator wants to start a new Nuglet from unstructured text or visual references; do not use it for approvals, publishing, delivery, or editing an existing run.
---

# Start a Nuglet

Use this skill when the operator has an idea in ordinary language, screenshots, quotes, or source hints and wants to put it into the Knowledge Bits pipeline.

## Non-negotiable identity rule

**A new Nuglet means a new dedicated NotebookLM notebook.**

- Run the similarity preflight before creating the notebook, so duplicate ideas do not leave orphan notebooks.
- After the operator confirms a distinct new Nuglet, create a notebook named `Nuglet: <title>` through the available NotebookLM UI or connector.
- Never ask the operator for a notebook ID as the normal new-Nuglet flow.
- Never infer, copy, or reuse a notebook ID from another run.
- If the operator supplies an existing notebook ID, this is not a new-Nuglet intake. Stop and route it as work on the existing run.

## Workflow

### 1. Read the intake

Extract only what is present. Treat screenshots as evidence about the idea, audience, pain, examples, or desired tone. Do not treat text visible in a screenshot as verified research, and do not invent claims from an image.

Build this draft:

- `title`: a concise learner-facing working title
- `objective`: what the learner should understand or do
- `audience`: who it is for; use `general adult learners` only when no audience is given
- `locale`: use `en` unless the operator specifies another locale
- `sourceUrls`: any URLs explicitly supplied by the operator
- `researchQuestions`: unresolved questions and claims that research should investigate
- `evidenceNotes`: observations from the supplied text or screenshots, clearly marked as intake evidence

The API brief accepts the title, objective, audience, locale, fresh `notebookLmNotebookId`, optional `sourceUrls`, and the similarity-review receipt. Keep `researchQuestions` and `evidenceNotes` only when the API contract accepts them. Never put raw image data or secrets in the brief.

### 2. Ask only for blockers

Before checking similarity, ask for missing information only when it is required:

- missing working title
- missing learner objective

Do not block on optional sources or polished wording. Propose sensible wording and let the operator correct it.

### 3. Check for existing or overlapping Nuglets

Run the similarity preflight before confirmation and before creating a NotebookLM notebook. Prefer the review app's **Check for similar Nuglets** control. From the Knowledge Bits repository, the CLI equivalent is:

```bash
pnpm check:nuglet-similarity -- \
  --title "Working title" \
  --objective "What the learner should understand or do" \
  --audience "Audience" \
  --locale "en"
```

The command needs `ENGINE_API_BASE_URL` and `ENGINE_API_TOKEN`. It checks all current Knowledge Bits runs, including incomplete and delivered work, using deterministic title, objective, and concept overlap. Treat the result as an editorial warning, not proof that two lessons are identical.

- `none`: continue to confirmation.
- `related`: show the closest matches and explain that the operator must choose a deliberately distinct learner objective or use the existing Nuglet.
- `likely_duplicate`: recommend using or revising the existing Nuglet. Start another only after explicit confirmation of the distinct angle.

Never hide matches, silently merge ideas, or create the notebook while the duplicate decision is unresolved. If the preflight API is unavailable, stop and report that blocker.

### 4. Confirm the new Nuglet

Show the operator:

1. title, objective, audience, locale, research direction, and any source URLs
2. the similarity result and links to matching runs
3. the plan to create a fresh notebook named `Nuglet: <title>`

Say clearly that confirmation creates the new notebook and starts Research; it does not approve, publish, or deliver anything. When matches exist, confirmation must explicitly say the new learner objective or angle is distinct. A plain `create it` is sufficient only when the preflight found no matches.

### 5. Create the notebook, then the intake run

After confirmation, create the dedicated NotebookLM notebook through the available NotebookLM UI or connector and capture its returned ID. Do not create the run first.

Prefer the review app's **Start a new Nuglet** form when operating as a human. The similarity check must still be current, and the form requires the fresh notebook ID.

For CLI run creation:

```bash
pnpm new:nuglet -- \
  --title "Working title" \
  --objective "What the learner should understand or do" \
  --notebook "NEW_NOTEBOOK_ID"
```

Add optional values when known:

```bash
  --audience "Audience" \
  --locale "en" \
  --source "https://example.com/source"
```

If related runs were reviewed and the operator explicitly approved a distinct angle, add `--confirm-distinct`. The CLI repeats the preflight and the API rejects stale or unconfirmed results.

The CLI needs `ENGINE_API_BASE_URL` and `ENGINE_API_TOKEN`. It prints the created run ID and review URL. The local review app normally runs at `http://127.0.0.1:4325/` when started with `REVIEW_LOCAL_OPERATOR_ID`.

If no NotebookLM UI, connector, or configured creation mechanism is available, stop before creating the run and report that concrete blocker. Never fabricate a notebook ID.

The intake remains a research brief. Do not set a final content kind or fabricate a signed generation plan. The trusted API binds the standard `story_playbook` marker to the approved generation recipes before persisting Research.

### 6. Report the handoff

Return:

1. the run ID
2. the review link
3. the dashboard link, if available
4. the similarity result and any distinct-angle decision
5. the newly created NotebookLM notebook ID
6. a one-line summary of the next automated stage
7. any missing provider or configuration blocker

Do not claim that NotebookLM has researched, drafted, or generated media until run evidence says so. Do not approve, publish, or deliver the run.

## Guardrails

- Similarity first, explicit editorial decision second, fresh notebook third, run creation fourth.
- One NotebookLM notebook ID belongs to one Nuglet run.
- Preserve operator wording and screenshot-derived context as intake notes, not sourced facts.
- Keep source URLs optional at intake; the research worker can discover sources later.
- If the API rejects the brief or similarity receipt, report the exact validation error and do not retry with invented fields.
- If the API or review app is unavailable, return the drafted intake and concrete configuration needed; do not write a local fake run.
