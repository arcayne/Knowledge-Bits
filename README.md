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

Engineering delivery controls:

- [System map](docs/engineering/system-map.md)
- [Change risk map](docs/engineering/risk-map.md)
- [Independent reviewer-agent pilot](docs/engineering/independent-review.md)
- [Historical PR baseline](docs/engineering/pr-baseline.csv)

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
DELIVERY_ADAPTER_URL="https://api.nuglet.app/internal/knowledge-bits" \
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

The review app root is the pipeline dashboard. It reads the authenticated `GET /pipeline` API view,
shows one current row per run identity, groups rows by stage, and links each row to `/runs/{runId}` for
the full human review surface. The API also exposes authenticated progressive preview reads at
`GET /runs/{runId}/preview` and `GET /runs/{runId}/artifacts/{artifactId}`.

## Local worker

Workers run as separate one-shot processes, not in either web application. The API maps each bearer
token in `ENGINE_WORKER_CREDENTIALS` to a server-owned worker ID and capability list. The worker
receives only its own token:

```bash
ENGINE_API_BASE_URL="http://127.0.0.1:3000" \
ENGINE_WORKER_TOKEN="local-worker-token" \
WORKER_PROVIDER_MODE="production" \
PRODUCT_RECIPE_ROOTS='{"nuglet.lesson.v1":"/absolute/path/to/knowledge-bits/recipes/nuglet.lesson.v1"}' \
PI_PROVIDER="configured-pi-provider" \
PI_MODEL="configured-pi-model" \
MEDIA_GENERATION_COMMAND="/opt/homebrew/bin/node" \
MEDIA_GENERATION_ARGS='["/absolute/path/to/knowledge-bits/apps/worker/scripts/nuglet-media-command.mjs"]' \
pnpm --filter @knowledge-bits/worker exec tsx src/index.ts
```

Production mode runs NotebookLM, Pi/editorial, and media generation inside the local worker.
The Nuglet recipe registry, media command, and approved visual style references live in this repository.
The worker does not depend on `apps/nuglet-lab` or any other Nuglet source checkout.
Infographic recipe `2.0.0` uses Vertex AI only for a bounded art-direction JSON decision. Nuglet's
deterministic SVG renderer then typesets the checked lesson copy with bundled fonts and draws the final
9:16 visual summary. Older recipe versions remain pinned to their historical NotebookLM generation path.
NotebookLM Shorts are post-processed locally with `ffmpeg`, `ffprobe`, and `pango-view`: the provider
tail is removed, the real Nuglet footer and Focus Aperture end card are added, and the exact title and
CTA use bundled Nuglet fonts. The result remains `needs_review` until a human approves it.
The worker will not start unless `PRODUCT_RECIPE_ROOTS` contains a non-empty mapping from each product
content kind to its absolute local recipe directory. These filesystem paths remain local to the worker.
The control API supplies lease-scoped job inputs and permits reads only for declared artifact dependencies.
Each run must carry its own `notebookLmNotebookId`; the engine rejects assigning one NotebookLM notebook
to multiple runs. Do not configure a global NotebookLM notebook ID. Existing local manifests should be
reconciled into the run records before they are processed.
When Pi is configured for Google Vertex, the Research task reuses that model and ADC configuration with
Vertex Google Search grounding to propose a bounded independent source set. The grounding metadata is
read at the provider boundary because Pi's normalized assistant response does not expose source URLs.
Candidate URLs are untrusted: the worker permits only public HTTPS targets, resolves and rejects private
network addresses, retrieves bounded HTML, text, or PDF bytes, and imports only accepted sources into
NotebookLM. Exact retrieved bytes become immutable source snapshots. The worker then reads the notebook's
source inventory directly from the NotebookLM CLI and records every healthy HTTPS source as an immutable
receipt. A generative NotebookLM answer cannot silently narrow that authoritative inventory. Later content
citations bind back to those snapshots before content passes to the local Pi and media adapters. Provider
calls and subprocesses use bounded execution deadlines and propagated abort signals. Missing or invalid
provider configuration
moves the affected stage to `needs_human`; production never falls back to fixture content.

### Starting a new Nuglet

