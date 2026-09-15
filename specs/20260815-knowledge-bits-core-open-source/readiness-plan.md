# Open-source readiness plan

Date: 2026-09-14
Status: published clean-history candidate with MIT, rights inventory, named owners, and green release checks.

## Outcome and scope

Prepare Knowledge Bits itself for open-source release, including its Nuglet implementation. A new contributor should be able to run a local workflow, inspect its evidence and package, approve its exact revision, and verify delivery to a local destination.

The owner confirmed that Nuglet information may be public. Nuglet schemas, recipes, prompts, branding, integrations, product documentation and examples are eligible for inclusion. This supersedes the private Nuglet boundary and mandatory core extraction in spec.md and notes.md.

Keep the existing monorepo structure. A separate generic core, product renaming and removal of Nuglet dependencies are not release prerequisites. Audit the repository and its history before choosing between publishing the existing repository and a clean-history release. Nuglet confidentiality alone is no longer a reason to discard history.

Credentials, personal or customer data, account/session files and third-party redistribution rights remain excluded unless the [public release rights inventory](../../docs/release-rights.md) records a basis. Permission to share Nuglet information does not establish ownership of third-party source text or media.

## Current findings

These findings come from file inspection, not a new test run or a full security audit.

| Area | Observed state | Work needed |
| --- | --- | --- |
| Workflow and contracts | Stages, package building and Nuglet payloads exist. | Retain them; document behavior and verify approval/delivery invariants. |
| Database | PostgreSQL via Prisma, with provider metadata on runs. | Keep PostgreSQL for v0.1 and automate local setup. |
| Worker and delivery | Fixture provider and fixture destination implementations exist. | Connect them into a documented local demo. |
| Review | Dashboard and review UI contain Nuglet intake and media controls. | Reuse the UI; make unavailable integrations clear in demo mode. |
| Setup | README and .env.example include production provider mode, deployment values and Mac paths. | Separate portable demo configuration from optional production integrations. |
| CI | Quality workflow installs, builds, tests, typechecks and runs a credential scanner. | Verify it from a clean environment without maintainer credentials. |
| Credential checks | Scanner covers selected patterns in current files and reachable history. | Publish only the clean-history candidate after the old refs are removed. |
| Community files | Root license, contribution guide, security policy and code of conduct are tracked. | Keep named ownership current. |
| Local state | The source checkout remains dirty outside this candidate worktree. | Publish only the clean-history candidate; preserve the dirty checkout. |

## Ordered implementation work

### 1. Audit publishable contents and history

Create a release inventory for tracked files, intended additions, historical Git objects and release assets. Include Nuglet material where the owner authorized publication and `docs/release-rights.md` records the basis. Exclude live-account registries, migration inventories with local paths, internal agent reports, source snapshots, media, and fixtures without redistribution rights.

Exclude local environments, credentials, session/account state, caches and scratch artifacts. Review .gitignore against the local tool directories present. A public Nuglet URL or product name is not itself a finding; configuration still needs review for sensitive values and accidental live execution.

Record findings without copying secret values into reports. If an exposed credential is found, address the credential itself as well as file/history exposure. Choose history retention based on the audit. Do not rewrite history during planning.

Acceptance: release contents are enumerated, findings have resolutions, third-party notices are identified, and the history strategy is recorded.

### 2. Deliver one complete local demo

Use PostgreSQL 16, filesystem artifacts, the fixture worker, a local destination and the existing review UI. Keep the six stages and current Nuglet package format.

Add compose.yaml, a portable demo .env.example, setup and seed commands, and start/stop/reset instructions. Generate local credentials and bind demo services to localhost. Local reviewer identity must come from server configuration and be unavailable in production mode. Production endpoints and paid providers must not run by default.

Use a redistributable Nuglet example with bundled source evidence and fixture outputs. Synthetic inputs remain useful for reproducibility, but are not a confidentiality requirement. Label simulated generation clearly. Show approval and delivery, then a package revision that requires approval again.

Acceptance: a fresh environment follows the README through a visible delivery receipt without provider accounts or paid calls. Restart preserves the run. After setup downloads, the fixture workflow requires no external services.

### 3. Document real integrations and contributions

Keep existing NotebookLM, Vertex, media and Nuglet destination code where eligible. Document accounts, tools, credentials, costs, supported environment and limitations separately from the demo. Identify destination services outside this repository. Open-sourcing a client does not supply its backend or service access.

Add or rewrite:

- README.md: purpose, Nuglet example, screenshot, quickstart, supported scope and limitations.
- docs/architecture.md: stages, state ownership, evidence, checksums, approval and delivery.
- docs/adapters.md: existing extension points and one complete customization example.
- docs/self-hosting.md: configuration, migrations, persistence, backup/restore and authentication.
- docs/compatibility.md: package/schema versions, upgrade rules and runtime requirements.
- CONTRIBUTING.md: setup, tests, review process and maintainer expectations.
- SECURITY.md: supported versions and a working private reporting channel.
- LICENSE, third-party notices, CODE_OF_CONDUCT.md, issue templates and a PR template.

Apply MIT to project-owned software and general documentation. Use the rights inventory for project-owned prompts, recipes, branding, media, and third-party terms. Keep trademarks separate from the software license.

Acceptance: contributors need no internal instructions or private links to run the demo; integration prerequisites, license coverage and reporting contacts are complete.

### 4. Verify public CI and release behavior

Run install, build, typecheck, workspace tests, database tests and the local review/delivery flow without private credentials. Add general secret scanning, dependency/license inventory and unintended-file checks. Review generated output and release assets. Keep public pull-request checks independent of credentialed deployment jobs.

Verify that changed package bytes invalidate approval, an expired lease cannot complete a job, delivery rejects an unapproved or mismatched checksum, and retries do not duplicate delivery. Preserve existing Nuglet checksum behavior.

Include evaluation tooling and corpora that pass the content/rights audit. Keep a deterministic, credential-free lane; document provider-backed evaluations separately. Demonstrate that seeded citation, integrity, approval and delivery failures fail the relevant checks. Describe injection/safety fixtures as tests of specific cases, not universal guarantees.

Acceptance: checks pass from a clean clone and fail seeded negative cases. Record results and unresolved limitations for the release candidate.

### 5. Prepare and publish v0.1

Prepare a one-commit candidate using the clean-history strategy. Review its files, dependencies, documentation, and release assets. Delete old remote refs before publication.

After publication authorization, the repository visibility, contribution/security settings, and published clone verification are complete. A release tag, changelog, and npm publication remain optional follow-up work; workspace root `private: true` does not prevent open-sourcing the repository.

Acceptance: the published tag matches the reviewed candidate, the public quickstart passes, and release notes describe supported scope accurately.

## Scope and sequencing

First milestone: release-content/history inventory plus a clean-clone demo setup gap list. Follow with the local demo, contributor documentation, CI validation and publication review.

Generic core extraction, product renaming, SQLite support, hosted multi-tenancy, billing and npm distribution are not prerequisites. Existing production providers can ship with documented requirements; new integrations are outside this readiness work.

## Post-public follow-up

1. Replace `arcayne` in `LICENSE` with a legal or registered name if desired.
2. Keep the rights inventory and security contact current.
3. Configure protected provider-backed evaluation inputs before future provider-affecting pushes.

Next action: verify the published README and issue/security links periodically, and keep future descendant CI green.
