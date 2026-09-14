# Knowledge Bits Core open-source extraction

> Superseded scope (2026-09-14): the owner confirmed that Nuglet information may be public. The private Nuglet boundary and mandatory core extraction below are historical proposals. Use `readiness-plan.md` for current scope and release work.

Status: proposed  
Date: 2026-08-15  
Risk tier: Red for publication and repository-history exposure; Orange for code extraction

## Objective

Create a public, self-hostable `knowledge-bits-core` project from the reusable parts of Knowledge Bits.

The public project must let a team run one evidence-backed workflow from source collection through human approval and delivery to a fixture or custom destination. It must not expose Nuglet product logic, content, assets, credentials, operational data, or commercial control-plane design.

This specification does not authorize publication. Publication requires the release gates in this document and a named owner approval.

## Decision

Create three separately owned boundaries.

```text
knowledge-bits-core              public
  self-hostable workflow engine, contracts, review UI, fixtures, and evaluation harness

knowledge-bits-nuglet            private
  Nuglet content packages, recipes, prompts, visual assets, source inventory, and delivery adapter

knowledge-bits-cloud             private
  hosted control plane, managed credentials, observability, multi-tenant operations, and enterprise features
```

`knowledge-bits-core` is a new repository with fresh history. Do not publish this repository or copy its Git history into the public repository.

## Current evidence

The current engine already has reusable boundaries:

- `packages/pipeline` contains the deterministic six-stage workflow and checksum-bound review/delivery transitions.
- `packages/contracts` contains workflow and package schemas, but it also contains Nuglet-specific names and payloads.
- `packages/evaluation` and `evals/knowledge-bits.v1` define a reproducible model-quality release gate. The public form must contain only synthetic fixtures and neutral labels.
- `apps/api` and `apps/review` provide a control API and review surface. Their public form must use generic destination and authentication configuration.

The current repository also contains private material. This includes `recipes/nuglet.lesson.v1`, `apps/worker/assets/nuglet-*`, Nuglet prompts, the migration registry, real example inventories, delivery configuration, product strategy, and operational reports.

## Public product definition

The public project provides these capabilities.

1. Accept a brief and declared source inputs.
2. Store immutable source snapshots and source decisions.
3. Run a configurable sequence of generation and deterministic-check jobs.
4. Bind claims and citations to immutable source snapshots.
5. Build a checksum-addressed package revision.
6. Require a human decision before a package can be delivered.
7. Send an approved package through a destination adapter that verifies idempotent delivery.
8. Run fixture-based evaluation that rejects regressions in provenance, citation binding, prompt-injection handling, safety policy, package integrity, and delivery compatibility.

The public project is not a hosted service, a multi-tenant control plane, a content marketplace, an industry-specific policy pack, or a replacement for a customer-facing CMS.

## Stable public modules

### `@knowledge-bits/contracts`

Publish generic schemas and types for:

- `WorkflowStage`, `StageState`, jobs, leases, attempts, and failure reasons;
- `SourceSnapshot`, `SourceDecision`, `Claim`, `Citation`, and provenance records;
- `PackageRevision`, package checksum, approval, review comment, and delivery receipt;
- versioned adapter request and response envelopes;
- an explicit `ContentKind` string chosen by the deployer.

Do not publish `nuglet.lesson.v1`, Nuglet payload fields, lesson terminology normalization, migration inventories, or brand-specific compatibility shims.

The public contracts must have a semantic-versioned schema identifier. A destination adapter must reject an unsupported schema version. A public schema change that invalidates existing package checksums is a major-version change.

### `@knowledge-bits/pipeline`

Publish the deterministic state machine and package checksum builder.

The initial public stage names remain:

```text
research -> create -> check -> produce_assets -> human_review -> deliver
```

The core must preserve these invariants:

1. Only a leased worker can start or complete an automated stage.
2. Provider output cannot complete `human_review` or `deliver`.
3. A human approval records the exact package checksum.
4. Delivery receives only the approved checksum.
5. A changed package checksum invalidates prior approval and queues the appropriate preceding stage.
6. Delivery retries are idempotent for the same package checksum and destination import key.

### `@knowledge-bits/evaluation`

Publish a fixture-only evaluator, corpus schema, report schema, comparator, and promotion-request format.

The initial public hard gates are:

- immutable source and citation binding;
- prompt-injection resistance using fake canary values;
- configured unsafe-advice policy checks;
- package checksum integrity;
- fixture delivery compatibility and idempotency.

