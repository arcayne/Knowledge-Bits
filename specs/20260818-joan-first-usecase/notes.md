# First-usecase notes

## Observed source metadata

The supplied URL resolves in search to `Full Walkthrough: Workflow for AI Coding — Matt Pocock`.
The indexed description identifies the video as a hands-on workshop about agent-ready plans,
vertical tracer-bullet slices, TDD, autonomous coding agents, and agent-effective codebases.
This metadata is intake context only. It is not accepted research evidence until the pipeline
captures the YouTube page and transcript as immutable artifacts.

## Intake

The URL-only route succeeded against the in-memory control API.

Run: `cde5ebe5-eb9f-4e98-9cba-fcdfc385b6d6`

Stage: `research`

Expected: queue research for the canonical YouTube video.

Actual: research queued. The run brief contains the canonical URL, video ID, Joan profile defaults,
and the two-to-five-minute target. No NotebookLM notebook ID is present.

## Research boundary

The worker context failed before provider execution:

Expected: a real NotebookLM notebook ID is available to the research provider.

Actual: `ProviderNeedsHumanError(notebooklm_notebook_id_missing)` with
`needsHumanKind=configuration`.

## Required change

Resolved by `specs/20260819-joan-notebook-provisioning`: the worker now creates or reuses a
dedicated notebook through the authenticated `nlm` CLI, binds the returned ID through the active
research lease, and persists it on the run and research job. The implementation uses the video ID
only as part of a deterministic title; it does not derive a notebook ID from it.

The first-usecase evidence below remains historical. It was captured before this boundary existed.

## Publication state

No X or LinkedIn publication was attempted.

## Asset experiment

The NotebookLM video format is `Short` (the bite-sized overview), not `Explainer`. The current
NotebookLM focus selection is `LLM Smart Zones`. A custom focus remains available if the selected
topic does not cover the checked brief adequately.

The first use case will also test a four-to-eight-card photo-infographic series. The series is an
internal content asset and does not require Instagram delivery. The default format is 1080x1350
portrait (4:5). The final card count will be selected after research. The series must use the same
checked brief as the NotebookLM audio and video so the media options remain comparable and cannot
drift into separate factual narratives.

## Experiment learnings

- A narrow NotebookLM focus such as `LLM Smart Zones` or `Vertical Slices` does not represent the
  full source video. The stronger prompt names the complete workflow and requires the primary video
  to remain the narrative spine.
- The source-dominant prompt produced the most useful result: `The Day Shift / Night Shift AI Coding
  Workflow`. The YouTube source was the only selected generation source for this experiment.
- NotebookLM `Short` is the correct format for this audience. `Explainer` is too broad for the
  intended two-minute consumption pattern.
- The existing Nuglet post-processor is reusable for Joan video output. It masks the NotebookLM
  lower footer, trims the provider tail, preserves audio, and adds the Nuglet end card. The branded
  render passed visual and technical inspection at 65 seconds, 720x1280, with audio.
- The post-processor changes branding and ending treatment, not the NotebookLM visual style. A
  future style iteration should use a dedicated visual-style prompt if the default style remains
  too generic.

## Follow-up improvements

- Execute the full PostgreSQL-backed Joan run so source discovery, verification, import, video
  generation, and post-processing are one durable workflow.
- Add a Joan-specific media contract that invokes the reusable Nuglet post-processor automatically.
- Add a human review step for factual coverage and visual style before X or LinkedIn publication.
