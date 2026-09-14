# Architecture

Knowledge Bits separates workflow control from provider execution. The control API owns state transitions. Workers execute leased jobs and return evidence. A reviewer approves one immutable package revision. Delivery sends only that approved revision to a configured destination.

## Six stages

The workflow has exactly six top-level stages:

1. **Research** — collect candidate sources, validate public source access, remove duplicates, and store accepted source snapshots.
2. **Create** — use accepted evidence and the selected recipe to create the target content.
3. **Check** — run deterministic structure and evidence checks plus editorial quality checks. A failed check can queue a bounded create revision; after the revision limit, the run needs human action.
4. **Produce assets** — create or attach the required media after content checks pass. Each asset records the content checksum it represents.
5. **Human review** — show the complete package, evidence, checks, and assets. The reviewer approves the exact package checksum or requests changes.
6. **Delivery** — send the approved immutable package to the destination, then verify the destination response. Delivery retries reuse the same package and idempotency key.

Workers cannot select a next stage. Only the control API can apply a valid state transition.

## Component ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| Control API | Runs, stage state, jobs, leases, checksums, revisions, review decisions, and delivery history | Provider sessions, reviewer identity, or destination database writes |
| API worker protocol | Capability checks, lease-scoped inputs, result recording, and artifact upload authorization | Provider-specific correctness or approval |
| Worker | Provider calls, deterministic checks, media production, and stage evidence | Workflow transitions, approval, or direct destination publication |
| Review app | Authenticated package display and review decision submission | Trusting browser-supplied identity or bypassing the API |
| PostgreSQL and Prisma | Durable workflow, audit, package-version, artifact, review, and delivery records | Large artifact bytes |
| Artifact storage | Immutable source, evidence, report, and media bytes | Workflow state or approval |
| Destination adapter | Destination delivery and verification calls | Changing an approved package |

The API uses a restricted runtime PostgreSQL role. Migration commands use a separate owner connection. The worker receives only its own bearer credential and declared capabilities.

## Persistence model

The Prisma schema stores these records:

- `Run` identifies the requested outcome, current stage, current revision, package checksum, and approved checksum.
- `Stage` records the state and attempt information for each stage.
- `Job` records action input, result, idempotency key, lease owner, lease expiry, execution deadline, and completion receipt.
- `Artifact` records kind, media type, SHA-256 checksum, byte size, storage key, provenance, source revision, and optional input checksum.
- `PackageVersion` stores the content, evidence, QA, artifact inventory, adapter version, locale, owner, and usage-rights metadata for one revision.
- `Review` binds a reviewer decision to one exact package checksum.
- `Delivery` binds a destination attempt to one package version and one idempotency key.

PostgreSQL is the source of truth for coordination and audit records. Prisma migrations define the database schema. Artifact bytes remain in the configured storage adapter and are inspected before the API records them.

## Evidence and checksums

Source snapshots, provider responses, prompts, parsed outputs, QA reports, package surfaces, and media are recorded as immutable artifacts. The API checks the stored bytes, media type, byte size, and checksum when an artifact upload completes. The package checksum is calculated from the canonical package inputs, including content, evidence, QA, asset inventory, adapter version, locale, owner, and usage-rights metadata.

A review decision includes the package checksum. Approval is valid only when it matches the current package checksum. Any content, evidence, QA, asset inventory, adapter, locale, owner, or rights change produces a different checksum and requires another review decision.

## Package revisions

A run starts at revision 1. A requested change or a regenerated asset creates a new revision. Artifacts remain associated with the revision that produced them. Assets that represent an older content checksum are stale and cannot silently be reused as current assets. An approved revision is not edited in place.

The package and review representations are versioned independently:

- `knowledge-bits.package.v1` is the validated package envelope.
- `knowledge-bits.review-package.v1` is the package data shown to a reviewer.
- `knowledge-bits.content.v1` contains the target payload.
- The current Nuglet target supports versioned target schemas, including `nuglet.lesson.v1` schema `1.1.0` for the story/playbook shape.

See [Compatibility](compatibility.md) before changing any versioned contract.

## Lease fencing

A worker claims a job for a server-issued lease. The lease has an owner, expiry, and execution deadline. Artifact preparation and completion require the active lease, run, revision, stage, and artifact kind to match. A worker whose lease has expired or been reclaimed is fenced from recording new artifacts or results. A later worker can safely reclaim eligible work.

Provider calls must honor the execution deadline and abort signal. A lease is a concurrency boundary, not proof that a provider succeeded. Results are accepted only after the API validates the lease and the returned contract.

## Approval and delivery idempotency

Human review makes one package-level decision. Approval schedules delivery for that exact approved checksum. The delivery adapter receives the immutable package, package-version ID, package checksum, and stable idempotency key.

A retry after a transient failure sends the same package and key. A destination may respond `imported` or `already_imported`; the API persists the response and then verifies it. A changed package cannot reuse the old approval or delivery identity.

## Artifact storage

The storage adapter receives server-owned keys in the form `knowledge-bits/nuglet/{runId}/{revision}/{artifactId}`. The API issues a short-lived upload capability, and then inspects the stored object. The local adapter writes below `.local-demo/`; an optional R2 adapter uses S3-compatible signed PUT URLs. Storage credentials belong to the API and are not passed to the browser or worker as broad bucket credentials.

## Trust boundaries

1. **Browser to review app:** production review must validate an identity-provider assertion and CSRF protection. Browser fields cannot choose the reviewer identity.
2. **Review app to API:** review credentials and API origin configuration limit calls to the engine API.
3. **Worker to API:** a server-mapped token, capability list, lease, and revision scope limit worker actions.
4. **Sources and providers to worker:** source bytes and model output are untrusted until parsed, checked, linked to evidence, and checksummed.
5. **API to artifact storage:** server-owned object keys and upload inspection limit storage access to engine artifacts.
6. **API to destination:** only an approved package crosses the delivery boundary. The destination owns its own database, authentication, and publication transaction.
7. **Migration owner to runtime database:** migration credentials are separate from the restricted API runtime role.

Knowledge Bits does not receive destination database credentials, billing credentials, user credentials, or general destination-media access. The local demo uses neither provider credentials nor destination credentials.
