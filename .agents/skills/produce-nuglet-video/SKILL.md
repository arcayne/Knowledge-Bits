---
name: produce-nuglet-video
description: Turn a Nuglet idea, approved lesson, or podcast excerpt into a review ready short video through the Knowledge Bits Vertex AI integration. Use when an operator wants to move from concept to brief, audio hook, Vertex video candidates, human review, and optional ChatCut assembly. Do not use this skill to publish, deliver, or approve a Nuglet.
---

# Produce a Nuglet video

Use this skill to move one Nuglet idea through a controlled video production flow. Keep the generated source asset in Knowledge Bits. Use ChatCut only as an optional downstream editor. The current worker contract does not yet define a dedicated Nuglet Moment video kind, so treat direct Vertex tests as prototypes until the recipe and artifact contract exist.

## Result

Produce:

1. A concise video brief.
2. A selected audio hook from an approved Nuglet conversation, when available.
3. Three or four Vertex video candidates.
4. Stored generation provenance for every candidate.
5. One review ready source video, plus an optional edited derivative.
6. A clear human review decision and next action.

Do not claim that an asset is generated, reviewed, approved, published, or delivered without evidence from the relevant system.

## Workflow

### 1. Read the idea

Extract what the operator provided:

1. Nuglet title or working concept.
2. Learner insight or question.
3. Source run, lesson, or conversation.
4. Candidate audio excerpt.
5. Intended channel and format.
6. Existing visual reference or experiment.

Ask only for blockers. If the source conversation or audio is not approved, create the brief and mark that input as pending. Do not invent a source run, transcript, claim, or approval.

### 2. Write the video brief

Define the following before generation:

1. The idea the viewer should understand within the first eight seconds.
2. The first visual event in the first second.
3. One object set and one physical action.
4. The start state, movement path, and end state.
5. Camera position and movement.
6. Duration, aspect ratio, and audio mode.
7. Forbidden elements such as text, logos, watermarks, accidental hands, unrelated objects, or camera shake.

For an oddly satisfying visual, prefer a continuous action with a visible change in state. Describe how the motion begins, continues, and resolves. Do not ask the model to improvise a second action after the first one finishes.

Default short form settings are vertical 9:16, 7 to 8 seconds, one coherent action, and no generated text. Change them only when the brief requires it.

### 2A. Apply the brand gate

Do not generate until the visual reference passes this gate.

1. Compare the reference with two recent approved Nuglet videos or scene images.
2. Require tactile materials, natural light, visible surface detail, and a clear physical object.
3. Reject flat illustrations, vector scenes, diagrams, infographic layouts, generic 3D product renders, and assets that look like presentation graphics.
4. Reject an anchor that was created for an older campaign when its visual language does not match the current approved work.
5. Record the approved reference paths and the reason the scene belongs to the current Nuglet visual family.

If no reference passes, stop at the brief. Do not try to repair a wrong visual family with a longer generation prompt.

### 3. Select the audio hook

Choose a short excerpt from the approved Nuglet conversation. Prefer a line that creates a concrete question or recognition without explaining the entire lesson.

Check:

1. The words are understandable without the full conversation.
2. The excerpt supports the visual rather than describing unrelated content.
3. The first spoken moment arrives early enough for the intended platform.
4. The excerpt has a transcript and a source asset reference.

Keep the audio decision separate from visual generation. Add the excerpt to the edit only after the source video passes visual review.

Before editing, listen to the exact excerpt with the candidate visual. Do not select audio from a filename, chapter title, or assumed timestamp alone. Record the transcript, in and out points, and the reason the excerpt creates curiosity.

### 4. Generate through Vertex

Use the Knowledge Bits worker and its Vertex adapter for production generation. Use the repository media command and the configured recipe when they support the requested asset. If the current adapter does not support the requested Vertex video operation, stop and identify the bounded adapter change. Do not silently move generation to ChatCut.

Generate three or four candidates. Keep the object set, framing, and camera behavior fixed. Vary one controlled factor at a time, such as movement speed, path, or end state.

Record for each candidate:

1. Knowledge Bits run and asset identifiers.
2. Recipe and generation plan versions.
3. Provider, model, project, and location.
4. Complete prompt and negative constraints.
5. Input references and checksums.
6. Provider operation identifier and seed when returned.
7. Output dimensions, duration, byte size, and checksum.

Never put credentials or private provider responses in prompts or public packages.

### 5. Check and review the source video

Run the available checks for:

1. Playable media.
2. Correct dimensions and aspect ratio.
3. Expected duration.
4. Audio presence when requested.
5. Stable objects and coherent motion.
6. No accidental text, logos, watermarks, or unrelated objects.

Apply these quality gates in order:

1. Brand gate: the output matches the approved tactile visual family and does not look like a diagram or presentation graphic.
2. Motion gate: one object performs one coherent action from start to finish without disappearance, duplication, path breaks, or unexplained resets.
3. Material gate: lighting, texture, object scale, contact, and shadows remain believable.
4. Hook gate: the first second makes the action understandable and the first eight seconds support the audio idea.

Review the source video in Knowledge Bits before editing. Reject candidates that teleport, reverse without a reason, add a second action, lose the focal object, or become less coherent as the clip continues. Keep uncertain output at `needs_human`.

### 6. Assemble an optional edit

Import only the accepted Vertex source asset into ChatCut or another editing surface. ChatCut may:

1. Place the selected podcast excerpt.
2. Mix native and spoken audio.
3. Add captions.
4. Add the Nuglet end card.
5. Export a review file.

Keep the Vertex source asset and the edited derivative as separate artifacts. Do not use ChatCut's video generation feature for this workflow.

The edit is not publication ready until it includes the selected audio, readable captions, the Nuglet end card, and a final human review. A technically playable MP4 is not sufficient.

### 7. Hand off for human review

Return:

1. The brief and source references.
2. The selected audio excerpt and transcript.
3. The Vertex prompts and candidate artifact links.
4. The selected source video and its checksum.
5. The optional edited derivative and its checksum.
6. The checks that passed or failed.
7. The exact human decision required next.

Do not approve, publish, deliver, or open a release PR unless the operator separately asks for that action and the relevant release workflow is followed.

## First execution: red ball experiment

Use the current red ball visual as the first real test of this skill.

1. Choose one approved podcast moment that creates curiosity about the Nuglet idea.
2. Brief a shallow circular board, black balls, one red ball, and a white rake as the stable object set.
3. Ask Vertex to keep the camera fixed and move the red ball along one smooth continuous path.
4. Require consistent speed, natural contact with the other balls, no teleportation, no sudden resets, and one satisfying final placement.
5. Generate three or four candidates with only the path or final placement changed.
6. Review the visual without audio first.
7. Add the selected podcast excerpt in ChatCut only after the visual is accepted.
8. Add captions and the Nuglet end card, then return the edit for human review.

## Repository boundary

Follow [the Vertex content creation workflow](../../../docs/engineering/vertex-content-creation-workflow.md) for provider ownership, provenance, review gates, and the Knowledge Bits to Nuglet boundary. The local worker owns provider calls and stage results. The durable workflow ledger does not run Vertex or ChatCut.
