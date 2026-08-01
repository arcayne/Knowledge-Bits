# Change risk map

Classify a pull request by the highest-risk boundary it touches. The tier controls evidence and human decision requirements; file count alone never lowers it.

| Tier | Knowledge Bits paths and operations | Required decision |
| --- | --- | --- |
| **Red** | Production database migrations; migration-owner credentials; approval or package-checksum logic; Nuglet delivery/publication; delivery tokens; destructive run/artifact operations | Fresh-context agent review plus explicit named human approval before merge or production action |
| **Orange** | Worker permissions; external source ingestion; NotebookLM/Vertex/writer/provider configuration; R2 writes or signed URLs; OIDC/CSRF; recipe or content-contract versions; leasing/idempotency; Knowledge Bits↔Nuglet contracts | Fresh-context agent review plus a named human domain decision |
| **Yellow** | Normal API features; review UI; media generation; prompt/recipe changes that do not version a contract; read-only dashboards | Fresh-context agent review; fix or explicitly accept blocking findings |
| **Green** | Documentation; tests; internal refactors; copy; isolated styling | Automated checks and fresh-context agent review |

## Decision rules

- A new commit invalidates the prior reviewer verdict because the reviewed SHA changed.
- The builder's test report is useful context, not independent evidence.
- A Vercel success context proves neither that a deployment occurred nor that a human inspected it.
- Orange/Red changes always require a human decision, even during the first 10-PR advisory pilot.
- Red authority is not delegated to the reviewer agent. Approval, delivery, publication, migrations, credential changes, and destructive actions stay human-controlled.
- When a change spans tiers, use the highest tier. Example: a two-line delivery endpoint change is Red; a 20-file docs/test-only refactor can remain Green.

## Nuglet companion boundaries

Until Nuglet is verified separately, treat authentication/account access, RevenueCat/subscription entitlements, owned-content entitlements, production migrations, lesson publication/deletion, app signing, and production releases as Red assumptions at the integration boundary.

## Pilot guardrails

- 100% of Orange/Red changes receive named human approval.
- No PR is called independently verified solely from its builder's claims.
- No delivery/publication action executes as part of reviewer validation.
- No credential value appears in reviewer artifacts, PR comments, fixtures, or logs.
- The reviewer records definite defects separately from risks and unproven assumptions.
