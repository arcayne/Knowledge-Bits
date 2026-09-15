# Mini PRD: Open-source Knowledge Bits with MIT

Date: 2026-09-15
Status: release-preparation brief
License decision: MIT for project-owned software and general documentation; rights inventory records separate asset and trademark terms

## Problem

Knowledge Bits works as a private, Nuglet-focused content operations system. A new contributor cannot yet clone the repository, understand the supported path, run the workflow locally without private services, or know which integrations and assets they may redistribute.

## Goal

Release Knowledge Bits as a usable open-source repository. Include the Nuglet implementation, recipes, prompts, branding and product documentation where the project owns or can redistribute them. Use MIT for project-owned code and documentation. Keep third-party terms attached to third-party material.

## Target users

- Developers who want to run the workflow locally.
- Teams that want to adapt the pipeline to their own content type or destination.
- Contributors who need a documented test, review and contribution path.

## User promise

“Clone the repository, run the local fixture workflow, review and approve a package, and inspect a durable delivery receipt without production credentials.”

## MVP scope

Include:

- the existing six-stage workflow: research, create, check, produce assets, human review and deliver;
- Nuglet schemas, recipes, prompts, review UI and eligible product documentation;
- fixture providers, local filesystem artifacts and a durable local delivery adapter;
- PostgreSQL 16 local setup with compose and portable demo configuration;
- a bundled, rights-cleared or synthetic example with source evidence and fixture output;
- contributor, architecture, self-hosting, compatibility, security and integration documentation;
- MIT license notice and third-party notices;
- CI for build, typecheck, tests, local demo behavior, secret scanning and rights/release checks.

Exclude from the release candidate:

- credentials, `.env` files, account/session state, caches and scratch directories;
- personal or customer data;
- third-party source text, media, fonts or labels without redistribution rights;
- private deployment values and unclassified local worktree files;
- claims that the open-source repository includes hosted backend access or provider accounts.

## Functional requirements

1. A clean clone can install dependencies and start the documented local demo.
2. The demo can create or load a Nuglet example, run the workflow, show evidence and produce a package.
3. Only an authorized human can approve a package, and approval records the exact package checksum.
4. A changed package revision invalidates the previous approval.
5. Delivery rejects an unapproved or checksum-mismatched package and is idempotent on retry.
6. The demo uses fixture or local adapters by default and cannot call production providers accidentally.
7. Optional NotebookLM, Vertex, media and destination integrations document their prerequisites, costs, credentials and limitations.
8. A contributor can run the documented test and validation commands without maintainer-only secrets.

## Documentation requirements

The repository must answer these questions from its public files:

- What does Knowledge Bits do, and what is Nuglet?
- How do I run the shortest successful local workflow?
- Which stages own which state and evidence?
- How do I add or replace a provider, artifact store or destination?
- Which integrations require external accounts or paid services?
- Which files and assets are covered by MIT, and which retain separate terms?
- How do I report a vulnerability and contribute a change?

## Success criteria

The release candidate is ready when:

- a fresh clone completes the local review and delivery flow;
- the clean-clone flow demonstrates restart persistence and revision reapproval;
- deterministic evaluation passes with all required fixtures present;
- the public CI workflow passes under Node 24 and the documented pnpm version;
- scanner findings are classified and verified exposures are resolved;
- every shipped asset has an identified license or redistribution basis;
- root `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and third-party notices are complete;
- the owner records the clean-history strategy, maintainer, security contact, release owner, and copyright holder.

## Delivery plan

1. Resolve the public file and Git-history inventory.
2. Fix the deterministic evaluator's missing provider outputs and package fixtures.
3. Run the local demo from a clean clone with Node 24 and Docker/PostgreSQL.
4. Add `LICENSE` and set MIT metadata for project-owned packages and documentation.
5. Complete rights, dependency and asset review.
6. Re-run CI, review the candidate and publish the authorized tag.

## Non-goals for v0.1

Do not add hosted multi-tenancy, billing, enterprise SSO, a provider marketplace, SQLite support or npm publication as part of the initial release.

## Risks and controls

| Risk | Control |
| --- | --- |
| A historical fixture looks like a real credential | Review and classify the finding; remove or rewrite verified exposures. |
| MIT is applied to material owned by someone else | Keep third-party notices and separate terms; license only project-owned material. |
| A contributor triggers paid or production services | Fixture mode and local destination are the default; production integrations are explicit. |
| The demo passes tests but fails for a new contributor | Verify the complete flow from a fresh clone and document the exact commands. |

## Owner decisions

- MIT is the repository license for project-owned code and general documentation.
- Nuglet information may be public; the rights inventory records separate brand, font, media, and source-material terms.
- Use a clean-history candidate and remove old remote refs before changing visibility.
- @arcayne is the maintainer, security contact, and release owner for this candidate.

This PRD authorizes implementation planning and release preparation. It does not by itself authorize changing repository visibility, rewriting history or publishing a release.
