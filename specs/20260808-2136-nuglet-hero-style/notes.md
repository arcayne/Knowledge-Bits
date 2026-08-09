# Run notes

- The Second Shift currently fails at `produce_assets` with `hero_visual_conformance_failed` and has no queued job.
- The human-facing draft says `split-screen`; the stored metaphor says `carrying two heavy briefcases`.
- The live worker currently reduces the three curated references to 96x96, blur-10 swatches. This preserves palette/texture but loses visible linework and painted shadows.
- The user approved an uninterrupted fix and asked to retry only this run.

## Implementation update

- Live supervisor style plates now use 384x384 cover crops with light softening (blur 1.5), preserving linework, watercolor variation, paper grain, and painted shadows while explicitly forbidding subject/layout copying.
- Hero generation and the visual critic now name those curated-style invariants and fail style drift into vector, photorealistic, or flattened rendering.
- Focused media tests pass: 20/20 in the supervisor checkout and 14/14 in the main checkout.
- No retry was queued because the run's authoritative checked brief still requests the old split-screen/briefcase metaphor; retrying before that brief is revised would be semantically unsafe.

## Retry result

- Retried only run `369a7f6a-5e62-4021-990e-172edccfb9cd`; one worker job completed successfully and returned the package to `human_review` with checksum `6094f54b8d9be57419af52d4ba4177d36aaaaa46f60dde332c7ad31722f07a81`.
- New hero artifact: `38585f0c-6c93-4519-8c39-96f553feda74`.
- Visual inspection confirms the curated cream-paper, watercolor, graphite-contour style is back. The scene is still semantically off (a man and child at a desk rather than the stored split-screen/briefcase direction), so it should not be approved yet.
