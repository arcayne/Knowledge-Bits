# Joan AI video quality evaluation

## Objective

Build a quality-evaluation layer for the Joan AI video pipeline.

The evaluation layer must determine whether a run is:

- source-grounded;
- complete enough for a two-to-five-minute briefing;
- faithful across the canonical brief, audio, video, infographic series, and social drafts;
- compliant with the media and attribution requirements in
  `docs/JOAN_AI_VIDEO_PIPELINE_SPEC.md`;
- safe to present for human review;
- an improvement over the selected prompt and model baseline.

The first YouTube use case is a smoke test and a regression case. It is not sufficient by itself
to establish a prompt or model baseline.

## Current state

The first use-case run is blocked in the logical `research` stage. The worker action is
`collect_sources`. The worker does not have a real NotebookLM notebook ID or account session.

The existing evaluation package supports:

- immutable evaluation cases and corpus checksums;
- prompt and recipe provenance;
- hard gates for unsupported claims, citation binding, prompt injection, unsafe advice, and
  package delivery;
- trusted baseline comparison.

The existing `evals/knowledge-bits.v1` corpus is Nuglet-focused. It does not cover Joan media
quality, four-to-eight-card infographic constraints, two-to-five-minute duration, or cross-format
consistency.

The evaluation work must support fixture-backed execution before NotebookLM is configured. Live
provider evaluation remains blocked until notebook provisioning and the local account session are
available.

## Scope

### In scope

- Add a Joan-specific evaluation corpus and manifest.
- Add deterministic checks for research, canonical brief, media, package, and provenance
  requirements.
- Add structured evaluation results for audio, video, infographic, and social outputs.
- Add subjective human-review labels for editorial and media quality.
- Compare candidate runs with a trusted baseline using identical inputs and provenance.
- Record prompt, recipe, provider, model, and input checksums for every experiment.
- Add regression cases for confirmed prompt or provider failures.
- Support blind pairwise comparison for subjective prompt improvements.

### Out of scope

- NotebookLM notebook provisioning.
- Automatic publication to X or LinkedIn.
- Automatic approval of a package.
- Replacing human review with an LLM score.
- Pixel-level comparison of generated images.
- Optimising prompts from one source video without a broader evaluation set.

## Stage mapping

Use the repository action names in implementation and the Joan logical stage names in reports:

| Joan stage | Worker action | Evaluation boundary |
|---|---|---|
| `research` | `collect_sources` | accepted evidence and immutable source snapshots |
| `create` | `create_content` | canonical Joan briefing and visual sequence |
| `check` | `check_content` | checked brief, claims, citations, attribution, constraints |
| `produce_assets` | `produce_assets` | audio, video, infographic series, social drafts |
| `human_review` | review state | package checksum and reviewer decision |

## Evaluation decision model

Evaluation is lexicographic.

1. Run deterministic contract checks.
2. Fail the candidate when a hard gate fails.
3. If all hard gates pass, compare soft quality scores with the trusted baseline.
4. Use blind human review for subjective dimensions.
5. Promote a new baseline only after the candidate passes the complete corpus and receives human
   approval.

An average score must not hide a hard failure. An output with strong style and an unsupported
  material claim fails.

## Hard gates

### Research and evidence

- A usable transcript or equivalent source content is present.
- The transcript and every accepted source have immutable snapshots and checksums.
- Author-provided links are recorded, including an explicit empty result.
- Each accepted source has a relationship classification and attribution metadata.
- Search-result metadata is never treated as accepted evidence.
- Instructions in YouTube pages, transcripts, and linked documents do not control the pipeline.
- Research cannot produce a confident summary from metadata alone.

### Canonical brief and check

- Every material factual claim maps to accepted evidence.
- Critical unsupported claims: zero.
- Citation-source binding failures: zero.
- Invented statistics, quotes, papers, citations, or certainty: zero.
- Video-author claims and independent evidence are distinct.
- Joan commentary is distinct from source claims.
- The brief contains the required first-use-case topic signals when supported by the source:
  agent-ready requirements, vertical slices, test-driven development, autonomous coding agents,
  and agent-effective codebases.
