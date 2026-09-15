# Knowledge Bits

Knowledge Bits is an evidence-backed content operations engine. It turns a brief and trusted source material into a checked, human-approved, multi-format `KnowledgeBits` package.

## Portable local demo

The local demo is the fastest way to inspect the complete workflow. It runs the normal API, review app, and fixture worker against PostgreSQL 16. It uses committed fixture responses, local filesystem artifacts, and local delivery receipts. It does not require a provider account or provider credentials.

Requirements:

- Node.js 24 (`>=24 <25`)
- pnpm 9.12.0
- Docker with Compose support

Run:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
cp .env.demo.example .env.demo
pnpm local-demo setup
pnpm local-demo start
pnpm local-demo seed
pnpm local-demo status
pnpm local-demo demo
```

`demo` prints a run ID, review URL, and package checksum. Open the review URL and inspect the package before approving it. Approval is never automatic. For the explicit command-line approval path, use `pnpm local-demo demo --approve` only after inspection. To regenerate one bounded asset and require approval again, use `pnpm local-demo demo --revise`. The `--revise` path requires the target run to still be at the pending human review stage. It can fail after approval or as delivery progresses.

The demo writes process state, logs, artifacts, and delivery receipts below `.local-demo/`. PostgreSQL data is held in the named Docker volume `knowledge-bits-local-demo-postgres-data`. Stop processes with `pnpm local-demo stop`; remove only demo state with `pnpm local-demo reset`.

To verify restart persistence, run this sequence:

```bash
pnpm local-demo stop
pnpm local-demo start
pnpm local-demo status
```

API and review startup is asynchronous. Wait for both services to become healthy. If the first `status` call shows `run: null`, run `pnpm local-demo status` again.

After the restart, `status` should show the same run ID and current revision as before the restart. Existing local delivery receipts should remain present. This sequence does not reset the run, revision, artifacts, or receipts.

For a direct review-app run outside the bundled demo, configure the server-side API and identity settings before starting Astro:

```bash
ENGINE_API_URL="http://127.0.0.1:3000"
REVIEW_AUTH_JWKS_URL="https://identity.example.test/.well-known/jwks.json"
REVIEW_AUTH_ISSUER="https://identity.example.test/"
REVIEW_AUTH_AUDIENCE="knowledge-bits-review"
REVIEW_PUBLIC_ORIGIN="http://127.0.0.1:4323"
pnpm --filter @knowledge-bits/review exec astro dev --host 127.0.0.1 --port 4323
```

Use a real identity provider and HTTPS origin for production. The example values above are placeholders for local configuration documentation.

## What is supported

The current implementation supports one content target: `nuglet.lesson.v1`. Its six stages are research, create, check, produce assets, human review, and delivery. The initial delivery integration is Nuglet, but provider-backed integrations are optional. Fixture adapters make the workflow testable without external services.

### Nuglet example

The checked-in Nuglet example is **Return to one task**. Its brief asks: “Help an adult learner return to one task after an interruption.” The fixture run produces a story/playbook package with source evidence, checks, media artifacts, approval, and a local delivery receipt. A package can contain a story, a playbook, a challenge, editorial QA evidence, a hero, an infographic, and brief and discussion audio. The package preserves source snapshots, citations, checks, artifact checksums, revision history, approval, and delivery history.

No redistributable screenshot is included at present. Screenshots are intentionally omitted until an asset with confirmed redistribution rights is available.

## Limitations

- This is a repository and workflow implementation, not a hosted service.
- V1 does not provide a general-purpose content marketplace, billing, x402, or multi-tenant administration.
- Production provider execution requires separately configured provider tools and credentials. The demo never falls back to production providers.
- Production review must be placed behind an identity provider. The local reviewer identity is only a demo convenience.
- A local delivery receipt is not a public publication.
- Generated content and provider output require human review. This project does not promise factual correctness, uninterrupted availability, or suitability for a particular use.
- Project-owned software and general documentation are licensed under the [MIT License](LICENSE). Third-party fonts, media, source material, and other assets retain their own terms; see [License and rights](docs/license-and-rights.md) and [Third-party notices](THIRD_PARTY_NOTICES.md).

## Optional production integrations

A production profile can use a restricted PostgreSQL runtime role, Cloudflare R2 through the artifact-storage adapter, configured provider adapters on a worker, an identity-protected review app, and a scoped destination delivery adapter. Keep migration credentials, provider credentials, and destination credentials out of the demo and out of source control. See [Self-hosting](docs/self-hosting.md) for the separation rules.

## Local worker

An optional production local-worker profile is separate from the local demo. Provider credentials and product recipe roots stay on the worker host; they are not part of the API or review deployment. Production mode does not use fixture fallback, so the required provider configuration must be available on that host.

From the repository root, configure the worker host with safe, environment-specific values such as:

```bash
WORKER_PROVIDER_MODE="production"
PRODUCT_RECIPE_ROOTS='{"nuglet.lesson.v1":"/absolute/path/to/knowledge-bits/recipes/nuglet.lesson.v1"}'
pnpm --filter @knowledge-bits/worker exec tsx src/index.ts
```

The recipe-root example is a placeholder path only. Do not put provider credentials in source control.

### NotebookLM provider

The production worker invokes the `nlm` command from the external [`notebooklm-mcp-cli`](https://github.com/jacob-bd/gemini-notebook-mcp-cli) project. Knowledge Bits does not vendor this tool or include it in the Node workspace dependencies. Install it on the worker host, then authenticate it with the Google account that owns the NotebookLM notebooks:

```bash
uv tool install notebooklm-mcp-cli
nlm --version
nlm login
```

The worker uses `nlm` by default. Set `NOTEBOOKLM_COMMAND` when the executable is installed at a different path. This integration depends on NotebookLM's undocumented interfaces, so the external CLI and its authentication flow can change independently of Knowledge Bits. The local demo uses fixtures and does not require this provider.

## Delivery

Production delivery uses a configured destination adapter. Keep destination credentials outside source control and configure the adapter through the deployment environment; endpoint values are deployment-specific and are not documented here.

## Documentation

- [Architecture](docs/architecture.md)
- [Adapters](docs/adapters.md)
- [Self-hosting](docs/self-hosting.md)
- [Compatibility policy](docs/compatibility.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Community behavior](CODE_OF_CONDUCT.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [License and rights](docs/license-and-rights.md)
- [Public release rights inventory](docs/release-rights.md)

## Checks

Run the repository checks before opening a pull request:

```bash
pnpm scan:forbidden-credentials
TURBO_FORCE=true pnpm build
TURBO_FORCE=true pnpm typecheck
TURBO_FORCE=true pnpm test
pnpm local-demo --help
git diff --check
```

The project is not a publication, licensing, or security guarantee. Review [Security](SECURITY.md) before running any non-demo deployment.
