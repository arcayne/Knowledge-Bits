# Vertex Veo prototype provider

## Objective

Add a bounded Vertex AI Veo prototype path to Knowledge Bits. The path must generate a short source video through `@google/genai`, persist local provenance, validate the returned MP4, and expose a machine-readable result for later integration with a dedicated Nuglet video artifact.

## Non-goals

- Do not replace the current NotebookLM `public_preview` path.
- Do not add a new production media kind or change the delivery contract in this PR.
- Do not add Gemini Omni generation.
- Do not import into ChatCut automatically.
- Do not submit a live generation request in tests or CI.
- Do not approve, deliver, publish, or modify an existing Nuglet run.

## Current state

- The worker owns provider execution and media provenance.
- The current media contract supports `hero`, `infographic`, audio assets, and `public_preview`.
- A short Veo source video is not yet a dedicated contract kind.
- The repository already depends on `@google/genai` for Vertex-backed media work.

## Design

Add `apps/worker/src/providers/veo.ts` as a provider-neutral Vertex Veo client. The client must:

1. Resolve project, location, model, and generation defaults from explicit configuration.
2. Accept a prompt and optional PNG first-frame image.
3. Submit `models.generateVideos` through Vertex AI.
4. Poll `operations.getVideosOperation` with a bounded timeout.
5. Return the MP4 bytes and provider operation metadata.
6. Fail closed on missing configuration, incomplete operations, provider errors, missing video bytes, and invalid configuration.

Add `apps/worker/scripts/nuglet-veo-command.mjs` as a prototype command. It must read one JSON request from stdin, invoke the client, write sanitized request/operation/metadata/result files under a configured output root, and emit one JSON result on stdout. It must record:

- provider and model
- project and location
- prompt and prompt checksum
- input image checksum when present
- operation identifier
- output checksum, byte size, dimensions, duration, and media type
- review status `needs_review`

The command must never write credentials or raw provider responses to the sanitized request or public output. The raw operation may remain in the operator-controlled output directory.

## Configuration

Use these environment variables:

- `GOOGLE_CLOUD_PROJECT_VEO` or `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION_VEO` or `GOOGLE_CLOUD_LOCATION`, default `us-central1`
- `VEO_VERTEX_MODEL`, default `veo-3.1-lite-generate-001`
- `VEO_OUTPUT_ROOT`, default `tmp/veo`
- `VEO_POLL_INTERVAL_MS`, default `10000`
- `VEO_POLL_TIMEOUT_MS`, default `720000`

The prototype must use Vertex ADC. It must not use `GEMINI_API_KEY`.

## Validation

The command must validate:

- prompt is non-empty
- input image, when present, exists and is PNG
- aspect ratio is `9:16` or `16:9`
- resolution is `720p` or `1080p`
- duration is `4`, `6`, or `8` seconds
- sample count is exactly `1` for each prototype invocation
- the output is a playable `video/mp4`
- the output has positive dimensions and duration
- the output checksum is recorded

## Acceptance criteria

1. Unit tests cover configuration resolution, request construction, input validation, successful polling, provider failure, timeout, and missing output bytes.
2. Command tests run without credentials or network access by injecting a fake client and a fixture MP4.
3. The command emits a result that includes `status: "needs_review"` and complete output provenance.
4. Existing worker and media tests remain unchanged in behavior.
5. Typecheck and focused worker tests pass.
6. The PR documents that the prototype is not wired to `public_preview` or delivery.

## QA checklist

- [ ] No API key or access token appears in source, logs, request JSON, or metadata.
- [ ] Polling stops at the configured deadline.
- [ ] Provider errors become typed, actionable failures.
- [ ] Output checks reject non-video or empty output.
- [ ] Every generated output has a prompt checksum and output checksum.
- [ ] Existing NotebookLM public-preview behavior is unchanged.

## Next integration

After human review of this prototype, add a dedicated Nuglet video recipe and artifact kind. Then wire the provider into the worker media contract and add ChatCut import as a separate derivative step.