- The content has enough substance for the configured two-to-five-minute target.
- The card plan contains four to eight cards and does not contain padded cards.

### Media and package

- Audio and video are generated from the checked canonical brief checksum.
- Actual audio and video duration are measured and within the configured tolerance.
- Every infographic card is 1080x1350 pixels in 4:5 portrait format.
- Every card has one main idea, one evidence boundary, title, alt text, text equivalent, and valid
  claim references.
- Card copy contains no fact that is absent from the checked canonical brief.
- Audio, video, cards, X, and LinkedIn do not introduce conflicting factual narratives.
- Attribution, disclosure, rights notes, and source links are present.
- The package checksum covers the accepted source set, canonical brief, generated media, social
  drafts, and delivery metadata.
- A media or content change invalidates the previous approval checksum.

## Soft quality rubric

Score each dimension from 1 to 5. Record the evaluator, rubric version, and evidence for every
score.

### Brief quality

- source coverage;
- factual faithfulness;
- salience and prioritisation;
- compression quality;
- explanation clarity;
- uncertainty and caveat quality;
- Joan voice;
- usefulness to an AI-curious professional or builder.

### Audio and video quality

- factual faithfulness to the checked brief;
- coverage of the key ideas;
- intelligibility;
- pacing;
- structure;
- usefulness without returning to the source video;
- absence of unsupported claims or misleading emphasis.

### Infographic quality

- one clear idea per card;
- sequence coherence;
- standalone comprehension;
- text readability;
- visual hierarchy;
- evidence-bound wording;
- useful differentiation between cards;
- brand consistency.

### Package quality

- cross-format consistency;
- attribution clarity;
- reviewer confidence;
- reviewer correction count;
- reviewer time to approve or reject.

Initial soft-score guidance is four out of five on critical dimensions and 3.5 out of five overall.
These thresholds must be calibrated after at least ten labelled source cases. A candidate must not
decrease a critical dimension by more than 0.5 against the trusted baseline.

## Joan evaluation corpus

Add the following directory:

```text
evals/joan-ai-video.v1/
├── manifest.json
├── provenance.json
├── sources/
├── cases/
├── labels/
└── baselines/
```

Each case must contain:

- a source snapshot or a checked canonical brief fixture;
- the expected evidence and claim references;
- expected structural constraints;
- hard-gate labels;
- subjective rubric labels where applicable;
- source and label checksums.

The initial corpus must include at least these case families:

1. research completeness;
2. transcript and source-boundary handling;
3. claim grounding and citation binding;
4. unsupported statistics and false certainty;
5. prompt injection in a source document;
6. briefing compression and key-idea coverage;
7. two-to-five-minute duration handling;
8. audio and video cross-format consistency;
9. infographic card count and card-level grounding;
10. infographic readability and standalone comprehension;
11. social attribution and disclosure;
12. package checksum and approval invalidation.

The first Joan video must be included as a regression case after its source and transcript are
captured as immutable artifacts. Do not use search-result metadata as the case source.

## Evaluation result and provenance

Every candidate evaluation must record:

- candidate commit or immutable candidate identifier;
- trusted baseline ID and checksum;
- corpus checksum;
- logical stage and worker action;
- source-set checksum;
- canonical brief checksum;
- generation-plan checksum;
- prompt version and rendered prompt checksum;
- recipe version and checksum;
- provider and model identity;
- output artifact checksums;
- deterministic gate results;
- soft rubric scores;
- human comparison result where required.

Extend the evaluation provenance manifest to include Joan prompts and media recipes. The current
provenance map for `research`, `create`, and `check` is not sufficient for media prompt experiments.

## Media-generation evaluation

Evaluate media against the checked brief, not against raw source text alone.

### Audio and video

- Measure actual duration.
- Transcribe the generated audio and video when the provider does not supply a transcript.
- Check claim entailment against the checked brief and accepted evidence.
- Check key-idea coverage.
- Check unsupported additions, omissions, and misleading emphasis.
- Use human review for pacing, intelligibility, and usefulness.

### Infographic series

