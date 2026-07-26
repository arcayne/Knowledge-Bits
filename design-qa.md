# Design QA - Nuglet Short Focus Aperture end card

Source visual truth: `/Users/dearkane/.codex/generated_images/019f9d8a-1f52-7f41-8e37-bdc5cfd148cb/call_4UgzF0vS9fPKX7r3gMN8Y6cs.png`

Implementation screenshot: `/Users/dearkane/Documents/dev/nuglet/apps/nuglet-lab/outputs/2026-07-01-protect-your-attention/public-preview/implementation-end-card-focus-aperture.png`

Full-view comparison: `/Users/dearkane/Documents/dev/nuglet/apps/nuglet-lab/outputs/2026-07-01-protect-your-attention/public-preview/design-qa-comparison-focus-aperture.png`

Viewport and normalization:

- Source: 941x1672 pixels, normalized to 720x1280.
- Implementation: 720x1280 pixels extracted from the rendered MP4 at 56.5 seconds.
- Comparison canvas: both 720x1280 frames at 1x density, separated by a 20-pixel gutter.
- State: settled final end-card frame.

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: the implementation uses the real bundled Nuglet Fraunces display face and Bricolage Grotesque body faces. The generated reference uses a slightly finer synthetic serif; retaining the production brand typeface is an intentional and acceptable difference.
- Spacing and layout rhythm: aperture, two-line title, support copy, CTA pill, and wordmark follow the selected vertical hierarchy and remain inside mobile-safe margins.
- Colors and visual tokens: warm paper, ink, moss, white, and clay match the selected concept and Nuglet brand direction.
- Image quality and asset fidelity: the production plate preserves the tactile Focus Aperture art direction at native 720x1280. The final wordmark is the real Nuglet raster asset rather than generated logo art.
- Copy and content: title, supporting line, and CTA are exact deterministic text with no generated spelling or wording.
- Focused-region comparison was not needed because all typography, the CTA, and the wordmark are readable at the full native frame resolution.

## Comparison history

1. Initial implementation:
   - P1: text layers were left-aligned despite the centered selected hierarchy.
   - P2: the first cleanup plate shifted the aperture and CTA vertically.
   - Fixes: centered each deterministic text layer from measured raster bounds, corrected all proportional positions, and regenerated the clean plate against the selected frame.
2. Font-portability implementation:
   - P2: macOS Pango fell back to a generic sans when the compositor loaded bundled fonts directly.
   - Fix: added bundled static Fraunces and Bricolage instances plus an isolated fontconfig file, and rasterized exact text through the FT2 backend before composition.
3. Final comparison:
   - No actionable P0/P1/P2 findings.

## Follow-up polish

- P3: a future motion pass could animate the scattered dots settling into the coral focus point during the first 200-300 milliseconds of the outro. The current three-second static hold is clear and production-safe.

final result: passed
