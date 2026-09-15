# Public release readiness

Date: 2026-09-15
Status: implementation in progress
Task fit: broad-ticket

## Objective

Prepare a clean-history, rights-reviewed Knowledge Bits candidate that can be validated from a fresh clone and published without exposing the existing repository's private branches, live-account registry data, local paths, or unresolved asset rights.

## Scope

- create a one-commit candidate from the reviewed `origin/main` tree;
- remove live-account migration registries, private migration inventories, and internal agent reports from the candidate;
- record rights and ownership decisions for fonts, images, documents, recipes, prompts, branding, and generated media;
- name the maintainer, security contact, release owner, and copyright holder;
- run the local PostgreSQL demo with Node 24 and Docker;
- run release checks against the candidate and verify GitHub checks; and
- publish only after the old refs no longer remain reachable from the public repository.

## Non-goals

- changing application behavior unrelated to release readiness;
- publishing third-party source material or provider output without a documented basis;
- exposing the existing private branch set;
- claiming that MIT grants trademark rights or third-party asset rights;
- publishing provider credentials, customer data, or live account state.

## Rights decisions

- Bricolage Grotesque and Fraunces remain under their bundled SIL Open Font License notices.
- Nuglet recipes, prompts, product documentation, and project-owned example art are authorized for public inclusion by the owner's instruction that Nuglet information may be public.
- Nuglet logo and brand marks may be included for repository examples, but trademarks and endorsement rights remain reserved and are not granted by MIT.
- The product strategy DOCX and Markdown are project-owned documentation and may be published under the repository documentation terms.
- The live NotebookLM migration registry and migration inventories are excluded because they contain account-adjacent identifiers, local source paths, and references to external media whose redistribution is not established.
- No generated audio or video binaries are shipped in the candidate. Fixture output is synthetic and deterministic.

## Acceptance criteria

1. The candidate has one new root commit and no parent from the private repository.
2. The candidate contains no live migration registry, private migration inventory, `.superpowers` report, credential, ignored local state, or unresolved rights claim.
3. `LICENSE`, package metadata, rights inventory, security ownership, and release checklist agree.
4. The clean-clone demo completes setup, seed, start, approval, delivery receipt, restart persistence, and revision reapproval.
5. Node 24 and Docker-backed quality checks pass locally or the exact environment limitation is recorded.
6. GitHub Actions quality, model-quality, and Vercel checks pass on the candidate.
7. The old remote branches and tags are deleted or the candidate is published in a new repository, so no private history remains reachable.
8. Repository visibility is changed to public only after criteria 1–7 are satisfied.

## Verification plan

- inspect `git rev-list --all` and remote refs before and after export;
- run `pnpm install --frozen-lockfile` through Node 24 Corepack;
- run `pnpm local-demo setup`, `start`, `seed`, `demo`, `status`, and `reset` against PostgreSQL 16;
- run `pnpm check:public-release`, `pnpm inventory:licenses`, `pnpm test:contracts`, `pnpm test:local-demo`, `pnpm build`, `pnpm typecheck`, and `pnpm test`;
- inspect GitHub Actions results and repository visibility with `gh-axi`.

## Implementation checklist

- [ ] Add rights inventory and ownership records.
- [ ] Remove private candidate files and update public scripts/docs.
- [ ] Update maintainer, security, release, and copyright ownership.
- [ ] Validate the clean clone and local demo.
- [ ] Create the orphan candidate commit.
- [ ] Review remote ref deletion as the irreversible publication gate.
- [ ] Change visibility after the final gate.
