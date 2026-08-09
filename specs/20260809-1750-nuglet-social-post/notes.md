# Notes

- Current Story/Playbook payload has no social field; the canonical base shape ends at `claimCoverage`.
- `public_preview` is a separate media artifact, so caption copy should not be stored only in video metadata.
- The content and video must be represented as a companion pair: store the post once in canonical content and bind the video to the exact content/social-post checksums in the package/asset representation.
- The current Protect Your Attention package is already approved and delivered. Adding canonical content requires a new review revision; the historical delivered package must remain unchanged.
- Existing working-tree changes predate this spec and are intentionally untouched.

## Implementation notes

- The Story/Playbook contract accepts the optional field for backwards-compatible reads, while deterministic QA requires it for new 1.1.0 content.
- The create prompt, semantic repair preservation list, fixtures, and review/package schemas now carry the field.
- Public-preview generation records a checksum of the canonical social post in artifact provenance. The review asset and artifact inventory expose companion checksums for the content and post; stale media input checks still bind the video to the full generation input.
- Review UI shows the exact post next to the Short and provides copy behavior.
- The approved Protect Your Attention package was not mutated. A safe strict-content revision route is still required for its backfill.
- The active Protect Your Attention test payload now uses: `Your attention is shaped by the cues around you. A phone, open tab, or message can quietly pull you into another task. Notice the setup before blaming your focus. #ProtectYourAttention #Focus #WorkHabits`.
