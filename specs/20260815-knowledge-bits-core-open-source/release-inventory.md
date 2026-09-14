# Release inventory and history audit

Date: 2026-09-14
Status: milestone 1 audit in progress
Scope: current checkout and reachable Git references; no publication or history rewrite performed.

## Result

The repository is not ready for publication as-is. The current checkout contains product-specific code, provider integrations, operational documentation, historical evaluation material, and local agent work.

History strategy recommendation: **prepare a clean-history candidate**. Reachable history preserves live-account-adjacent registry metadata, developer-local paths, internal operational reports, and undocumented media provenance. Retaining history remains an owner decision, but it requires explicit resolution of those findings and a complete Git-object review. This is not a publication decision. No history rewrite is authorized by this audit.

## Repository inventory

`git ls-files` reports 303 tracked files in the current index.

| Area | Tracked files | Initial disposition | Review required |
| --- | ---: | --- | --- |
| `apps/` | 167 | Candidate application, worker, provider, media, and review code | Provider, media, URL, rights, and personal-data review |
| `packages/` | 13 | Candidate contracts and pipeline code; evaluation additions are currently untracked | Dependency, fixture, and package-scope review |
| `examples/` | 32 | Candidate examples, including Nuglet migration inventories | Source, media, and redistribution-rights review |
| `recipes/` | 11 | Candidate recipe and prompt material | Rights, third-party text, and brand-use review |
| `docs/` | 10 | Mixed product and engineering documentation | Remove private operational material or classify it explicitly |
| `specs/` | 15 | Design and operational history | Classify before release; do not include local run artifacts |
| `test/` | 13 | Candidate automated checks and fixtures | Personal-data, URL, and fixture-rights review |
| `.agents/` | 7 | Project skills and operational instructions | Decide whether these are public project materials |
| `.superpowers/` | 12 | Tracked agent workflow reports | Exclude from release candidate unless explicitly justified |
| Root configuration | 10 | Build, workspace, CI, lockfile, environment template, README | Replace production-specific setup with portable demo setup |

The inventory above is a classification baseline. It is not an allowlist.

## Current checkout state

The working tree is dirty. It has modified source files and untracked work from other tasks, including `.pi/`, `.pi-subagents/`, `.codex-work/`, `evals/`, model-quality files, community-distribution files, and several specs. These files are not release contents by default. The release candidate must be selected from an explicit clean export, not from the current working tree.

Ignored local state includes `.env`, `.local-artifacts/`, `.local-supervisor/`, build outputs, Turbo state, Vercel state, and dependency directories. The repository `.gitignore` does not currently cover all local tool directories observed in this checkout, including `.pi/`, `.pi-subagents/`, `.codex-work/`, `tmp/`, and `.worktrees/`.

## Sensitive-content findings

The following are observed facts, not proof of a credential leak:

- `README.md` contains production-oriented Supabase setup, Nuglet API and media hostnames, delivery configuration, local provider paths, and provider-specific operating instructions.
- `.env.example` contains production-mode variables, Nuglet host references, R2 bucket configuration, provider configuration, and absolute-path examples.
- `apps/worker/src/providers/notebooklm.ts`, media providers, recipes, and related tests contain production integration behavior.
- `examples/nuglet-migrations/` contains many product-specific inventories. Their source text, media references, and third-party rights are unresolved.
- `docs/NUGLET_KNOWLEDGE_BITS_PRODUCT_GROWTH_STRATEGY.md`, `.superpowers/sdd/`, and selected engineering documents are operational or product material. Their public disposition is unresolved.
- Three font files and five PNG files are tracked. Font licenses, image ownership, and redistribution rights are unresolved.
- `git rev-list --all --count` reports 225 commits across reachable references. The history includes product and provider implementation commits and many branches.
- A narrow history scan found no JWT-shaped value, private-key block, Supabase host, or obvious credential assignment matching the scan patterns used for this audit. The same-pattern history scan and current-file scan are limited controls. They do not replace a general secret scan, manual review, or a third-party rights audit.
- The repository credential scanner passed for 503 tracked and non-ignored paths in the current checkout. The command ran under Node 22 and reported the repository's Node 24 engine warning; this is a scan result, not a clean-release result.
- The public-release checker passed its focused tests and did not print matched values, but the current candidate/history run remains blocked by pre-existing credential-shaped local/test fixtures, reachable-history findings, and untracked candidate paths. This is publication-review evidence, not proof of a credential leak.
- The read-only audit confirmed that 28 tracked migration inventories contain developer-local absolute paths and that `examples/nuglet-migrations/notebooklm-migration-registry.json` contains live-account-adjacent notebook/run/status metadata. These findings block inherited-history publication until replaced, removed, or explicitly approved.

No secret value is copied into this report.

## Historical review

No `.env` file, `.pi/`, `.pi-subagents/`, `.codex-work/`, `tmp/`, or local supervisor directory was found in the reachable history path review. Reachable history does contain product-specific code, docs, examples, fixtures, provider configuration references, local paths, and account-adjacent registry metadata. The absence of a narrow pattern hit does not prove that the history is suitable for publication.

The independent read-only audit recommends a clean-history candidate. It found one tag and 225 reachable commits across 108 refs, and it confirmed that the problematic inventories, operational reports, and media provenance are preserved in reachable objects. A retained-history candidate is acceptable only after the owner resolves every listed history finding and records the decision.

Required follow-up checks:

1. Run a dedicated history scanner that checks all reachable blobs and packed objects without printing matched values.
2. Review historical source snapshots, media, fonts, fixtures, inventories, and reports for personal data and third-party rights.
3. Review historical production URLs, IDs, account names, source excerpts, and provider instructions.
4. Compare the release allowlist with every commit and tag that the selected publication strategy will retain.
5. Record the named owner decision for history retention or clean-history export.

## Intended release contents

The readiness plan permits the existing monorepo and Nuglet implementation to remain in scope. The intended candidate therefore includes, subject to rights and sensitive-data review:

- six-stage workflow, contracts, package building, review, fixture worker, and fixture destination;
- Nuglet schemas, recipes, prompts, branding, integrations, documentation, and examples that the project owns or may redistribute;
- evaluation tooling and corpora that pass content and rights review;
- portable local-demo configuration, setup scripts, CI, and contributor documentation;
- production integrations with clear optional-status documentation.

The candidate excludes by default:

- credentials, `.env` files, account/session state, local artifacts, caches, scratch work, and agent-run directories;
- customer or personal data;
- third-party source text, media, fonts, or labels without redistribution rights;
- private deployment values and unreviewed operational reports;
- unclassified dirty-worktree additions.

## Open owner decisions

- MIT coverage for project-owned code and general documentation, plus separate terms for prompts, recipes, fonts, images, and project-owned media.
- History retention versus clean-history export after the follow-up audit.
- Maintainer, security contact, and release owner.
- Public disposition of `.agents/`, `.superpowers/`, product-growth documents, migration inventories, and provider-specific examples.

## Next action

Complete the clean-clone local-demo gap list. Then add the missing portable setup and demo commands in one bounded implementation slice. Keep publication and license selection out of that slice.
