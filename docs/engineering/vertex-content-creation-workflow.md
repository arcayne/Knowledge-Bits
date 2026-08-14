# Vertex content creation workflow

Status: adopted for the initial workflow
Owner: Knowledge Bits
Date: 2026-08-14

## Decision

Knowledge Bits uses its Vertex AI integration as the generation backend for new media content. This includes the visual and video experiments for Nuglet social assets.

ChatCut is not the generation backend for this workflow. We may use ChatCut after generation for timeline assembly, audio placement, captions, visual review, and export. A ChatCut project is optional and must not be required to produce the source media asset.

This decision starts the Knowledge Bits content creation workflow.

## Scope

The workflow covers media that begins with an approved Knowledge Bits content brief and may become a Nuglet Moment, a public preview, or another approved asset.

The first slice is a short vertical video that carries a focused learning moment from an approved Nuglet conversation. The visual action should support the idea in the audio. The source video and the podcast excerpt remain separate assets until the edit is approved.

## System boundary

Knowledge Bits owns:

1. The content brief and source evidence.
2. The generation prompt, visual constraints, and negative constraints.
3. The Vertex AI request and provider configuration.
4. The operation record, model identity, prompt, output bytes, checksum, and provenance.
5. Deterministic checks and human review status.
6. The approved package sent to Nuglet.

Vertex AI generates:

1. Images and video clips.
2. Native video audio when the selected model supports it.
3. Other model outputs that the recipe explicitly allows.

ChatCut may perform the following downstream work:

1. Import a generated Vertex asset.
2. Place a selected podcast excerpt against the video.
3. Add captions, timing, and an end card.
4. Adjust the mix and inspect the edit.
5. Export a review or publishing file.

ChatCut must not silently replace the Vertex request with its own video generation feature. If a different provider is selected, record that choice in the generation plan and provenance.

## Workflow

1. Create an approved content brief with the Nuglet concept, audience, learning moment, and source bounds.
2. Select the media recipe and define the intended format, duration, aspect ratio, audio mode, and visual constraints.
3. Write the Vertex prompt. Describe one clear physical action, one stable object set, and one camera behavior. Add constraints that prevent text, logos, watermarks, accidental hands, and unrelated objects when the recipe requires them.
4. Submit the request through the Knowledge Bits worker and Vertex adapter. Do not generate the production asset from ChatCut.
5. Persist the provider operation, model, location, prompt, input references, and recipe version before the result is accepted.
6. Retrieve the output through the worker. Store the exact bytes and checksum as an immutable artifact.
7. Run media checks for dimensions, duration, playable output, audio presence when requested, and basic visual or transcript requirements.
8. Review the asset in Knowledge Bits. Keep rejected or uncertain output at `needs_human` and do not deliver it.
9. If an edit is needed, import the accepted Vertex asset into ChatCut or another editing surface. Keep the generated source and the edited derivative as separate artifacts.
10. Approve the final package before Nuglet delivery or social publication.

## Provenance requirements

Every generated asset must retain:

1. The Knowledge Bits run and asset identifiers.
2. The recipe and generation plan versions.
3. The provider name, model name, project, and location when available.
4. The complete generation prompt and negative constraints.
5. Input image or video references and their checksums.
6. The provider operation identifier and seed when the provider returns them.
7. Output media type, dimensions, duration, byte size, and checksum.
8. Review status and the human approval record.
9. The relationship to any ChatCut project or edited derivative.

Do not place credentials, access tokens, or private provider responses in the prompt or in a public asset package.

## Current implementation anchor

The current repository already exposes media production through the local worker command configured by `MEDIA_GENERATION_COMMAND` and `MEDIA_GENERATION_ARGS`. The worker media adapter and `apps/worker/scripts/nuglet-media-command.mjs` use Vertex for the supported image, infographic, transcription, and visual review paths. This document extends that existing boundary to the new short video creation workflow.

The durable workflow ledger remains in Knowledge Bits. It does not run Vertex or ChatCut. The local worker performs provider calls and writes stage results through the control API.

The current Nuglet media contract does not yet define a dedicated Nuglet Moment video kind. The first red ball execution is therefore a Vertex prototype with external evidence files. Before this becomes a normal worker run, add a versioned recipe, asset kind, artifact checks, and review projection for the source video and its edited derivative.

## First experiment

Use the approved Nuglet conversation as the source for a short social clip.

1. Select one sentence or exchange that creates curiosity without giving away the complete lesson.
2. Generate a short vertical visual through the Vertex Veo path with one coherent, repeatable action.
3. Keep the first eight seconds understandable without the full conversation.
4. Add the selected audio excerpt only after the visual passes its own review.
5. Add captions and the Nuglet end card in the editing step.
6. Compare the final edit with the source Vertex asset and retain both.

The success criterion for this experiment is a repeatable Knowledge Bits workflow that can produce and review the source video without ChatCut. ChatCut can remain the convenient editing surface, but it is not a dependency for generation.
