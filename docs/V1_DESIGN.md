# Knowledge Bits V1 Design

**Status:** Approved for implementation planning  
**Date:** 2026-07-12  
**Initial consumer:** Nuglet

## Summary

Knowledge Bits is an internal, standalone engine that turns a brief and a set of trustworthy sources into a reviewed, evidence-backed content package. Its first and only V1 consumer is Nuglet, but the engine does not contain Nuglet production logic or credentials.

The engine owns research workflow, source evidence, content generation, quality checks, artifacts, human review, and delivery state. Nuglet provides a scoped artifact-storage adapter and a narrow package-import API. A local worker runs NotebookLM, Pi SDK inference, and other provider tools while those workloads are hardened for portable execution.

The core artifact is named `KnowledgeBits`, including when one package contains one prepared piece. A human makes one overall approval decision. Approval freezes the package and automatically authorizes delivery to Nuglet. Delivery retries do not require another approval unless package content or artifacts change.

## Product Boundary

Knowledge Bits is a separate repository and independently deployed service. It has its own database, API, review interface, worker protocol, provider credentials, and audit history.

Knowledge Bits must never receive:

- Nuglet production database credentials
- Nuglet user or subscription data
- Nuglet billing or authentication credentials
- General access to Nuglet production media
- Permission to run arbitrary Nuglet backend operations

Nuglet is an integration. It supplies scoped artifact storage and accepts an approved package through one authenticated import endpoint. The Nuglet backend remains responsible for validating and publishing to its own production database.

## Naming

- Product and repository: `knowledge-bits`
- Service: Knowledge Bits Engine
- Core artifact: `KnowledgeBits`
- Initial output adapter: Nuglet

The plural core-artifact name is intentional. It supports the idea that a package contains prepared pieces of knowledge and may later be sold, licensed, or delivered as one unit.

V1 does not implement x402, marketplace discovery, or purchases. The package identity, version, provenance, rights metadata, and immutable checksum preserve a path to those capabilities.

## V1 Principles

1. Separate the engine physically and operationally from Nuglet production.
2. Keep workflow decisions deterministic and provider execution replaceable.
3. Preserve evidence and provenance rather than trusting generated output.
4. Show operators a small workflow while retaining detailed execution evidence internally.
5. Require one human approval before production delivery.
6. Never create generic fallback content when a provider fails.
7. Make delivery idempotent and retryable.
8. Keep V1 internal, single-consumer, and intentionally small.

## Architecture

```text
Knowledge Bits Engine
├── Control API
├── Independent Supabase project
├── Internal review interface
├── Local worker protocol
├── Provider adapters
│   ├── NotebookLM
│   ├── Pi SDK inference
│   └── media providers
├── Storage adapter
│   └── Nuglet-scoped Cloudflare R2
└── Delivery adapter
    └── Nuglet package-import API
```

### Control API

The control API creates runs, exposes status, leases jobs, records results, accepts human decisions, and schedules delivery. It is the only component allowed to advance workflow state.

The API is deployed independently from Nuglet. It uses a separate Supabase project and contains no Nuglet database configuration.

### Engine Database

The engine database stores coordination and audit records. The V1 data model is deliberately small:

- `runs`: one requested content outcome and its current stage
- `stages`: stage status and summarized outcome for a run
- `jobs`: leased worker actions, attempts, and retry timing
- `artifacts`: immutable references, checksums, media types, and provenance
- `reviews`: human decisions tied to an exact package checksum
- `deliveries`: target adapter, idempotency key, attempts, and verification result

Sources, prompts, raw provider responses, parsed outputs, citations, QA reports, and prepared content remain immutable artifacts. The database stores their references and checksums instead of reproducing every document structure as relational columns.

### Local Worker

The local worker claims one leased job from the control API, executes it, uploads evidence, and reports an outcome. It runs NotebookLM, Pi SDK inference, deterministic checks, and media providers.

The worker receives only:

- an engine-scoped worker credential
- provider credentials required by the claimed job
- short-lived upload URLs or a prefix-restricted R2 credential

The worker does not choose the next workflow stage. It cannot approve content or publish directly to Nuglet.

### Storage Adapter

Nuglet provides Cloudflare R2 storage for V1 through an adapter. Knowledge Bits writes only to an engine-specific staging prefix or bucket. Access is provided through short-lived signed URLs or a prefix-restricted credential.

The adapter must prevent listing, reading, overwriting, or deleting unrelated Nuglet media. Every uploaded artifact is content-addressed or occurrence-unique and carries a checksum.

