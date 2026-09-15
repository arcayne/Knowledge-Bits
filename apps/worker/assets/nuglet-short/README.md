# Nuglet Short end-card assets

These assets are deterministic post-production inputs for NotebookLM public previews.

- `focus-aperture-end-card.png` is the approved 720x1280 Option 1 background plate. It contains no generated text or logo; the worker adds exact copy and the real Nuglet wordmark during rendering.
- `nuglet-logo.png` is the production Nuglet wordmark copied from `apps/web/public/logo.png` at Nuglet commit `f49f46e67a16cb5bbf910b443ac3443473f4e876`.
- `FrauncesDisplay.ttf`, `BricolageGrotesqueRegular.ttf`, and `BricolageGrotesqueSemibold.ttf` are static Nuglet display and social font instances derived from the Google Fonts variable files. Both families are distributed under the SIL Open Font License included beside them.
- `fonts.conf` makes those bundled fonts available to the deterministic text rasterizer without installing them on the worker machine.

Asset checksums:

- `focus-aperture-end-card.png`: `sha256:bbd0a5da9126fbd840a168f45ed9a0f73fffba685d54b5c4ae6c835b29bea775`
- `nuglet-logo.png`: `sha256:72b55bd19cd9848b5e9c46ed3e1d95c544740c32e8f260ebaf5d2aefc863d52e`
- `FrauncesDisplay.ttf`: `sha256:4b65351fa83c651e440ee1920b548d035ee0fec869d9e3b2e5060bc89cfc3963`
- `BricolageGrotesqueRegular.ttf`: `sha256:1695b3a09c66aa34740421cc0d5f49197595c107a4af3cd4144a1422b11539ac`
- `BricolageGrotesqueSemibold.ttf`: `sha256:253a631761caaa65534e9a0be25346cbd41125396a2ef6f6b993220cd4a8d1f8`
