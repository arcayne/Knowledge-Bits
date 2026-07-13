# Knowledge Bits

Knowledge Bits is a standalone content workflow engine. It owns its database, worker authentication,
provider execution, review package, approval record, and delivery history. It does not read Nuglet
production credentials or write to Nuglet directly.

The workflow has six stages: research, create, check, produce assets, human review, and delivery. A
worker lease protects each automated stage. Human review makes one decision over the complete package
checksum. Approval queues delivery for that exact immutable package version.

## Requirements

- Node 24
- pnpm 9.12.0
- PostgreSQL 16 or a separate Supabase PostgreSQL project
- Docker for the clean end-to-end fixture test

Install and generate the Prisma client:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
```

## Database

Create a Supabase project dedicated to Knowledge Bits. Do not reuse a Nuglet project, database,
service role key, connection pool, or migration history. Store its PostgreSQL connection string as
`ENGINE_DATABASE_URL`.

Apply the committed migrations to the dedicated database:

```bash
ENGINE_DATABASE_URL="postgresql://..." \
  pnpm --filter @knowledge-bits/api exec prisma migrate deploy
```

For a local throwaway database whose name contains `test`, the guarded migration helper is available:

```bash
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/knowledge_bits_test" \
  pnpm --filter @knowledge-bits/api prisma:migrate
```

The engine rejects `DATABASE_URL` and the forbidden Nuglet database and Supabase credential variables.
CI also scans tracked files for credential assignments, project URLs, and token-shaped values.

## API And Review

The API requires its database, API token, review token, fixed reviewer identity, worker credential map,
delivery adapter URL, and delivery adapter token. Start the Node API with:

```bash
ENGINE_DATABASE_URL="postgresql://..." \
ENGINE_API_TOKEN="local-api-token" \
ENGINE_REVIEW_TOKEN="local-review-token" \
ENGINE_REVIEWER_ID="local-editor" \
ENGINE_WORKER_CREDENTIALS='[{"token":"local-worker-token","workerId":"local-worker","capabilities":["collect_sources","create_content","check_content","produce_assets","deliver_package"]}]' \
DELIVERY_ADAPTER_URL="https://delivery.example.test/import" \
DELIVERY_ADAPTER_TOKEN="local-delivery-token" \
pnpm --filter @knowledge-bits/api exec tsx src/main.ts
```

Artifact storage is an injected `ArtifactStorageAdapter` passed to `createApp`. A real host must inject
an adapter that prepares uploads, inspects stored checksums and media types, and reads review bytes.
The default API entrypoint deliberately uses the unavailable adapter, so it cannot accept artifacts
until the host provides storage. The end-to-end test injects an isolated in-memory fixture adapter and
does not contact object storage.

Start the review app on port 4321:

```bash
ENGINE_API_URL="http://127.0.0.1:3000" \
ENGINE_REVIEW_TOKEN="local-review-token" \
pnpm --filter @knowledge-bits/review exec astro dev --port 4321
```

The review server holds the review token and reviewer identity boundary. Browser requests do not set
or forward a reviewer identity. The review page displays the package checksum used by the single
overall approve or request changes decision.

## Workers And Providers

Workers run as separate one-shot processes. They are not hosted in either web application. The API
maps each bearer token in `ENGINE_WORKER_CREDENTIALS` to a server-owned worker ID and capability list.
The worker receives only its own token:

```bash
ENGINE_API_BASE_URL="http://127.0.0.1:3000" \
ENGINE_WORKER_TOKEN="local-worker-token" \
WORKER_PROVIDER_MODE="production" \
PROVIDER_CONTEXT_URL="https://providers.example.test/context" \
PROVIDER_CONTEXT_TOKEN="local-provider-context-token" \
PI_EDITORIAL_URL="https://providers.example.test/editorial" \
PI_EDITORIAL_TOKEN="local-editorial-token" \
MEDIA_GENERATION_URL="https://providers.example.test/media" \
MEDIA_GENERATION_TOKEN="local-media-token" \
pnpm --filter @knowledge-bits/worker exec tsx src/index.ts
```

Production mode uses the configured provider context service, the local NotebookLM CLI process, the
editorial service, and the media service. Missing production configuration produces a typed human or
waiting result. It never falls back to fixture content.

Fixture mode reads committed provider responses from `WORKER_FIXTURE_DIRECTORY`. The Task 10 proof
starts a clean PostgreSQL container, injects fixture storage, runs the package fixture, interrupts and
reclaims a lease, approves once, and verifies an idempotent delivery retry:

```bash
pnpm build
pnpm test:e2e
```

The fixture provider and fixture delivery adapter are test utilities. They must not be selected in a
real worker or API deployment.

## Delivery

`DELIVERY_ADAPTER_URL` points to the service that imports an approved Knowledge Bits package.
`DELIVERY_ADAPTER_TOKEN` authenticates only that request. Delivery receives the persisted immutable
package version, approved checksum, and stable idempotency key. A retry reuses that key so a destination
can return `already_imported` without creating a duplicate.

The Nuglet delivery adapter remains inactive until the companion Nuglet integration plan passes. This
repository does not contain an active Nuglet adapter, and completing this fixture proof does not permit
one to be enabled.

## Vercel Boundary

Use separate Vercel projects rooted at `apps/api` and `apps/review`, with source files outside each
Root Directory included so Vercel can resolve the pnpm workspace. Each app runs its commands directly
from that root: `pnpm install --frozen-lockfile` and `pnpm build`. The API catch-all routes to its Hono
Vercel Function, and the review build emits Astro Vercel SSR output. Do not create a Vercel project
for `apps/worker`, and do not run provider CLIs, worker loops, or migrations during a Vercel build.

The API and review projects receive only their own runtime secrets. Provider credentials stay with the
external worker runtime. Database owner or migration credentials stay outside Vercel. Delivery secrets
stay with the API. Fixture values are never production credentials.

## Verification

Run the same checks as CI:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm scan:forbidden-credentials
pnpm build
pnpm test
pnpm typecheck
```

`pnpm test` includes the clean PostgreSQL end-to-end fixture. It exercises every stage, required source
citations and media, worker restart and reclaim, checksum-bound approval, package-bound delivery, and
the `already_imported` retry path.
