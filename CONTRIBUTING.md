# Contributing

Thank you for proposing an improvement. Keep changes small, evidence-based, and within the repository's documented scope.

## Before you start

Read:

- [Architecture](docs/architecture.md)
- [Adapters](docs/adapters.md)
- [Compatibility policy](docs/compatibility.md)
- [Security reporting](SECURITY.md)
- [License and rights](docs/license-and-rights.md)
- [Public release rights inventory](docs/release-rights.md)

Project-owned software and general documentation are licensed under the [MIT License](LICENSE). Submit only material that you have the right to share. Do not add credentials, private links, account identifiers, local paths, or third-party or product-owned assets without confirmed permission.

## Setup

Use Node 24 and pnpm 9.12.0. Install with the committed lockfile:

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
```

Docker is required for the local PostgreSQL proof. Start the portable local demo with:

```bash
cp .env.demo.example .env.demo
pnpm local-demo setup
pnpm local-demo start
pnpm local-demo seed
pnpm local-demo demo
```

The demo uses fixture providers and local delivery. It does not need provider or destination credentials. Reset only demo state with `pnpm local-demo reset`.

## Validation

Run the narrowest relevant checks, then the full repository checks when practical:

```bash
pnpm scan:forbidden-credentials
pnpm --filter @knowledge-bits/worker test
pnpm --filter @knowledge-bits/api test
TURBO_FORCE=true pnpm build
TURBO_FORCE=true pnpm typecheck
TURBO_FORCE=true pnpm test
pnpm local-demo --help
git diff --check
```

If a check needs a database, use a local test database through the guarded migration helper. Never use a production database or provider credential for a test. Remove generated artifacts and local environment files from the change.

## Scope rules

- Preserve the six-stage workflow and API ownership of state transitions.
- Keep provider and destination behavior behind adapters.
- Preserve immutable artifacts, checksums, lease fencing, approval binding, and delivery idempotency.
- Do not weaken authentication, CSRF checks, runtime database isolation, artifact scope, or credential scanning.
- Do not silently broaden `nuglet.lesson.v1` compatibility. Update the compatibility policy when a contract changes.
- Keep project-owned software and general documentation under the MIT license. Preserve separate terms for third-party material and identify any asset whose redistribution rights are unresolved.
- Do not publish, change repository visibility, rewrite history, or alter production code as part of a documentation-only change.

## Pull request process

1. Explain the problem and the smallest proposed change.
2. List the files changed and commands run.
3. Identify schema, checksum, migration, security, rights, and compatibility effects.
4. Include tests or a reason that no test is applicable.
5. Remove secrets and private operational details from the branch and description.
6. Wait for maintainer review. Do not merge your own change unless repository policy explicitly permits it.

Reviewers check correctness, scope, security boundaries, compatibility, evidence, and documentation. Changes that alter package contracts, checksums, migrations, authentication, or delivery require focused maintainer review and an upgrade note.

## Maintainer expectations

Maintainers should acknowledge actionable reports, keep review decisions explicit, explain requested changes, and avoid accepting material with unclear rights. For this release, @arcayne owns maintainer review, security triage, and release authority until this file is updated.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Use the [bug report](.github/ISSUE_TEMPLATE/bug-report.yml) or [feature request](.github/ISSUE_TEMPLATE/feature-request.yml) template for public issues. Report suspected vulnerabilities using [SECURITY.md](SECURITY.md), not a public issue.
