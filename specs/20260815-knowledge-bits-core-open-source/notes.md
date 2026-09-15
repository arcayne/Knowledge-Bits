# Knowledge Bits Core open-source extraction notes

> Superseded scope (2026-09-14): Nuglet information may be public. The exclusion inventory below is historical context only. Use `readiness-plan.md`; Nuglet names, recipes, prompts, assets and product documentation are no longer excluded on confidentiality grounds.

## Status

The proposal defined a public core and private product layers. Nuglet information may now be public, and the release-preparation slice records MIT for project-owned software and general documentation. The current candidate records a clean-history export and named release owners; repository visibility remains a final publication gate.

## Private-boundary inventory

| Current area | Public disposition | Reason |
| --- | --- | --- |
| `packages/pipeline` | Extract after neutral naming | It contains generic deterministic workflow transitions and checksum logic. |
| `packages/contracts` | Split | Workflow primitives are reusable. Nuglet lesson schemas and compatibility code are product-specific. |
| `packages/evaluation` | Extract with a new corpus | The evaluator is reusable. Its current corpus, baselines, and provenance must be reviewed before release. |
| `apps/api` | Reference implementation later | It needs a neutral configuration model and fixture-only destination/storage setup. |
| `apps/review` | Reference implementation later | It needs generic labels, local auth documentation, and no internal deployment assumptions. |
| `apps/worker` | Split interfaces from implementations | Worker protocol and fixture execution are reusable. NotebookLM, media, and product provider operations are private. |
| `recipes/nuglet.lesson.v1` | Keep private | It encodes Nuglet formats, editorial choices, and product behavior. |
| `apps/worker/assets/nuglet-*` | Keep private | They contain brand and product-specific visual material. |
| `examples/nuglet-migrations` | Removed from public candidate | They identified existing product content, local source paths, and migration operations. |
| Product, growth, and operational docs | Keep private | They describe strategy, internal controls, and operating context. |

## Required decision records

Create these decision records before the Phase 1 merge:

1. License and trademark decision.
2. Public-maintainer and vulnerability-response ownership.
3. Package-schema compatibility policy.
4. Supported self-hosted deployment profile.
5. Source-fixture and asset redistribution-rights policy.
6. Provider-adapter admission policy.

## Publication checklist owner fields

The final checklist must record named approvers for:

- legal and licensing;
- security and secret-history audit;
- third-party asset and fixture rights;
- technical release readiness;
- trademark and public communications.

No single technical test substitutes for these approvals.
