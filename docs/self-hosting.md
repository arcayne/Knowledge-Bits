# Self-hosting

Knowledge Bits supports two operating profiles. Use the local demo to inspect the workflow. Use the production profile only when you can operate separate credentials, identity, storage, backups, and provider workers.

## Local demo profile

The demo uses PostgreSQL 16 in Docker, fixture providers, local filesystem artifact storage, and local delivery receipts. `.env.demo.example` contains throwaway localhost values. It must not be used as a production environment file.

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
cp .env.demo.example .env.demo
pnpm local-demo setup
pnpm local-demo start
pnpm local-demo seed
pnpm local-demo demo
```

The demo binds the API and review app to loopback addresses. It has no provider credentials, destination URL, destination token, R2 credentials, or migration-owner URL. The local reviewer name is configuration, not an authenticated identity boundary. Do not expose these ports beyond localhost.

Use `pnpm local-demo status` to inspect state. Use `pnpm local-demo stop` to stop processes. Use `pnpm local-demo reset` to remove only the demo's container, volume, artifacts, receipts, logs, and state.

## Optional production profile

A production deployment is an operational choice, not a requirement for development. Separate these components:

- **API:** engine runtime database URL, API/review/worker credential configuration, artifact storage configuration, and destination delivery configuration.
- **Review app:** API URL and an identity-provider issuer, audience, JWKS URL, required group, and origin. Put it behind the identity provider.
- **Worker:** worker token, recipe roots, and only the provider credentials needed for its actions. Keep provider sessions on the worker host.
- **Migration runner:** migration-owner URL, used only during migration. Never pass it to the API runtime.
- **Artifact storage:** an engine-owned R2 bucket or another adapter with a restricted scope. The API must inspect uploaded bytes.
- **Destination:** a scoped delivery URL and token. The destination remains responsible for its own authorization and database transaction.

Do not use a Nuglet production database URL, service-role key, user credential, billing credential, or general media credential in Knowledge Bits. Do not share one credential across API, review, worker, migration, and destination roles.

## Database and migrations

For a local test database, set `TEST_DATABASE_URL` to a localhost PostgreSQL database whose name includes `test`, then run the guarded migration helper:

```bash
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/knowledge_bits_test \
  pnpm --filter @knowledge-bits/api prisma:migrate
```

For a production database, provide distinct owner and runtime URLs. The production helper rejects missing URLs and matching usernames:

```bash
ENGINE_DATABASE_URL=postgresql://runtime-user:password@db.example/knowledge_bits \
ENGINE_MIGRATION_DATABASE_URL=postgresql://migration-owner:password@db.example/knowledge_bits \
  pnpm --filter @knowledge-bits/api prisma:migrate:production
```

Use `pnpm prisma:generate` after dependency or schema changes. Review migrations before applying them. Do not run production migrations from a web build or with the runtime login.

## Persistence and backup

PostgreSQL stores workflow coordination, package versions, approvals, artifact metadata, and delivery history. Artifact bytes live in the configured artifact storage. Back up both stores as one recovery set, and retain the database-to-object-store relationship by preserving run IDs, revisions, storage keys, and checksums.

Before an upgrade:

1. Stop or drain workers that can claim affected jobs.
2. Record the current migration version and deployment revision.
3. Back up PostgreSQL and artifact objects.
4. Apply the reviewed migration.
5. Start the API and verify health and schema compatibility.
6. Start workers and inspect one staged run before resuming normal capacity.

For restore, restore PostgreSQL and artifact objects from the same point-in-time set. Verify object checksums and package references before processing or delivering runs. A database-only restore is incomplete when artifact bytes are missing.

## Authentication and network binding

The local demo binds to `127.0.0.1`. Keep this binding for local work. Production review requires an identity-provider assertion, configured issuer, audience, JWKS, and group. Review mutations also require the configured origin and a cookie-bound CSRF token. API and worker credentials are bearer secrets; store them in the deployment secret manager.

Do not expose a fixture API, local review token, local worker token, filesystem artifact directory, or database port to a public network. TLS termination, rate limiting, log redaction, secret rotation, and identity-provider policy are deployment responsibilities.

## Provider credentials

The demo has none. Provider credentials are optional for production and belong only in the worker environment. The API does not need NotebookLM, model, or media-provider credentials. Missing production provider configuration must stop or defer the affected stage; it must never cause fixture fallback.
