# Public release rights inventory

Date: 2026-09-15
Owner: `@arcayne`
Decision: Nuglet information may be public. The candidate includes project-owned Nuglet material and excludes live-account migration state and unverified external source material.

MIT covers project-owned software and general documentation. It does not grant third-party rights, font rights, copyright in external source material, or trademark rights.

| Candidate area | Evidence reviewed | Public disposition | Terms and control |
| --- | --- | --- | --- |
| `apps/worker/assets/nuglet-short/*.ttf` | Adjacent OFL texts and asset README | Include | SIL Open Font License 1.1; retain both notices. |
| `apps/worker/assets/nuglet-short/focus-aperture-end-card.png` | Asset README and checksum | Include | Owner-authorized Nuglet artwork; MIT does not grant trademark or endorsement rights. |
| `apps/worker/assets/nuglet-short/nuglet-logo.png` | Asset README identifies source Nuglet commit and checksum | Include for repository examples | Owner-authorized brand use; Nuglet marks remain reserved trademarks. |
| `apps/worker/assets/nuglet-style/*.png` | Tracked project assets and checksums | Include | Owner-authorized project-owned examples; no third-party license claim is made. |
| `recipes/nuglet.lesson.v1/**` and `apps/worker/src/prompts/**` | Repository-authored recipes and prompts; no external source snapshots embedded | Include | Project-owned configuration/documentation under MIT unless a future file states separate terms. |
| `docs/NUGLET_KNOWLEDGE_BITS_PRODUCT_GROWTH_STRATEGY.md` and `.docx` | Project-authored strategy documents; Nuglet publication authorized by owner | Include | Project documentation under MIT; no third-party source text is intentionally included. |
| `examples/local-demo/**` and fixture JSON | Synthetic example source and deterministic fixture responses | Include | Project-owned synthetic material under MIT. No external source is fetched. |
| `examples/nuglet-migrations/**` | 31 migration inventories; local paths, external media references, and live NotebookLM registry | Exclude | Removed from candidate; not a public source or rights record. |
| Generated audio/video and provider output | Candidate file inventory contains no audio/video binaries | Exclude by default | Future output requires provider terms, source rights, and a recorded release decision. |
| External sources and source snapshots | No redistributable source snapshots selected for the demo | Exclude | A URL or product name is not a redistribution grant. Add only with provenance and rights evidence. |

## Brand and copyright notice

The public candidate may show Nuglet marks in its examples because the repository owner authorized public Nuglet information. This permission does not grant a license to use Nuglet branding as a product name, endorsement, or trademark outside the repository's documented examples.

The repository license uses `arcayne` as the current GitHub owner and copyright holder. Replace that handle with the owner's legal or registered copyright name before publishing if they want the notice to identify a legal entity.

## Release rule

Every new binary, source snapshot, prompt corpus, recipe, or media file must be added with its owner, source, license or permission basis, and whether MIT applies. Unclassified material stays out of the public candidate.