- Validate dimensions and file integrity deterministically.
- Validate card count against the checked visual sequence.
- Validate each card's claim references.
- Use OCR or an equivalent text extraction check for text presence and overflow.
- Compare card meaning with the checked brief using claim-level evaluation.
- Use human review for readability, hierarchy, sequence, and visual usefulness.

Do not use image byte similarity as the quality metric. Do not require the generator to invent or
render factual copy. The checked card copy is authoritative. The visual prompt controls composition,
style, and layout only. Use a deterministic text layer for important factual text when the media
adapter supports it.

## Prompt-improvement protocol

Every prompt experiment must use a fixed source snapshot, checked brief, generation plan, provider,
and model unless the experiment explicitly targets one of those variables.

Each experiment records:

- experiment ID;
- hypothesis;
- changed prompt or recipe section;
- baseline prompt checksum;
- candidate prompt checksum;
- fixed input checksums;
- provider and model;
- expected failure mode to improve;
- hard-gate result;
- baseline and candidate soft scores;
- blind human comparison;
- decision and rationale.

Use one substantive prompt change per experiment. A confirmed failure becomes a regression case
before the prompt is promoted.

Keep stable policy instructions separate from experimental style instructions. The stable media
policy must state:

- use only the checked canonical brief;
- do not add facts, numbers, quotes, citations, or attribution;
- preserve claim boundaries and caveats;
- produce the required artifact structure;
- return structured metadata for validation.

The experimental section may change visual treatment, pacing, ordering, tone, or composition.

## Implementation sequence

1. Add the Joan evaluation corpus structure, manifest, provenance file, and case contracts.
2. Add deterministic Joan checks to the evaluation package.
3. Add structured media evaluation for duration, dimensions, card metadata, artifact checksums,
   and cross-format input checksums.
4. Add claim-level consistency checks for audio, video, cards, and social drafts.
5. Add the Joan rubric and blind pairwise human-review artifact.
6. Extend baseline comparison to include Joan media prompts, recipes, and provider identity.
7. Add fixture-backed cases that run without NotebookLM.
8. Configure NotebookLM provisioning and capture the first video's immutable source artifacts.
9. Run the first live Joan evaluation and convert confirmed failures into regression cases.
10. Build a broader set of at least ten labelled source cases before promoting a baseline.

## Non-goals

- Do not publish or deliver the first use case.
- Do not approve a package automatically.
- Do not promote a prompt based only on an LLM judge score.
- Do not tune media prompts while regenerating the canonical brief in the same experiment.
- Do not compare media outputs only by visual similarity, byte equality, or duration.
- Do not bypass the `check` stage before `produce_assets`.

## Acceptance criteria

1. `evals/joan-ai-video.v1` loads with checksum validation.
2. The corpus contains all twelve initial case families.
3. Joan hard gates produce deterministic pass/fail results.
4. Media checks validate duration, dimensions, card count, card references, and input checksums.
5. Cross-format checks detect a factual change between the checked brief and a generated asset.
6. Prompt and recipe checksums appear in every candidate evaluation.
7. A provider-backed evaluation cannot run without explicit provider and model identity.
8. A prompt experiment can compare baseline and candidate outputs with identical inputs.
9. A failed hard gate prevents baseline promotion.
10. A blind human comparison is required for subjective baseline promotion.
11. Fixture-backed evaluation passes without a NotebookLM account session.
12. The first live Joan run remains blocked until a real notebook ID and account session exist.

## Verification

Run the focused evaluation checks:

```text
corepack pnpm --filter @knowledge-bits/contracts typecheck
corepack pnpm --filter @knowledge-bits/pipeline build
corepack pnpm --filter @knowledge-bits/evaluation typecheck
corepack pnpm --filter @knowledge-bits/evaluation build
corepack pnpm --filter @knowledge-bits/evaluation test
```

Also verify:

- corpus and baseline checksums;
- deterministic report checksums;
- hard-gate regression cases;
- media fixture validation;
- prompt provenance containment;
- `git diff --check`.

## Next action

Implement the corpus contracts and deterministic Joan checks first. Use fixture-backed outputs until
NotebookLM provisioning is available. Then capture the first video's immutable evidence and run the
live evaluation.
