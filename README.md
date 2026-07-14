# Knowledge Bits

> **From trusted sources to approved knowledge, delivered.**

Knowledge Bits is a standalone, evidence-backed content operations engine. It turns a brief and a set
of trustworthy resources into a reviewed, traceable, multi-format `KnowledgeBits` package and
delivers that package to the systems where an audience consumes it.

The engine owns its database, worker authentication, provider execution, evidence, quality gates,
review package, approval record, and delivery history. It does not read Nuglet production credentials
or write to Nuglet directly.

The workflow has exactly six stages: research, create, check, produce assets, human review, and
delivery. A worker lease protects each automated stage. Human review makes one decision over the
complete package checksum. Approval queues delivery for that immutable `KnowledgeBits` package.

**Status:** V1 engine implemented and fixture-verified  
**Initial consumer:** Nuglet

Product documentation:

- [Product and business vision](docs/VISION.md)
- [Approved V1 design](docs/V1_DESIGN.md)

## Requirements

- Node 24
- pnpm 9.12.0
- PostgreSQL 16 or a separate Supabase PostgreSQL project
- Docker for the clean end-to-end proof

Install dependencies and generate the Prisma client:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
```

## Database roles

Create a Supabase project dedicated to Knowledge Bits. Do not reuse a Nuglet project, database,
service role key, connection pool, or migration history. The engine uses two PostgreSQL logins:

- `ENGINE_MIGRATION_DATABASE_URL` is an owner connection used only by the migration command.
- `ENGINE_DATABASE_URL` is a restricted runtime connection used by the API.

Create the runtime login without ownership or schema creation rights. The committed migration revokes
schema creation from `PUBLIC`, creates the `knowledge_bits_runtime` group, and grants only the table
access used by the API. Grant that group to the runtime login after the first migration:

```sql
CREATE ROLE knowledge_bits_runtime_login LOGIN PASSWORD 'managed-outside-the-repository';
GRANT knowledge_bits_runtime TO knowledge_bits_runtime_login;
```

The group has DML access only to the eight engine tables. It cannot modify Prisma migration history.
Any future migration that adds an API-owned table must grant that table explicitly.

Apply migrations with distinct owner and runtime usernames:

```bash
ENGINE_DATABASE_URL="postgresql://knowledge_bits_runtime_login:...@.../postgres" \
ENGINE_MIGRATION_DATABASE_URL="postgresql://migration_owner:...@.../postgres" \
  pnpm --filter @knowledge-bits/api prisma:migrate:production
```

The production migration command rejects missing URLs and matching usernames. The deployed API
rejects `ENGINE_MIGRATION_DATABASE_URL`; only the restricted runtime URL belongs in the API project.
For a local throwaway database whose name contains `test`, use the guarded helper:

```bash
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/knowledge_bits_test" \
  pnpm --filter @knowledge-bits/api prisma:migrate
```

The engine rejects `DATABASE_URL` and the forbidden Nuglet database and Supabase credential variables.
CI also scans tracked files for credential assignments, project URLs, and token-shaped values.

## API and review

The API requires its runtime database, API token, review token, worker credential map, delivery adapter
URL, and delivery adapter token:

```bash
ENGINE_DATABASE_URL="postgresql://knowledge_bits_runtime_login:...@.../postgres" \
ENGINE_API_TOKEN="local-api-token" \
ENGINE_REVIEW_TOKEN="local-review-token" \
ENGINE_WORKER_CREDENTIALS='[{"token":"local-worker-token","workerId":"local-worker","capabilities":["collect_sources","create_content","check_content","produce_assets","deliver_package"]}]' \
DELIVERY_ADAPTER_URL="https://delivery.example.test/import" \
DELIVERY_ADAPTER_TOKEN="local-delivery-token" \
pnpm --filter @knowledge-bits/api exec tsx src/main.ts
```

Artifact storage is an injected `ArtifactStorageAdapter` passed to `createApp`. The production runtime
supports Cloudflare R2 when `ARTIFACT_STORAGE_MODE=r2` and the `ARTIFACT_STORAGE_R2_*` credentials are
present. The adapter issues short-lived signed PUT URLs, verifies the uploaded bytes and content type
server-side, and serves review reads only after the current package authorizes the artifact. Object keys
are server-owned and scoped as `knowledge-bits/nuglet/{runId}/{revision}/{artifactId}`.

The default API entrypoint remains unavailable until storage is explicitly configured. The R2 bucket and
credentials belong to this standalone engine. They are not Nuglet production database credentials. Set
`ARTIFACT_STORAGE_PUBLIC_BASE_URL=https://media.nuglet.app` for the future delivery/import adapter; review
reads currently go through the authenticated engine API.

Place the review deployment behind an identity proxy that injects a signed OIDC JWT on every request.
The app verifies the token against the configured issuer, audience, and JWKS before serving a page or
proxying a review read or decision. `Cf-Access-Jwt-Assertion` is the default header; set
`REVIEW_AUTH_HEADER` when the identity proxy uses another name.

