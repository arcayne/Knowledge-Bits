# Nuglet hero style conditioning

## Objective

Restore the curated Nuglet editorial illustration character while keeping subject/layout copying out of the Vertex style references, and make the current Second Shift hero brief use one coherent scene.

## Scope

- Update the worker's style-reference conditioning so palette, paper texture, watercolor edges, linework, and painted shadows survive into the model input.
- Strengthen the hero prompt and visual-review prompt around the curated style and one-action metaphor.
- Replace the Second Shift hero direction with a single handoff scene in the run's semantic brief before retrying its hero.

## Non-goals

- Do not regenerate other runs.
- Do not change infographic, audio, research, or delivery behavior.
- Do not bypass the visual conformance reviewer.

## Acceptance criteria

1. Style references retain visible linework and wash/shadow structure rather than only a 96x96 blurred color swatch.
2. The prompt explicitly separates style guidance from subject/layout guidance.
3. The reviewer rejects style drift (photorealism, vector/icon treatment, hard edges, saturated/high-contrast rendering, or missing watercolor linework).
4. The Second Shift brief uses `asymmetrical-story`, one handoff action, and no split-screen/briefcase composition.
5. Focused worker media tests pass.
6. Only The Second Shift is retried after the fix.

## Risks and mitigations

- Fuller references can cause subject copying: use a reduced-detail style plate plus explicit style-only instructions, and retain the critic gate.
- A bad semantic brief can still produce a coherent but wrong image: make the brief concrete and align its composition family with the generation plan.
- Vertex failures remain recoverable: failed candidates stay `needs_human` and are never delivered.

## Verification

- Run `pnpm --filter @knowledge-bits/worker test:media-command`.
- Inspect the generated prompt and visual-review receipt.
- Retry only run `369a7f6a-5e62-4021-990e-172edccfb9cd` and verify it returns to human review with a new hero artifact.