Start from ordinary text, screenshots, quotes, or source hints with the
project-local [`$start-nuglet` skill](./.agents/skills/start-nuglet/SKILL.md).
It drafts the intake, checks every existing run for related content, confirms the proposed run,
creates a fresh dedicated NotebookLM notebook, and returns the review link;
it never approves, publishes, or delivers content.

Run the non-billable deterministic preflight before creating the notebook. It compares the proposed
title, learner objective, and concept signals with all in-progress and completed Knowledge Bits runs:

```bash
ENGINE_API_BASE_URL="http://127.0.0.1:3000" \
ENGINE_API_TOKEN="..." \
pnpm check:nuglet-similarity -- \
  --title "Why you cannot focus after short videos" \
  --objective "Explain the mechanism and give one kind action to rebuild focus." \
  --audience "Adults rebuilding attention"
```

If the result is clear—or the operator explicitly decides that a related idea has a distinct learner
objective—create a new NotebookLM notebook named `Nuglet: <title>`. A new Nuglet always gets a new
notebook; an existing notebook remains bound to its existing run.

Operators can then start the research run from the review dashboard at `/`, or use the matching CLI.
Both paths require that fresh dedicated NotebookLM notebook ID and create the same research brief:

```bash
ENGINE_API_BASE_URL="http://127.0.0.1:3000" \
ENGINE_API_TOKEN="..." \
KNOWLEDGE_BITS_REVIEW_URL="http://127.0.0.1:4321" \
pnpm new:nuglet -- \
  --title "Why you cannot focus after short videos" \
  --objective "Explain the mechanism and give one kind action to rebuild focus." \
  --audience "Adults rebuilding attention" \
  --notebook "notebooklm-uuid" \
  --source "https://example.com/credible-source"
```

The CLI repeats the similarity preflight. When related runs exist, it stops and prints them unless the
operator reruns it with `--confirm-distinct`; the API also rejects a stale preflight or an unconfirmed
related match. The command then prints the review URL immediately. The run starts in Research; the worker uses the
NotebookLM notebook and any starting URLs, records the accepted source list, and advances the run as
each stage becomes ready. The dashboard refreshes automatically and has a manual Refresh button.
The client submits only the research brief and the `story_playbook` intake marker. The trusted API
binds that marker to the repository's approved Story, Playbook, challenge, QA, and media recipes before
the Research job is persisted. Clients never construct or sign generation plans.

If an unapproved Create run needs human intervention because its notebook evidence was incomplete, a
review-authenticated operator may add sources to that same notebook and call
`POST /runs/{runId}/refresh-research`. The API atomically clears the stale package checksum, requeues
Research in a new revision, and makes the refreshed evidence the only research dependency of the next Create job. It
rejects approved runs, active jobs, and any attempt to change the run's NotebookLM notebook.

### Reusing approved Nuglet media

A published Nuglet migration generates only its new Story and Playbook. Its approved hero,
infographic, Brief audio, and Discussion audio are copied into a local migration bundle first, then
uploaded by the normal asset job into immutable Knowledge Bits R2 keys. The source inventory accepts
local files, HTTPS URLs, or public Nuglet R2 object keys. It never needs Nuglet database credentials.

Start from [`examples/nuglet-migration.inventory.example.json`](./examples/nuglet-migration.inventory.example.json),
fill all four approved assets, then run:

```bash
NUGLET_MEDIA_PUBLIC_BASE_URL="https://media.nuglet.app" \
pnpm --filter @knowledge-bits/worker migration:prepare -- \
  /absolute/path/to/inventory.json \
  /absolute/path/to/knowledge-bits-migration-bundles
```

The command verifies any supplied source checksum and byte size, rejects identical Brief and
Discussion audio, copies the exact bytes, and writes `legacy-media-reuse.json` inside the inventory's
`sourcePackagePath`. Put that receipt in `generationPlan.legacyMediaReuse` and set
`generationPlan.mediaMode` to `reuse_legacy`. After QA passes, the engine schedules all four assets as
`attach_existing`; the worker does not regenerate them. Configure `NUGLET_LEGACY_REUSE_ROOT` with the
same migration-bundle root when running the worker so the local media adapter can read those receipts.

