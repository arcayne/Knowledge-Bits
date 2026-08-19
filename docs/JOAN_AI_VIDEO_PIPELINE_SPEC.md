# Joan AI Video Brief Pipeline

Status: Draft specification

## 1. Objective

Create a reviewed Joan-branded briefing from one YouTube video.

The briefing is for people who need to stay informed about artificial intelligence but do not
have time to watch long videos. The pipeline must extract the most relevant information from a
video that may be 50 minutes or longer and present it in approximately two to five minutes.

The pipeline produces NotebookLM audio and video summaries, plus platform-ready content for X
and LinkedIn. It also produces a reusable series of photo-infographic assets. The photo-infographic
series is a content asset, not an Instagram delivery requirement.

## 2. Scope

### In scope for the first version

- One YouTube URL as the only required operator input.
- Automatic extraction of the video description, channel, author, metadata, and transcript when
  available.
- Inspection of author-provided links and relevant papers or reports.
- Source-grounded summary and evidence package.
- NotebookLM audio and video outputs using Joan's personal NotebookLM account.
- A reusable photo-infographic series generated outside NotebookLM.
- Joan-branded X and LinkedIn drafts.
- Human review before any publication.
- Manual publication handoff. Direct X and LinkedIn publishing are later adapters.

### Out of scope for the first version

- Manual editing of transcripts inside the pipeline.
- Automatic publishing to X or LinkedIn.
- Reproduction of complete transcripts or large sections of source content.
- Summary generation from a title and description when no usable transcript or source content is
  available.
- Multiple videos in one run.

## 3. Operator input

The run request contains only:

```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=..."
}
```

The system derives the following values from the URL and the video page:

- canonical video URL and video ID;
- title;
- channel and author name;
- publication date;
- video duration;
- video description;
- available transcript or captions;
- author-provided links;
- candidate papers, reports, and other references.

Audience, locale, brand voice, and research policy are pipeline-profile configuration. They are
not required for each run in the first version.

Default profile:

- Audience: AI-curious professionals and builders who need a fast, reliable briefing.
- Locale: English.
- Brand voice: clear, evidence-led, curious, useful, and low-hype.
- Research policy: prioritize sources linked by the author; add independent sources only when they
  materially improve context, accuracy, or qualification.

## 4. Run identity and duplicate handling

Each run is associated with one canonical YouTube video ID.

The system must:

- warn when an active or completed run already exists for the same video;
- prevent accidental duplicate publication of the same approved package;
- permit an explicit refresh when the transcript, description, or source set has changed;
- create a new revision when refreshed evidence changes the content or assets.

The package checksum must include the accepted source set, canonical brief, generated media, social
drafts, and delivery metadata.

## 5. Workflow stages

The implementation must use the existing workflow stage names.

### `research`

1. Validate and canonicalize the YouTube URL.
2. Retrieve bounded video metadata and the description.
3. Retrieve a usable transcript or caption source.
4. Extract author-provided links from the video description and known channel information.
5. Identify relevant papers, reports, or authoritative references.
6. Remove duplicates and classify each source by relationship to the video.
7. Capture immutable source snapshots and checksums.

Research output:

- accepted and rejected source list;
- source relationship and attribution metadata;
- transcript snapshot;
- coverage gaps;
- candidate paper and report notes;
- research execution report.

If no usable transcript or equivalent source content is available, the stage must move to
`needs_human`. The pipeline must not create a confident summary from metadata alone.

### `create`

Create the canonical Joan briefing from the accepted evidence.

Required content:

- one-sentence briefing;
- two-to-five-minute spoken-summary target;
- three to five key ideas;
- why the information matters now;
- important examples or technical details;
- relevant paper or report context;
- limitations, uncertainty, or disagreement;
- one-line takeaway;
- distinct Joan commentary, clearly separated from source claims;
- source links and attribution notes.

The worker creates or uses one dedicated NotebookLM notebook for the run and records the notebook
ID. NotebookLM is a provider inside the pipeline. It does not approve or publish the package.

The canonical briefing must also define the visual sequence for the photo-infographic series. Each
card must have one main idea, one evidence boundary, and one short text equivalent.

### `check`

The check stage must verify:

- every material factual claim maps to accepted evidence;
- the briefing distinguishes the video author's claims from independent evidence;
- papers and reports are relevant and correctly attributed;
- unsupported claims, invented statistics, and false certainty fail the check;
- the content does not reproduce the source transcript unnecessarily;
- the summary has enough substance for a two-to-five-minute briefing;
- the Joan commentary does not disguise opinion as source fact;
- X and LinkedIn drafts satisfy their format constraints;
- attribution and required disclosure text are present.

### `produce_assets`

Produce and record:

- NotebookLM audio summary;
- NotebookLM video summary;
- photo-infographic series;
- X post or thread draft;
- LinkedIn post draft;
- source and attribution block;
- optional title, cover text, or thumbnail direction;
- a human-readable review bundle.

The target duration for both NotebookLM media outputs is two to five minutes. The actual duration
must be measured and recorded. An output outside the configured tolerance requires regeneration or
human review.

The photo-infographic series contains four to eight cards in a 4:5 portrait format at 1080x1350
pixels. The card count is selected after research from the information structure of the briefing.
Four cards is the minimum useful structure. Eight cards is the maximum. The pipeline must not add
cards only to reach a target count.

The count includes every delivered image in the series, including an opening or closing card if the
series uses one. Each card records its sequence number, title, alt text, text equivalent, claim
references, content checksum, and visual-generation provenance.

Card-count guidance:

- Four cards: one central idea, two supporting structures, and one takeaway.
- Five or six cards: the normal range for a briefing with several mechanisms or examples.
- Seven or eight cards: use only when the source contains a process, comparison, timeline, or
  important qualification that cannot remain clear in fewer cards.

The image generator may create the visual treatment, but it must not invent facts, numbers, quotes,
citations, or source attribution. All factual card copy must come from the checked canonical brief.

### `human_review`

The reviewer sees the complete package:

- source inventory;
- evidence and citations;
- canonical briefing;
- NotebookLM audio and video;
- photo-infographic series in sequence order;
- X draft;
- LinkedIn draft;
- attribution, disclosure, and rights notes.

One approval applies to the exact package checksum. Any content or asset change creates a new
revision and invalidates the prior approval.

### `deliver`

For the first version, delivery creates a ready-to-post package and records a manual handoff.

The handoff must include:

- final media files or approved media links;
- final X copy;
- final LinkedIn copy;
- source links;
- attribution and disclosure text;
- suggested publication order;
- tracking URL when applicable.

Later versions may add separate X and LinkedIn delivery adapters. Each adapter must support
idempotency, external post IDs, retry handling, and publication verification.

## 6. Proposed package structure

```text
joan.ai-video-brief.v1
├── identity
├── sourceEvidence
├── knowledgeCore
├── notebookLm
├── social
├── rights
├── review
└── delivery
```

Important fields include:

- `identity.youtubeVideoId`
- `identity.sourceUrl`
- `identity.title`
- `identity.author`
- `sourceEvidence.primaryVideo`
- `sourceEvidence.transcript`
- `sourceEvidence.description`
- `sourceEvidence.authorLinks`
- `sourceEvidence.papers`
- `knowledgeCore.summary`
- `knowledgeCore.keyIdeas`
- `knowledgeCore.caveats`
- `knowledgeCore.joanCommentary`
- `notebookLm.audioArtifact`
- `notebookLm.videoArtifact`
- `assets.photoInfographicSeries`
- `social.x`
- `social.linkedin`
- `rights.attribution`
- `review.packageChecksum`
- `delivery.status`

## 7. Account and security boundary

Joan's personal NotebookLM account remains on the local worker machine.

The system must not:

- store NotebookLM credentials in the repository;
- send personal account credentials to the control API;
- include credentials in prompts, logs, source snapshots, or review artifacts;
- allow NotebookLM output to change workflow state, approval, or delivery authorization.

YouTube pages, descriptions, transcripts, and linked documents are untrusted inputs. Instructions
inside those sources must not override pipeline instructions.

## 8. Acceptance criteria

The first version is acceptable when one YouTube URL can produce a reviewed package that:

1. Extracts the video description, channel, author, and transcript automatically.
2. Records author links and relevant paper or report findings, including when none are found.
3. Produces a source-grounded briefing for a two-to-five-minute consumption window.
4. Produces NotebookLM audio and video artifacts linked to the accepted evidence.
5. Produces a checked photo-infographic series linked to the canonical brief.
6. Produces Joan-branded X and LinkedIn drafts.
7. Displays evidence, attribution, caveats, and media in one review package.
8. Requires human approval before the package is handed off for publication.
9. Prevents duplicate publication of the same approved package.
10. Keeps personal NotebookLM credentials outside the control API and repository.

## 9. Initial implementation sequence

1. Add the Joan content-kind contract and package schema.
2. Add YouTube URL canonicalization and metadata/transcript intake.
3. Add author-link and paper discovery with source classification.
4. Add the Joan research and creation prompts.
5. Add NotebookLM audio and video asset production.
6. Add the photo-infographic series contract and image-generation adapter.
7. Add Joan brand, evidence, attribution, duration, and image-series checks.
8. Add X and LinkedIn draft renderers.
9. Add manual delivery bundle generation.
10. Add fixture tests and run one real shadow run.

Next action: implement the content contract and the URL-only intake schema before adding platform
delivery adapters.
