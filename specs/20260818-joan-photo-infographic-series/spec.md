# Joan photo-infographic series implementation

## Objective

Implement the first Joan content asset as an ordered portrait image series that can be reviewed and delivered independently from NotebookLM video or audio.

## Contract

- Content kind: `joan.photo-infographic-series.v1`.
- Format: 1080×1350 portrait, aspect ratio 4:5.
- Card count: 4–8 inclusive.
- Selection: the count is selected after research from the information structure.
- Padding: prohibited. The series must not add cards only to reach a target count.
- Ordering: sequences are contiguous and start at one.
- Evidence: every card has at least one UUID claim reference.
- Accessibility: every card has `altText` and `textEquivalent`.
- Generation handoff: every card has a stable `assetKind`, `visualDirection`, and `imagePrompt`.

## Implementation slice

1. Add the versioned contract to `@knowledge-bits/contracts`.
2. Add deterministic validation against the checked claim inventory.
3. Route Joan fixture jobs to a committed four-card fixture for the first use case.
4. Preserve the existing Nuglet media adapter and fixture behavior.

## Deliberate boundary

Production image generation and review-package assembly are not included in this slice. They require a Joan content output contract, a provider command or image API configuration, and a review read model that can represent an ordered multi-image asset.
