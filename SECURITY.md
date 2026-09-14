# Security policy

## Supported versions

This repository has no published release series. Security fixes are considered for the current default branch and the current supported runtime contract: Node.js 24.x, pnpm 9.12.0, and PostgreSQL 16.x. Older commits and local demo state are not supported deployment versions.

## Threat-model limits

Knowledge Bits protects workflow boundaries, lease-scoped worker actions, package checksums, approval binding, and delivery idempotency. These controls do not make provider output correct, source material lawful to use, or a deployment secure by default.

The local demo is intentionally not a production security boundary. It uses throwaway localhost tokens, a configured local reviewer name, fixture providers, filesystem storage, and local delivery receipts. Production operators must provide identity authentication, secret management, network controls, backups, log redaction, dependency updates, and destination authorization.

The system does not guarantee availability, factual accuracy, rights clearance, or security of third-party providers, hosts, databases, identity providers, or storage services. Provider credentials remain outside the API and repository when production is configured.

## Reporting a vulnerability

Report suspected vulnerabilities privately through the GitHub Security Advisory form:

<https://github.com/arcayne/Knowledge-Bits/security/advisories/new>

Do not disclose a suspected vulnerability in a public issue, pull request, discussion, or social post first. Include the affected commit or version, impact, reproduction steps, required configuration, and a safe contact method. Remove credentials, personal data, and private URLs from the report unless the security team specifically requests them.

If the advisory form is unavailable, do not post exploit details publicly. Use the repository owner's documented private security channel when one is established.

## Response ownership

Maintainer ownership for vulnerability triage, fixes, disclosure, and release approval remains an explicit unresolved release decision. The owner must name the responsible maintainers and publish a response process before claiming a public security support commitment or making a release.