### Local supervisor

Supabase is the durable workflow ledger. It does not run NotebookLM, Vertex, or local provider tools.
On the Mac that has those provider sessions and credentials, install the local supervisor to keep the
API and review UI available and start a bounded worker tick every five minutes:

```bash
git clone git@github.com:arcayne/Knowledge-Bits.git ~/Developer/knowledge-bits
cd ~/Developer/knowledge-bits
KNOWLEDGE_BITS_ENV_FILE="/absolute/path/to/knowledge-bits/.env" \
  scripts/local-supervisor/install-launchd.zsh
```

The runtime checkout must live outside macOS protected folders such as `Documents`, `Desktop`, and
`Downloads`. `launchd` cannot reliably read provider scripts from those folders. A development checkout
can still run a temporary clock from an interactive terminal, but that temporary process does not restart
after a Mac restart.

The API is restarted automatically if it exits. The worker is a one-shot process: each five-minute tick
selects one eligible run, advances up to `ENGINE_WORKER_MAX_JOBS_PER_TICK` consecutive stages for that
run, and exits. A recoverable filesystem lock prevents overlapping ticks when a provider call takes
longer than five minutes. Provider cooldowns remain in the Supabase ledger as `waiting` jobs; later
ticks continue with other eligible work. The worker log records a `worker_tick_started` and
`worker_tick_completed` JSON line for every real tick, including the run id, job count, duration, and
stop reason. On login or reinstall, the worker waits for the local API health probe before claiming
work, so an API startup race cannot consume the first tick.

The review UI is also restarted automatically and is available at
`http://127.0.0.1:4323`. Set `REVIEW_LOCAL_OPERATOR_ID` in the supervisor environment file to a stable
local operator name. The local review service always talks to `KNOWLEDGE_BITS_LOCAL_API_URL`; production
review authentication remains separate. The supervisor prefers Homebrew's `node@24` runtime, matching
the repository and Vercel runtime contract, without changing the machine's default interactive Node.

### Branded infographic replacement rounds

Use the operator-only campaign command to move existing Nuglets to the current branded infographic
recipe in small, review-only rounds. `preflight` reads the checked package and renders it locally without
calling Vertex. `run` queues and executes one run at a time, pins every worker tick to that run, verifies
the stored PNG bytes and checksum, and stops each package at Human Review. It never approves or delivers.

```bash
set -a
source /absolute/path/to/supervisor.env
set +a

pnpm infographic:campaign preflight
pnpm infographic:campaign run --limit 5
pnpm infographic:campaign status
```

The resumable state file defaults to
`.local-supervisor/infographic-replacement-campaign-v2.json`. It contains workflow identifiers,
checksums, review links, and outcomes only; credentials are never persisted. The command excludes
already-current, rejected, and active pipeline runs, and stops the entire round on the first failed
generation or verification.

The supervisor writes only local logs and local filesystem artifacts under the repository:

```text
.local-supervisor/api.log
.local-supervisor/review.log
.local-supervisor/worker.log
.local-artifacts/
```

To stop it later:

```bash
launchctl bootout "gui/$(id -u)/app.knowledge-bits.api"
launchctl bootout "gui/$(id -u)/app.knowledge-bits.review"
launchctl bootout "gui/$(id -u)/app.knowledge-bits.worker-tick"
```

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

`DELIVERY_ADAPTER_URL` is the destination's base endpoint. For Nuglet, use
`https://api.nuglet.app/internal/knowledge-bits`; the adapter calls `/import` and `/verify` beneath it.
`DELIVERY_ADAPTER_TOKEN` must match Nuglet backend's `KNOWLEDGE_BITS_IMPORT_TOKEN` and authenticates
only those server-to-server requests. Delivery receives the persisted immutable package version,
approved checksum, and stable idempotency key. Once an import response is persisted, a reclaimed
delivery verifies that response instead of issuing another import. Retries from before a persisted
response reuse the same idempotency key.

Nuglet delivery remains dry-run only. Every approved Knowledge Bits package must already have an exact
package-to-lesson mapping in Nuglet. Import validation records an immutable receipt and returns the
existing canonical lesson preview without changing its slug, SEO metadata, or published content.

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
