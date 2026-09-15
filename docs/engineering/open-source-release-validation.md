# Open-source release validation

The public release checks are deliberately credential-free. They do not contact a provider, deployment service, registry, or GitHub API and do not read provider credentials.

## Exact commands

From the repository root, using Node 24 and pnpm 9.12.0:

```sh
pnpm check:public-release
pnpm inventory:licenses
```

The same checks run in `.github/workflows/quality.yml` after dependency installation and before build/test. The existing `pnpm scan:forbidden-credentials` check remains in place; these checks are additive.

`check:public-release`:

- scans tracked files and non-ignored untracked candidate paths for credential-shaped values;
- recognizes private-key PEM headers, JWTs, common cloud/provider token prefixes, credential-bearing URLs, and non-placeholder secret/password/token assignments;
- scans reachable Git objects when the checkout has usable, non-shallow history, including values removed from the current tree; shallow or unavailable history is reported as unavailable rather than claimed as fully inspected;
- rejects ignored local environment, session, cache, agent, scratch, and worktree paths that must not be selected for publication;
- reports non-ignored untracked paths so an owner can explicitly select the release candidate; and
- scans every match in a file; source-line words such as `test`, `fixture`, `password`, or `query` do not exempt a credential-shaped value; and
- never prints matched values, environment values, tokens, or private URLs.

`inventory:licenses` enumerates the repository root `package.json` importer, workspace package manifests, and direct dependency manifests available in the installed pnpm tree. It prints declared license metadata, `UNSPECIFIED` importer/package metadata, and unresolved installed metadata. Its result is informational and exits successfully so CI can display the inventory without inventing a license for this repository. Missing or unresolved entries remain a publication gate. The inventory does not recursively resolve the complete transitive dependency closure, and it cannot report metadata for packages that are not installed.

## What this proves and cannot prove

A passing credential check proves only that the implemented patterns did not find a match in the selected files or reachable text Git objects. It is not a cryptographic guarantee that no secret exists: encrypted/binary material, an unusual token format, unreachable objects, provider-side values, and secrets assembled at runtime can evade it. History inspection is unavailable, rather than complete, for a shallow or non-Git checkout. CI uses a full checkout for reachable-history inspection.

A passing unintended-file check proves only that known local path classes were not selected. It does not decide whether every generated artifact, media file, brand asset, recipe, source snapshot, or document is legally publishable. The license inventory reports package metadata as declared by manifests; it does not interpret licenses, prove provenance, or select a repository license. It inventories direct importer dependency references only. It does not recursively resolve transitive dependencies and cannot resolve metadata for packages that are not installed.

The script requires Node's standard library and Git for repository/history inspection. CI uses Node 24. Docker is not required by these public checks, but the existing quality workflow still pulls PostgreSQL and installs Chromium for provider-independent integration/browser tests. Those are environment prerequisites, not release validation or deployment credentials.

## Existing negative workflow coverage

The existing contract and end-to-end tests continue to cover negative invariants for citation completeness, artifact integrity/checksum binding, approval transitions, and delivery behavior. `pnpm test:contracts`, the release tests, workspace tests, and e2e tests remain unchanged. These checks do not replace those workflow invariants and do not add credentialed provider tests.

## Publication gates still requiring decisions

Before publication, the repository owner and legal/security reviewers still need to decide:

- confirmation that the MIT license covers intended project-owned files and package metadata matches the root license;
- third-party notices and compatibility for bundled fonts, dependencies, generated media, artwork, recipes, prompts, and source materials;
- whether all reachable history and selected artifacts are suitable for publication, including a security review beyond pattern matching;
- brand, trademark, privacy, and provider-use permissions; and
- the final release candidate contents and any history rewrite or removal process.

## Draft PR blocker acceptance

For this readiness branch, the following blockers are explicitly accepted as documented limitations for draft review only:

- the current public-release check reports existing candidate/history findings and untracked candidate paths;
- the Docker-backed clean-clone demo has not run because the local Docker daemon is unavailable; and
- local validation used Node 22 while the repository contract requires Node 24.

This acceptance does not approve publication, history retention, or a release merge. It records that the implementation and deterministic checks may be reviewed while these publication gates remain open.

## Post-publication verification checklist

Run these steps only after the owner authorizes publication:

1. Clone the published tag without credentials and verify the documented quickstart.
2. Confirm the published tag matches the reviewed candidate file allowlist and selected history strategy.
3. Run the public CI checks and the documented negative approval, checksum, expiry, and delivery cases.
4. Verify that the README links, issue forms, security reporting channel, third-party notices, and release notes are reachable from the public repository.
5. Record the tag, commit, validation date, unresolved limitations, and any corrective follow-up.

This document does not publish anything, rewrite history, change visibility, or make the remaining owner/legal/security decisions.