### Nuglet Delivery Adapter

The delivery adapter sends one approved, immutable `KnowledgeBits` package to a dedicated Nuglet import endpoint. Its credential is restricted to package import and delivery-status inspection. It carries no database authority.

## Workflow

The operator-visible workflow has six stages:

```text
Research
→ Create
→ Check
→ Produce assets
→ Human review
→ Deliver to Nuglet
```

### Research

Collect candidate sources, verify readability and credibility, remove duplicates, capture immutable source snapshots, and record coverage gaps. NotebookLM may recommend sources, but recommendations are candidates until verified by Knowledge Bits.

### Create

Import verified sources into NotebookLM, produce citation-backed synthesis, and prepare the Nuglet-specific content payload. NotebookLM commands, synthesis, drafting, and provider conversation details remain internal execution evidence rather than operator-visible stages.

### Check

Run deterministic structural and evidence checks followed by independent editorial QA. Unsupported claims, contradictory guidance, source leakage, unusable structure, or generic filler fail the check.

The Check stage may request up to two automatic content revisions. Those revisions are internal attempts, not additional top-level stages. Exhausted automatic revisions send the current evidence and failure reasons to human review.

### Produce Assets

Generate the hero image, infographic, audio, and other required Nuglet artifacts only after content passes Check. Every asset records the content checksum it represents. A changed content payload makes prior assets stale.

### Human Review

The reviewer sees the learner-facing Nuglet preview, accepted sources, supported claims, citations, QA findings, hero, infographic, and audio in one place.

The reviewer has one decision:

- **Approve**: freeze this package revision and authorize automatic delivery.
- **Request changes**: provide one required comment and create a new revision.

There are no separate approvals per artifact and no second publish approval.

### Deliver to Nuglet

Approval automatically schedules delivery. Nuglet validates the package and imports it idempotently. Knowledge Bits then verifies the public or approved preview surface returned by Nuglet.

A delivery failure retries the same immutable package. A changed package requires a new human approval.

## Operator States

Every stage uses one of five visible states:

- `queued`: waiting for eligible worker capacity
- `running`: a worker currently holds a valid lease
- `waiting`: a temporary provider or infrastructure condition will be retried
- `needs-human`: approval, credentials, or an exhausted quality loop requires action
- `done`: stage completion criteria and evidence are recorded

Detailed causes are reason codes and evidence, not additional top-level states. Examples include `notebooklm-cooldown`, `authentication-expired`, `quality-revision-exhausted`, and `delivery-verification-failed`.

## `KnowledgeBits` Package Contract

The package is an immutable directory or archive with four required surfaces:

```text
package.json
evidence.json
content.json
assets/
```

### `package.json`

Contains:

- schema version
- stable package ID
- revision number
- locale
- creation timestamp
- package checksum
- owner identity
- target adapter and adapter schema version
- brief title, audience, objective, and risk class
- artifact inventory and checksums
- provenance summary
- usage-rights metadata
- approval checksum and decision metadata when approved

The package checksum covers the content, evidence, asset inventory, and target payload. Any change creates a new revision and invalidates prior approval.

### `evidence.json`

Contains:

- accepted and rejected source decisions
- immutable source snapshot references
- supported claims
- claim-to-citation mappings
- coverage gaps
- deterministic check results
- independent editorial QA report
- revision history

### `content.json`

Contains an adapter-specific payload inside the generic envelope. V1 supports only:

```text
kind: nuglet.lesson.v1
```

The Nuglet adapter owns validation of that payload. Future adapters may define different payload kinds without changing the evidence or approval model.

### `assets/`

Contains references to the approved hero, infographic, audio, and any required derivatives. Each reference includes media type, checksum, provenance, R2 staging key, and the content checksum represented by the asset.

## API Surface

The V1 engine API is limited to:

```text
POST /runs
GET  /runs/:id
POST /jobs/claim
POST /jobs/:id/result
POST /runs/:id/review
POST /deliveries/:id/retry
```

The Nuglet integration adds:

```text
POST /internal/content-packages
GET  /internal/content-packages/:packageId
```

The import request includes the immutable manifest, package checksum, approval checksum, adapter version, artifact references, and idempotency key.

Nuglet independently verifies:

- package and adapter schema versions
- approval against the exact package checksum
- content, evidence, and asset checksums
- required Nuglet lesson fields
- allowed R2 staging prefix
- package identity and idempotency key
- whether the package was already imported

On success, Nuglet returns the package ID, lesson identity, import status, and preview or public URL.

