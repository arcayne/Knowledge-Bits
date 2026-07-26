# Design QA - Nuglet Short topic-specific outro artwork

Source visual truth: `/var/folders/02/32n0k_15605cvhl_j9vwg2m00000gn/T/codex-clipboard-efe3d69b-95cc-46b7-bf2a-e27a93ace0c7.png`

Implementation screenshot: `/Users/dearkane/Documents/dev/knowledge-bits/.local-artifacts/notebooklm-short-reviews/hard-book-v3-topic-outro-frame.png`

Full-view comparison: `/Users/dearkane/Documents/dev/knowledge-bits/.local-artifacts/notebooklm-short-reviews/hard-book-v3-topic-outro-comparison.png`

Viewport and normalization:

- Reference and implementation are compared as settled vertical end-card frames.
- Implementation: 720x1280 pixels extracted from the rendered review MP4.
- Comparison canvas: old default Focus Aperture outro and new topic-specific outro at the same viewport and state.

## Findings

No actionable P0, P1, or P2 differences remain.

- Hierarchy: the established image, title, supporting line, CTA, and Nuglet wordmark order is unchanged.
- Topic specificity: the generic Focus Aperture illustration is replaced by the Nuglet's approved hero artwork, presented as a mounted editorial print rather than a stretched background.
- Typography and tokens: the existing bundled Nuglet typefaces, warm paper, ink, clay CTA, spacing, and safe margins are preserved.
- Image quality: the approved hero is cropped proportionally and contained inside the available upper image region without distortion.
- Copy and branding: deterministic title, supporting line, CTA, and real Nuglet wordmark remain compositor-owned, so provider-generated spelling cannot affect the outro.
- Pipeline safety: migrated hero artwork is accepted only after its immutable receipt checksum, byte size, and media type are verified. A hero generated in the same job is reused directly.
- Fallback: jobs without usable hero artwork retain the existing Focus Aperture default.
- Transition: the topic card crossfades over 450 milliseconds, becomes fully visible while the final narration continues for 650 milliseconds, and then remains readable for the existing three-second hold.

## Comparison history

1. Initial topic-art implementation:
   - P2: a small portion of the default aperture remained visible behind the framed hero.
   - Fix: expanded the clean warm-paper cover layer across the full upper art region.
2. Final comparison:
   - No actionable P0/P1/P2 findings.
3. Ending polish:
   - P2: the card previously appeared in a single frame after the final spoken line.
   - Fix: added a bounded 450-millisecond visual crossfade without shortening the full-opacity card hold.
4. Voice-over carry:
   - P2: fading the narration with the visual transition weakened the final words and made the ending still feel abrupt.
   - Fix: preserve the narration at full level while the card arrives, keep 650 milliseconds of voice over the fully visible card, and use only a 120-millisecond terminal audio fade to avoid a click.

## Follow-up polish

- P3: a future motion pass could add a subtle scale or parallax settle to the topic artwork. The current static hold is clear and review-safe.

final result: passed
