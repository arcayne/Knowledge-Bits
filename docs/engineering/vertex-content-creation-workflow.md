# Vertex content creation workflow

## Decision

Knowledge Bits owns the content brief, prompt, provider operation, output checksum, provenance, deterministic checks, and human review. Vertex AI is the generation backend for the initial Nuglet video experiment. ChatCut is an optional downstream editor for audio placement, captions, end cards, review, and export.

ChatCut must not replace the Vertex request with its own generation feature. The generated Vertex source and any edited derivative remain separate artifacts.

## Prototype boundary

The first implementation is `apps/worker/scripts/nuglet-veo-command.mjs`. It uses the compiled `apps/worker/src/providers/veo.ts` client, Vertex ADC, and a bounded Veo operation poll. It writes operator-controlled request, operation, metadata, and MP4 files, then emits a `needs_review` result.

This prototype is not wired to the current `public_preview` kind, Nuglet delivery, or a dedicated video artifact recipe. The current public preview remains a longer, audio-bearing asset with its existing review and protected-content gates.

## Generation requirements

Before generation, define one visual action, one stable object set, camera behavior, duration, aspect ratio, audio mode, and forbidden elements. Use the default portrait settings of 9:16, 720p, 8 seconds, one output, and no generated audio unless the brief requires a change.

Record the provider, model, project, location, prompt, prompt checksum, input checksums, operation identifier, output dimensions, duration, byte size, and output checksum. Keep the result at `needs_review` until a human accepts the source video.

## Next integration

After review of the prototype, add a dedicated Nuglet video recipe and artifact kind. Then wire the provider into the worker media contract and add ChatCut import as a separate derivative step.