```bash
ENGINE_API_URL="http://127.0.0.1:3000" \
ENGINE_REVIEW_TOKEN="local-review-token" \
REVIEW_AUTH_JWKS_URL="https://identity.example.test/.well-known/jwks.json" \
REVIEW_AUTH_ISSUER="https://identity.example.test" \
REVIEW_AUTH_AUDIENCE="knowledge-bits-review" \
REVIEW_AUTH_REQUIRED_GROUP="knowledge-bits-editors" \
REVIEW_PUBLIC_ORIGIN="http://127.0.0.1:4321" \
pnpm --filter @knowledge-bits/review exec astro dev --port 4321
```

The authenticated JWT subject becomes the recorded reviewer identity. Browser input cannot override
it. Review mutations also require the exact configured origin and a page-issued, cookie-bound CSRF
token. Missing identity or CSRF configuration fails closed. The review page displays every delivered
lesson field and the package checksum used by the single overall decision.

## Local worker

Workers run as separate one-shot processes, not in either web application. The API maps each bearer
token in `ENGINE_WORKER_CREDENTIALS` to a server-owned worker ID and capability list. The worker
receives only its own token:

```bash
ENGINE_API_BASE_URL="http://127.0.0.1:3000" \
ENGINE_WORKER_TOKEN="local-worker-token" \
WORKER_PROVIDER_MODE="production" \
NOTEBOOKLM_TRUSTED_SOURCE_HOSTS="example.org,research.example.edu" \
PI_PROVIDER="configured-pi-provider" \
PI_MODEL="configured-pi-model" \
MEDIA_GENERATION_COMMAND="/absolute/path/to/local-media-adapter" \
MEDIA_GENERATION_ARGS='["--json"]' \
pnpm --filter @knowledge-bits/worker exec tsx src/index.ts
```

Production mode runs NotebookLM, Pi/editorial, and media generation inside the local worker. The
control API supplies lease-scoped job inputs and permits reads only for declared artifact dependencies.
Each run must carry its own `notebookLmNotebookId`; the engine rejects assigning one NotebookLM notebook
to multiple runs. Do not configure a global NotebookLM notebook ID. Existing local manifests should be
reconciled into the run records before they are processed.
The worker captures exact trusted source bytes before accepting evidence, binds citations to those
snapshots, and passes content to the local Pi and media adapters. Provider calls and subprocesses use
bounded execution deadlines and propagated abort signals. Missing or invalid provider configuration
moves the affected stage to `needs_human`; production never falls back to fixture content.

Fixture mode reads committed provider responses from `WORKER_FIXTURE_DIRECTORY`. The clean proof
starts a fresh PostgreSQL container, provisions a restricted runtime login, runs every stage, interrupts
and reclaims a lease, authenticates the reviewer, approves once, and resumes delivery verification
without repeating the import:

```bash
TURBO_FORCE=true pnpm build
pnpm test:e2e
```

The fixture provider and fixture delivery adapter are test utilities. Do not select them in a real
worker or API deployment.

## Delivery

`DELIVERY_ADAPTER_URL` points to the service that imports an approved Knowledge Bits package.
`DELIVERY_ADAPTER_TOKEN` authenticates only that request. Delivery receives the persisted immutable
package version, approved checksum, and stable idempotency key. Once an import response is persisted,
a reclaimed delivery verifies that response instead of issuing another import. Retries from before a
persisted response reuse the same idempotency key.

The Nuglet delivery adapter remains inactive until the companion Nuglet integration plan passes. This
repository does not contain an active Nuglet adapter, and completing the fixture proof does not permit
one to be enabled.

## Vercel boundary

Use separate Vercel projects rooted at `apps/api` and `apps/review`, with source files outside each Root
Directory included so Vercel can resolve the pnpm workspace. Each app runs `pnpm install
--frozen-lockfile` and `pnpm build` from its root. The API catch-all routes to its Hono Vercel Function,
and the review build emits Astro Vercel SSR output. Do not create a Vercel project for `apps/worker`, and
do not run provider CLIs, worker loops, or migrations during a Vercel build.

The review project must sit behind the configured identity proxy. The API and review projects receive
only their own runtime secrets. Provider credentials stay with the local worker. Database owner or
migration credentials stay outside Vercel. Delivery secrets stay with the API. Fixture values are never
production credentials.

## Verification

Run the same checks as CI:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm scan:forbidden-credentials
TURBO_FORCE=true pnpm build
TURBO_FORCE=true pnpm test
TURBO_FORCE=true pnpm typecheck
git diff --check
```

`pnpm test` includes the clean PostgreSQL end-to-end proof. It exercises every stage, immutable source
snapshots, required claim coverage and media, worker restart and reclaim, authenticated checksum-bound
approval, restricted runtime grants, and package-bound delivery recovery.
