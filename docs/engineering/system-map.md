# Knowledge Bits system map

Status: current `origin/main` at `d830986`  
Scope: Knowledge Bits plus its outbound Nuglet boundary; Nuglet internals are not verified here.

```text
Operator browser
      │ OIDC identity + CSRF
      ▼
Review app ── review credential ──► Control API ── runtime DB role ──► Postgres
                                         │
                     lease + capability  ├── R2 credentials/signing ─► R2 artifacts
                     scoped worker token │
                                         ▼
                                  Local worker
                         ┌────────────┼────────────┐
                         ▼            ▼            ▼
                    NotebookLM    Pi / Vertex   local media
                                         │
Approved immutable package + delivery token
                                         ▼
                              Nuglet delivery endpoint
```

| Component | Owns | Calls | Credentials | Production writes |
| --- | --- | --- | --- | --- |
| Control API | Runs, jobs, leases, accepted evidence, package checksums, approval records, delivery history | Postgres, R2, Nuglet delivery endpoint | Restricted runtime DB URL, API/review/worker credential configuration, R2 credentials, delivery token | Yes: engine state and artifacts; approved delivery can cause a downstream publish |
| Local worker | Research, content generation, deterministic/editorial checks, media production | Control API, NotebookLM, Pi/Vertex, local media tools, lease-scoped signed artifact URLs | Worker token and provider-local sessions/config; no Nuglet production credentials | Artifacts and stage results only, within an API-issued lease |
| Review app | Authenticated pipeline and package review experience | Control API | OIDC verification configuration and server-side review credential | Approval/rejection decisions through the API only |
| R2 artifact storage | Immutable source, evidence, prompt/response, report, image, and audio bytes | Accessed through the API or bounded signed URLs | Engine-owned R2 credentials stay with the API | Yes: immutable engine artifact objects |
| Contracts and pipeline packages | Schemas, checksum construction, and deterministic state transitions | Imported by API and worker | None | None directly |
| Nuglet delivery endpoint | Downstream validation, lesson creation/mapping, and publication | Receives approved package from the Control API | Nuglet owns its production credentials; Knowledge Bits holds only the scoped delivery token | Yes, inside Nuglet after it accepts the request |

## Trust boundaries

1. Browser → review app: a signed OIDC identity and cookie-bound CSRF proof gate human decisions; browser-supplied reviewer identities are not trusted.
2. Worker → API: the API maps each token to a server-owned worker ID and capability list; leases bound work and artifact access.
3. Sources/providers → worker: source bytes and model outputs are untrusted until accepted, checksummed, schema-validated, and linked to evidence.
4. API → R2: the API owns object keys and signing; the worker receives bounded upload capability rather than bucket credentials.
5. API → Nuglet: only a human-approved immutable package crosses the delivery boundary. Knowledge Bits never receives Nuglet database, billing, authentication, or general media credentials.
6. Migration owner → runtime DB: migrations use a separate owner connection; the deployed API uses a restricted runtime role and rejects the migration URL.

## Known documentation drift

The current README/runtime describe Knowledge Bits-owned R2 storage and `/deliver` as the final Nuglet boundary. The older approved V1 design still says Nuglet provides artifact storage and describes an import-only integration. Until that design document is updated, use the current runtime and README for operations and treat the older wording as historical—not as evidence of current Nuglet capability.