## Security and Isolation

Knowledge Bits must enforce these boundaries in code, deployment configuration, and tests:

- The engine repository has no Nuglet production database variables.
- Startup fails if known Nuglet production database variable names are present.
- The worker credential permits only job claim and result submission.
- The R2 credential or signed URL permits only the package staging scope.
- The Nuglet import credential permits only package import and status lookup.
- Migration and owner credentials never enter the deployed runtime.
- Approved package revisions are immutable.
- Provider output cannot directly alter workflow state, approval, or delivery authorization.
- Secrets never appear in package artifacts, logs, prompts, or review pages.

The Nuglet import endpoint is the only production mutation boundary. Nuglet remains responsible for its own authorization, transaction boundaries, database writes, and rollback behavior.

## Recovery and Failure Handling

Jobs use leases with expiry. If a worker exits, another compatible worker can reclaim the job after lease expiry. Provider operations use stable idempotency keys where supported.

Temporary provider cooldowns and infrastructure failures move the stage to `waiting` with a retry time. Missing credentials or exhausted quality revision loops move it to `needs-human` with a concrete requested action.

Knowledge Bits never emits generic fallback copy. Existing evidence, provider responses, prompts, and failure reports remain available for inspection.

Delivery failures preserve the approved package and reuse its idempotency key. Verification failures do not regenerate content automatically because Nuglet may already have imported it.

## Verification Strategy

V1 must include:

- contract tests for package, evidence, approval, and adapter schemas
- deterministic fixture providers for NotebookLM, Pi SDK inference, and media operations
- worker lease expiry and reclaim tests
- tests proving provider failures cannot produce fallback content
- tests proving unsupported claims fail Check
- tests proving content changes invalidate approval and assets
- Nuglet import idempotency tests
- R2 prefix-isolation tests
- tests that fail if Nuglet production database variables are configured
- an end-to-end fixture from brief through verified Nuglet preview
- one real shadow run using a production-quality Nuglet brief

The real pilot passes only when one approved package becomes a Nuglet, the live result matches the approved package, interrupted work resumes safely, repeated delivery creates no duplicate lesson, and Knowledge Bits never receives Nuglet database credentials.

## Rollout

1. Create the standalone repository, service, and separate Supabase project.
2. Implement the minimal control API, database model, artifact interface, and local worker protocol.
3. Move provider-neutral pipeline capabilities into Knowledge Bits without changing the running Nuglet pipeline.
4. Implement Nuglet-scoped R2 storage and package-import adapters.
5. Run one real brief through Knowledge Bits in shadow mode.
6. Compare its evidence, content, and assets with the existing Nuglet output.
7. Approve and import the package through the new Nuglet endpoint.
8. Verify the public lesson and delivery retry behavior.
9. Route new Nuglet production through Knowledge Bits.
10. Keep the old Nuglet Lab read-only until active runs are finished or explicitly adopted.
11. Remove the old pipeline's production database access after cutover verification.

## V1 Scope

V1 includes:

- internal single-consumer operation
- one independently deployed engine
- one separate Supabase project
- Nuglet-scoped R2 storage
- one local worker
- NotebookLM and Pi SDK inference adapters
- deterministic and independent editorial checks
- Nuglet hero, infographic, and audio production
- one overall human approval
- Nuglet import and live verification
- English content with locale carried throughout the contract

## Deferred Capabilities

V1 does not include:

- public accounts or multi-tenancy
- x402 payments or marketplace discovery
- customer billing
- cloud-hosted inference workers
- Cloudflare D1 or Queues migration
- additional consumer integrations
- high-stakes medical guidance
- complex reviewer roles
- scheduled publishing
- separate content and release approvals

High-stakes domain packs, including guidance for families and patients affected by Alzheimer's disease, require a separate design covering authoritative-source policy, medical claims, scam-risk checks, review expiry, qualified human review, corrections, and jurisdiction-aware guidance.

## Success Criteria

Knowledge Bits V1 is complete when:

1. A real brief completes all six stages and produces an approved `KnowledgeBits` package.
2. Nuglet imports the package through the dedicated API and publishes or exposes the expected preview.
3. Every factual claim resolves to captured source evidence.
4. A worker interruption resumes without duplicate provider or delivery work.
5. Repeated delivery imports the lesson exactly once.
6. Any package or asset change invalidates prior approval.
7. No Knowledge Bits component can access Nuglet users, subscriptions, billing, authentication, or production database credentials.
8. The old Nuglet pipeline remains available until the cutover is explicitly accepted.