The public package must not include production model credentials, real provider prompts, real source snapshots, real customer data, production baselines, or proprietary label sets. Provider-backed evaluation is an extension point, not a configured default.

### Reference applications

Publish a reference API, one local worker, and a review UI only after they run with:

- SQLite or local PostgreSQL;
- filesystem artifact storage;
- fixture generation provider;
- fixture destination adapter;
- local development authentication that is explicitly disabled in production mode.

The reference applications demonstrate interfaces. They do not include managed deployment automation, production identity-provider configuration, cloud storage configuration, or Nuglet endpoints.

## Adapter contracts

All product-specific behavior must cross one of these explicit interfaces. Core must not import a product adapter.

| Adapter | Core input | Required result | Core restriction |
| --- | --- | --- | --- |
| `SourceAdapter` | source declaration and byte limits | accepted/rejected source snapshot with checksum and reason | Cannot alter the brief, recipe, or workflow state. |
| `GenerationAdapter` | bounded task, accepted source snapshots, content-kind configuration | structured candidate output plus provider/model provenance | Cannot approve, deliver, or access destination credentials. |
| `CheckAdapter` | candidate package revision and policy configuration | pass/fail findings with evidence references | Cannot mutate a package after its checksum is calculated. |
| `ArtifactAdapter` | approved content revision and asset request | artifact checksum, media metadata, and provenance | Cannot publish an artifact or create a review decision. |
| `ArtifactStorageAdapter` | server-owned object key and bounded upload/read request | immutable artifact reference | Workers receive scoped upload capability only. |
| `DestinationAdapter` | approved package, checksum, destination configuration, import key | accepted/rejected receipt and verification result | Cannot receive an unapproved package or database authority. |

Each adapter implementation declares an ID, version, configuration schema, capability set, and timeout limits. Adapter configuration must be injected at runtime. It must never be committed into a package, report, test fixture, or public example.

## Repository layout

The extracted repository must use this layout.

```text
packages/
  contracts/
  pipeline/
  evaluation/
  adapters-fixture/
apps/
  api-reference/
  worker-reference/
  review-reference/
examples/
  local-fixture-workflow/
docs/
  architecture.md
  adapters.md
  self-hosting.md
  security.md
  threat-model.md
  compatibility.md
SECURITY.md
CONTRIBUTING.md
CODE_OF_CONDUCT.md
LICENSE
```

The initial public release must use synthetic examples only. Every example source, generated output, image, audio asset, label, and delivery receipt must be either created for publication, public-domain, or accompanied by a documented redistribution right.

## Extraction rules

### Eligible code

Move or reimplement, after neutral naming and tests:

- deterministic state machine and package checksum builder;
- generic workflow, job, review, artifact, and delivery contracts;
- generic repository interfaces and fixture implementations;
- fixture delivery and verification adapter;
- evaluation contracts, canonical report generation, comparator, and synthetic corpus tooling;
- security controls that are implementation-neutral, including lease fencing, idempotency, checksum verification, and bounded artifact access;
- generic review UI components and API routes after product labels and endpoints are removed.

### Private code and data

Do not copy:

- `recipes/nuglet.lesson.v1/**`;
- `apps/worker/assets/nuglet-*` and all Nuglet logos, end cards, hero images, and CTAs;
- `apps/worker/src/prompts/**` unless a new public prompt is written solely for the fixture example;
- `apps/worker/src/providers/notebooklm*`, media commands, and provider-specific production behavior;
- Nuglet destination adapters, URL configuration, internal endpoint shapes, or delivery tokens;
- `examples/nuglet-migrations/**`, production-like lesson inventories, source manifests, or historical package artifacts;
- `docs/NUGLET_*`, product-growth material, operational reports, agent instructions, and private skills;
- `.superpowers/**`, `.pi/**`, `.pi-subagents/**`, local work directories, CI artifacts, and Git history.

Do not rely on redaction as the primary control. Replace private fixtures and examples with independently created synthetic material.

## Migration plan

### Phase 0: rights, threat model, and release decision

1. Assign a release owner and a security owner.
2. Select a license with legal review.
3. Publish a trademark and brand-use policy if the `Knowledge Bits` name or logo is retained.
4. Create the public repository with no inherited history.
5. Write a threat model for source retrieval, untrusted model output, workers, artifacts, review decisions, and destination adapters.
6. Define a vulnerability reporting channel before public release.

Exit gate: named legal and security owners approve the code/data boundary and license.

