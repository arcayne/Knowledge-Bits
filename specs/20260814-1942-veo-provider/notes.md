# Run notes

## Intake

- User approved starting the separate Veo implementation after open-PR triage.
- Existing open PR #51 changes media materialization and review for the V2 narrative contract, but does not implement Veo or Omni.
- Work is isolated in `/Users/dearkane/Documents/dev/.worktrees/knowledge-bits-veo-provider` on branch `codex/veo-provider`.

## Self-critique

- The prototype is intentionally not connected to `public_preview`. That avoids treating an 8-second silent source clip as a complete public lesson preview.
- The command uses ADC only. It does not fall back to the known-blocked Gemini API key path.
- The command stores operation data only in an operator-controlled output directory. The emitted result is sanitized provenance.

## Implementation log

- Added the Vertex client, prototype command, provenance sidecars, environment contract, and focused tests.
- Focused Veo tests: passed (7 tests).
- Worker typecheck: passed.
- Worker build: passed.
- Existing worker suite: 180 passed, 3 cancelled in unrelated `engine-client` timeout/lease tests under Node 22; no test failed.
- Real `ffprobe` validation: passed for the latest known Veo MP4 at 720x1280 and 8 seconds.
