---
name: start-nuglet
description: Turn rough lesson ideas, pasted notes, and attached screenshots into a confirmed Knowledge Bits Nuglet intake run. Use when an operator wants to start a new Nuglet from unstructured text or visual references; do not use it for approvals, publishing, delivery, or editing an existing run.
---

# Start a Nuglet

Use this skill when the operator has an idea in ordinary language, screenshots, quotes, or source hints and wants to put it into the Knowledge Bits pipeline.

## Workflow

### 1. Read the intake

Extract only what is present. Treat screenshots as evidence about the idea, audience, pain, examples, or desired tone. Do not treat text visible in a screenshot as verified research, and do not invent claims from an image.

Build this draft:

- `title`: a concise learner-facing working title
- `objective`: what the learner should understand or do
- `audience`: who it is for; use `general adult learners` only when no audience is given
- `locale`: use `en` unless the operator specifies another locale
- `notebookLmNotebookId`: the dedicated NotebookLM notebook created for this Nuglet, unless the operator explicitly supplies an existing notebook to reuse
- `sourceUrls`: any URLs explicitly supplied by the operator
- `researchQuestions`: unresolved questions and claims that research should investigate
- `evidenceNotes`: observations from the supplied text or screenshots, clearly marked as intake evidence

The API brief currently accepts the first five fields plus optional `sourceUrls`; keep `researchQuestions` and `evidenceNotes` in the brief only when the API contract accepts them. Never put raw image data or secrets in the brief.

By default, plan a new NotebookLM notebook named `Nuglet: <title>` for every new Nuglet. Do not ask the operator for a notebook ID unless they explicitly want to reuse an existing notebook.

### 2. Ask only for blockers

Before creating a run, ask for the missing information only if it is required to start safely:

- missing working title
- missing learner objective
Do not block on optional sources or polished wording. Propose a sensible draft and let the operator correct it.

### 3. Confirm the run

Show the operator the proposed title, objective, audience, the plan to create a dedicated NotebookLM notebook, research direction, and any source URLs. If the operator supplied an existing notebook ID, show that explicit reuse instead. Say clearly that confirmation creates the notebook if needed and starts research; no approval, publication, or delivery will happen automatically.

Do not create the run until the operator confirms. A confirmation such as `start it`, `create it`, or `go ahead` is sufficient after the draft has been shown.

### 4. Create the intake run

Prefer the review app's **Start a new Nuglet** form when operating as a human. It uses the review operator identity and is the easiest path to follow the new run.

After confirmation, create the dedicated NotebookLM notebook through the available NotebookLM UI or connector, using `Nuglet: <title>` as its display name, and capture the returned notebook ID. If the operator explicitly supplied an existing notebook ID, use that ID and do not create another notebook.

For CLI run creation, from the Knowledge Bits repository run with the newly created ID:

```bash
pnpm new:nuglet \
  --title "Working title" \
  --objective "What the learner should understand or do" \
  --notebook "CREATED_NOTEBOOK_ID"
```

Add optional values when known:

```bash
  --audience "Audience" \
  --locale "en" \
  --source "https://example.com/source"
```

The CLI needs `ENGINE_API_BASE_URL` and `ENGINE_API_TOKEN`; it does not create the NotebookLM notebook itself, so create the notebook first when using this path. It prints the created run ID and review URL. The local review app normally runs at `http://127.0.0.1:4325/` when started with `REVIEW_LOCAL_OPERATOR_ID`.

If no NotebookLM UI, connector, or other configured creation mechanism is available, stop before creating the run and report that concrete blocker. Never fabricate a notebook ID or silently reuse another run's notebook.

The intake must remain a research brief. Do not set a final content kind or fabricate a signed generation plan. The trusted API binds the standard `story_playbook` marker to the approved generation recipes before it persists the Research job.

### 5. Report the handoff

Return:

1. the run ID
2. the review link
3. the dashboard link, if available
4. the NotebookLM notebook ID and whether it was newly created or explicitly reused
5. a one-line summary of the next automated stage
6. any missing provider or configuration blocker

Do not claim that NotebookLM has researched, drafted, or generated media until the run evidence says so. Do not approve, publish, or deliver the run.

## Guardrails

- Create a fresh NotebookLM notebook for each Nuglet by default. One NotebookLM notebook ID belongs to one Nuglet run.
- Reusing an existing notebook requires the operator to provide or explicitly approve that notebook ID; never infer or silently reuse one from another run.
- Preserve operator wording and screenshot-derived context as intake notes, not as sourced facts.
- Keep source URLs optional at intake; the research worker can discover sources later.
- If the API rejects the brief, report the exact validation error and do not retry with invented fields.
- If the API or review app is unavailable, return the drafted intake and the concrete configuration needed; do not silently write a local fake run.