### Phase 1: contracts and deterministic core

1. Create neutral contracts with no `Nuglet` identifiers.
2. Extract the state machine and checksum builder.
3. Add fixture storage, fixture destination delivery, and deterministic contract tests.
4. Add schema-version compatibility tests and idempotent delivery tests.
5. Write architecture and adapter documentation.

Exit gate: a clean checkout runs one synthetic package through review and fixture delivery without external credentials.

### Phase 2: evaluation and reference workflow

1. Extract the fixture-only evaluation package.
2. Create a synthetic corpus that exercises each public hard gate.
3. Add a fixture generation adapter and example content kind.
4. Add a local API, worker, and review UI example.
5. Add CI for build, tests, typecheck, dependency audit, secret scanning, and public-fixture validation.

Exit gate: CI rejects a seeded failure in each public hard gate and accepts a clean synthetic candidate reproducibly.

### Phase 3: release candidate audit

1. Scan the export and its complete Git history for secrets, private URLs, credentials, names, source text, images, fonts, and internal identifiers.
2. Check every dependency, asset, fixture, and documentation excerpt for redistribution rights.
3. Run the reference workflow in a clean environment with no private environment variables or network destinations.
4. Obtain independent security review of the reference API and adapter boundary.
5. Publish a release candidate only after owner sign-off.

Exit gate: the release checklist is complete and all findings are resolved or explicitly accepted by the release owner.

## Security and privacy requirements

1. No public code, test, artifact, Git object, issue template, or release asset may contain a credential, production URL, access token, provider notebook ID, customer identifier, or internal package ID.
2. Reference mode must fail closed when production-mode configuration is missing or contradictory.
3. Source retrieval must reject private-network addresses, enforce byte/time limits, and record source checksums.
4. Model and source output is untrusted until schema-validated and linked to accepted evidence.
5. Review identity and approval must be server-authorized. Browser input cannot select a reviewer identity.
6. Workers must use capability-scoped credentials and lease-fenced job completion.
7. Core must never embed destination database credentials or provide a direct database destination adapter.
8. Public CI must run without private credentials. Credentialed integration tests, if later added, must run only in a separate private environment.

## Acceptance criteria

The public release is ready only when all criteria are true.

1. The public repository has no shared Git history with the private repository.
2. `rg -i 'nuglet|notebooklm|api.nuglet.app|media.nuglet.app'` returns no product code, fixture, or configuration reference outside an explicit private-exclusion test fixture that is not shipped.
3. Secret scanning, dependency scanning, and manual export review find no credentials, personal data, internal hostnames, private source content, or unlicensed assets.
4. A new contributor can run the synthetic workflow, review a package, approve it, and verify fixture delivery using only documented local configuration.
5. The state-machine tests prove that an unapproved or checksum-mismatched package cannot reach a destination adapter.
6. The evaluation harness deterministically rejects seeded citation, injection, safety, package-integrity, and delivery failures.
7. Every public adapter interface has a versioned schema, capability declaration, timeout, and negative test.
8. Documentation states the supported deployment mode, threat model, upgrade policy, security-reporting path, and license.
9. The release owner signs the publication checklist after legal and security review.

## Non-goals and deferred work

Defer these items from version 0.1:

- hosted multi-tenancy, billing, and metering;
- managed provider credentials and cloud worker scaling;
- enterprise SSO, RBAC, audit export, SLAs, and managed review;
- a generic marketplace or library of domain policy packs;
- production provider adapters, model prompts, media pipelines, and visual generation;
- migration tooling for existing Nuglet packages;
- a guarantee that the reference app meets a regulated-industry compliance standard.

## Open decisions

1. License selection and the trademark policy require legal review.
2. Confirm whether the public core uses only Apache-2.0-compatible dependencies and assets, or whether another license changes the distribution plan.
3. Decide whether the reference runtime supports SQLite only or local PostgreSQL in version 0.1.
4. Decide whether the reference review UI is included in version 0.1 or released after the core contracts and fixture workflow stabilize.
5. Define the compatibility support window before the first public schema version is released.

## Verification

Before implementation, validate this specification against the current private codebase. Confirm each selected file is generic, has test coverage, contains no private dependency, and can be replaced by a synthetic fixture where required.

After implementation, run the release-candidate audit in a fresh clone of the public repository. Do not use a working tree that has ever held private configuration or artifacts as the release source.

## Next action

Approve the public/private file inventory, then create the history-free public repository and implement Phase 1 only.
