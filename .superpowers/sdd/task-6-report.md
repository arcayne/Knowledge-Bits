# Task 6 Report

## Result

Repaired the four-asset media protocol across Knowledge Bits and Nuglet.

Repair 3 closes the remaining consumer-side trust-boundary finding in Knowledge Bits. The live run intake now composes the generic request contract with `knowledgeBitsRunBriefSchema` for `nuglet.lesson.v1` briefs and rejects a request-level NotebookLM notebook ID that differs from the validated brief. The worker repeats the strict brief validation and run-level notebook comparison before recipe verification, dependency reads, NotebookLM calls, editorial inference, or media generation. Legacy briefs and other target kinds keep their existing generic contract.

Repair 2 closes the remaining rereview findings. Nuglet now compares the descriptor run folder, run ID, and NotebookLM notebook ID with the actual source folder and manifest before writing a shadow input. Knowledge Bits independently requires the descriptor identity to match the enclosing brief. Both repositories enforce the approved Brief and Discussion paths and reject shared paths, provider artifact IDs, or final-byte checksums. The worker also rejects identical returned audio bytes. PNG probing now requires a complete IHDR chunk with valid field values and CRC.

The `nuglet.lesson.v1` generation plan now contains a checksum-bound media baseline wrapper. Its descriptor records the baseline run ID and repository-relative folder, NotebookLM notebook ID, infographic, Brief audio, and Discussion audio paths, provider artifact IDs, final byte checksums, and the exact NotebookLM generation evidence for each artifact. The wrapper binds the descriptor file bytes by checksum, so the media command can verify the plan against the trusted file before selecting media.

The command no longer chooses baseline identity from an environment variable. It verifies the descriptor file, manifest run identity, folder identity, notebook and artifact identities, recipe bindings, provider and model labels, exact prompt bytes and checksums, and every selected media checksum. Only then can those baseline bytes be returned with the active generation input checksum.

## Knowledge Bits

- Wired strict Nuglet brief validation into the live `POST /runs` request schema without narrowing generic run inputs.
- Rejected request-level and job-level NotebookLM notebook IDs that differ from the validated Nuglet brief.
- Reused the strict brief schema at both default and injected worker context boundaries before provider work.
- Added contract, API route, and worker regressions for descriptor run ID, descriptor notebook ID, and run-level notebook ID drift.
- Added the strict `nugletMediaBaselineSchema` to the required `1.1.0` Nuglet generation plan.
- Passed the complete baseline wrapper through the local media command JSON input.
- Rebuilt support artifacts from an array of actual executions instead of one synthetic support object.
- Verified every complete recipe and prompt pair, including exact recipe snapshot bytes, prompt checksum, provider, model, references, and baseline NotebookLM evidence.
- Required audio to retain its NotebookLM generation pair and a second transcript pair.
- Recomputed infographic and audio checksums against the generation-plan baseline before accepting command output.
- Updated existing Story and Playbook test plans to include structurally valid media baseline fixtures without changing their stage behavior.

## Nuglet

- Removed the post hoc NotebookLM selection prompt that had never been executed.
- Removed runtime dependence on `KNOWLEDGE_BITS_MEDIA_BASELINE_RUN_FOLDER` and its obsolete example setting.
- Loaded baseline identity from the JSON contract, then verified it against `knowledge-bits/media-baseline.v1.json` and the baseline manifest.
- Preserved exact NotebookLM source-generation evidence from the trusted descriptor for the infographic and both audio variants.
- Accepted a NotebookLM transcript only when the descriptor also binds its transcript path, transcript checksum, final audio checksum, extraction artifact ID, and exact extraction evidence.
- Ignored self-labeled transcript sidecars when trusted extraction evidence is absent and transcribed the final audio bytes with Vertex instead.
- Added the real Vertex transcription recipe and prompt pair while retaining the NotebookLM audio-generation pair.
- Preserved the existing hero recipe, immutable references, per-run direction, measured output, and four-kind contract.
- Validated the complete PNG signature, 13-byte IHDR declaration, IHDR chunk identity, and positive dimensions.
- Made the shadow-run serializer persist the checksum-bound descriptor wrapper in the generation plan.

## Test-Driven Evidence

Repair 3 started with three focused failures. The contract test could not import the missing composed request schema, the API returned `201` for a mismatched descriptor run ID, and the worker reached NotebookLM for the same mismatch. After wiring the strict boundaries, the focused contract, API route, and worker runtime suites passed. The worker regression also confirmed zero NotebookLM, editorial, and media calls for invalid run and notebook identities.

The first Repair 2 contract run failed because brief identity drift and aliased audio descriptors were accepted. The worker regression failed because identical Brief and Discussion bytes were accepted. The shadow-run regressions failed because source folder, run ID, and notebook ID were not checked. The media command regressions failed because Discussion could point to Brief, the manifest notebook ID was ignored, and a 24-byte PNG IHDR prefix was accepted.

After implementation, the focused suites cover wrong run identity, wrong final bytes, absent and mismatched NotebookLM generation evidence, spoofed transcript sidecars, mismatched trusted transcript bytes, missing Discussion audio, multiple complete provenance pairs, incomplete extra pairs, JSON serialization, descriptor file checksums, and malformed PNG headers.

## Verification

- Knowledge Bits contract suite: 28 passed.
- Knowledge Bits focused API route suite: 3 passed.
- Knowledge Bits focused worker runtime suite: 14 passed.
- Knowledge Bits worker suite: 96 passed.
- Knowledge Bits API suite: 91 passed, 3 skipped by existing Docker guards.
- Knowledge Bits full repository suite: 265 passed, 4 skipped by existing Docker guards.
- Knowledge Bits workspace builds: 5 of 5 passed.
- Knowledge Bits workspace typechecks: 5 of 5 passed.
- Knowledge Bits forbidden credential scan: passed for 149 tracked files.
- Nuglet focused media command and shadow-run suites: 16 passed.
- Nuglet Lab suite: 171 passed.
- Nuglet Lab build and typecheck: passed.
- Nuglet generation recipe validation: all 8 approved recipes passed against `b05e2a6`.
- Nuglet repository script suite: 42 passed.
- Nuglet secret-boundary scan: passed.
- Final diff checks in both repositories: passed.

## Review

The Repair 3 self-review traced both default and injected worker context paths and confirmed that strict validation runs before context resolution or provider calls. It also checked that the generic request schema remains available, non-Nuglet and legacy route tests still pass, Task 6 media code is unchanged, and no Task 7 assembly or UI files were added.

The final cross-repository diff review checked every Important and Minor finding against the implementation and regressions. It found no remaining source-run identity gap, audio-role alias, truncated PNG acceptance, synthetic NotebookLM execution prompt, environment-only baseline identity, single-pair media restriction, self-authored transcript trust path, Discussion fallback, Task 7 work, or change to the four required media kinds.

## Concerns

- Task 9 still needs to create the real Personal Finance `knowledge-bits/media-baseline.v1.json` from trustworthy NotebookLM records. Until then, production shadow serialization for that run intentionally fails closed.
- Verification ran on Node `v26.5.0`, while both workspaces declare `>=24 <25`. The existing engine and TSX deprecation warnings remain.
- Docker was unavailable, so three Knowledge Bits migration tests and one end-to-end test used their existing skip paths.
- Vertex image generation and transcription were covered through injected provider boundaries, not live credentials.
- The repository-required `/humanizer` skill was not installed, so the report updates were checked manually against the same no-AI-tells, no-promotional-copy, and no-em-dash standard.
