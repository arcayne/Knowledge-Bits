# Release readiness notes

## Facts

- The public export is a parentless `main` commit; the old remote branches and tag were removed before publication.
- The current public-release scanner finds historical fixture and documentation matches in reachable objects. The current candidate tree is clean after the MIT follow-up.
- OrbStack was started for this run and Docker is now available.
- Node 24.18.0 is installed at `/opt/homebrew/opt/node@24/bin/node`; pnpm 9.12.0 is available through that Node's Corepack.

## Decisions

- Use a clean-history export rather than publish inherited private history.
- Treat the owner handle `arcayne` as the current maintainer, security contact, release owner, and copyright holder pending final legal-name confirmation.
- Remove live NotebookLM migration state and private migration inventories from the public candidate.
- Preserve bundled font notices and reserve Nuglet trademark rights separately from MIT.

## Post-public follow-up

The provider-backed push workflow detects the parentless publication root and defers Lane 1 until a descendant push has a reachable predecessor. The final export is public, and both release workflows are green. Keep the rights inventory current and configure protected provider inputs before future provider-affecting pushes.
