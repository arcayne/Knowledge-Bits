---
name: release-nuglet
description: Move an approved Knowledge Bits Nuglet through operator review, approval, delivery, a nuglet.app production release PR, and post-release SEO verification. Use when asked to approve, deliver, publish, or release an existing Nuglet; operate the review app behind Cloudflare Access; open the PR that releases a Nuglet to nuglet.app; or verify canonical metadata, JSON-LD, robots.txt, sitemaps, and llms.txt coverage.
---

# Release a Nuglet

Move one already-approved Knowledge Bits run to a reviewable production release. Keep approval, delivery, PR readiness, merge, and public-live status as separate facts. Use the repository's existing release/migration conventions and preserve the approved artifact exactly.

## Required inputs

Accept any of these starting points:

- Knowledge Bits run ID or review URL
- Nuglet title/slug when it can be resolved unambiguously
- an explicit instruction such as “approve and deliver” or “open the release PR”

Resolve the exact run before acting. If more than one run matches, ask the operator to choose. Do not start a new Nuglet or silently substitute a different run.

## Workflow

### 1. Establish the release target

1. Inspect the run in the Knowledge Bits review app/API and record its run ID, title, slug, current state, approved revision/checksum, and available delivery artifacts.
2. Confirm that the run is in an approved state. Approval must be explicit in the run evidence; a draft, generated, reviewed, or delivered state alone is not approval.
3. Check the target branch/repository and the existing Nuglet release path before changing files. Look for migration registries, release scripts, generated projections, public-route conventions, and deployment checks.
4. Create or update a compact release evidence bundle if the repository workflow uses one, such as `specs/<timestamp>-release-<slug>/` with `spec.md`, `run.json`, and `notes.md`. Record the source run, checksum, intended public URL, and current gate.

Stop and report a blocker when the run is not approved, the checksum/artifact is missing, or the target cannot be resolved without guessing.

### 2. Review and approve in Knowledge Bits

Use the review app as a human operator. It may be protected by Cloudflare Access:

- Open the supplied review URL or the configured local/production review app.
- If Cloudflare Access or operator authentication appears, let the user complete the sign-in in the browser. Never request or store their password, one-time code, session cookie, or token in files or chat.
- Review the actual Nuglet content, media, sources, title, slug, and learner-facing metadata. Capture concrete defects or screenshots/URLs needed for the release record.
- If the operator explicitly authorized approval, approve the exact run/revision in the UI and verify that the run evidence changes to approved. If approval was not requested, stop after review and ask before approving.

Never approve a different revision from the one being released. Re-check the checksum after approval if the system exposes one.

### 3. Deliver the approved Nuglet

Only deliver after approval is verified and the operator has asked for delivery.

Knowledge Bits approval normally queues the delivery worker, which calls Nuglet's authenticated delivery adapter (`/deliver`, not the dry-run `/import` endpoint). Do not impersonate the worker or call the worker-only Knowledge Bits delivery route from the CLI.

From the Knowledge Bits repository, use the release CLI when the required environment is configured:

```bash
pnpm release:nuglet inspect --run RUN_ID
pnpm release:nuglet approve --run RUN_ID --checksum APPROVED_SHA256
pnpm release:nuglet watch --run RUN_ID
```

`approve` is an explicit mutation and requires `KNOWLEDGE_BITS_REVIEWER_ID`; `watch` polls the review pipeline until delivery succeeds or needs human attention. The CLI keeps API and review tokens separate, validates the approved checksum, and never prints token values.

If operating through the review UI instead, trigger the documented approval/delivery action and inspect the run evidence, artifact IDs, URLs, and errors. Do not treat clicking a button as success.

Confirm that delivery produced the release input expected by nuglet.app. If the system reports a different checksum, title, slug, or revision, stop and reconcile it before creating a PR. Record delivery status and evidence in the release bundle and eventual PR description.

Delivery is not the same as a merged production release. Use the exact status the system reports.

### 4. Prepare the release change or PR

Use the existing repository release path; do not hand-copy or rewrite approved lesson content unless the release convention explicitly requires generated files.

For the normal architecture, an approved package is published through the Knowledge Bits worker and Nuglet's authenticated `/deliver` adapter. A routine content release therefore does not need a Nuglet source-code PR. The release CLI output and delivery receipt are the release evidence.

Open a PR when the release changes integration code, schemas, migrations, SEO behavior, or a repository-governed release manifest. The PR should:

- identify the exact approved run/revision and checksum;
- include the public route/slug and source run ID when known;
- include required integration, migration, or release-manifest changes;
- preserve source attribution and approved metadata;
- include validation commands and their outcomes;
- describe SEO evidence and any explicit SEO gap;
- avoid copying approved lesson content or unrelated cleanup.

Run the narrowest relevant checks first, then the repository's required checks. Typical evidence may include backend tests, typechecks, web build, rendered-route contracts, migration-registry validation, and a public HTTP check. Inspect `package.json`, CI configuration, and repository docs for the actual commands rather than inventing them.

Open the PR only after the branch contains the intended integration change and validation evidence. Return the PR URL/number, commit, mergeability, and check status. Do not merge unless the operator separately asks for merge and the repository policy permits it.

### 5. Verify the public and SEO surface

When the delivered or deployed URL is available, verify the real public response, not only source files or a preview. The CLI can run the deterministic part:

```bash
pnpm release:nuglet verify-seo --url https://nuglet.app/lessons/SLUG
```

Treat failed checks as blockers and `llms.txt` omissions as warnings unless the release scope explicitly requires `llms.txt` coverage. If the site is protected, authenticate through the browser without copying credentials into artifacts.

For the Nuglet public route, check:

- HTTP success and the expected canonical URL;
- `<title>` and meta description;
- `robots` directives allowing indexing/following when intended;
- canonical link, Open Graph metadata, and JSON-LD;
- visible source attribution/links where the product requires them;
- valid route/slug behavior and no accidental draft or preview markers;
- the dedicated Knowledge Bits sitemap (normally `knowledge-bits-sitemap.xml`) contains the Nuglet URL and an appropriate `lastmod`;
- `robots.txt` advertises the dedicated sitemap and the general sitemap;
- whether the general `sitemap.xml` intentionally excludes Knowledge Bits projections. Do not report that exclusion as a defect when the dedicated sitemap is the documented integration;
- `llms.txt` coverage. If the Nuglet is absent, record it as a known gap or add the change only when the approved release scope includes it;
- Search Console submission/indexing monitoring as a manual follow-up unless the operator explicitly asks for it.

Validate sitemap XML and URL consistency where practical. An HTTP 200 alone is not evidence that SEO is complete.

If the SEO surface fails because of the release, fix it within the approved scope before closing the PR gate. If fixing it changes shared sitemap behavior or product policy, stop and ask for a decision rather than making a broad change.

### 6. Close out truthfully

Report the gates independently:

```text
Run: <id/title/slug>
Approval: verified | blocked
Delivery: verified | blocked | not requested
Release PR: <url/number> | not opened
Checks: <exact results>
Public route: <url + HTTP result> | not verified
SEO: <verified items>
Known gaps: <for example llms.txt or manual Search Console monitoring>
Merge/live status: PR open | merged and live | not verified
Next action: <merge, fix, monitor, or operator decision>
```

Do not say “live,” “released,” or “production” merely because delivery succeeded, a preview returned 200, or a PR is mergeable. Claim merged/live only after the merge/deployment evidence and a fresh public verification support it.

## Safety rules

- Treat approval and delivery as authorized actions, not passive observations.
- Require explicit operator intent before approving, delivering, merging, or changing production data.
- Keep one Nuglet's approved checksum and release artifacts together; never mix runs.
- Never fabricate run IDs, checksums, URLs, test results, or deployment state.
- Stop on authentication, provider, artifact, checksum, migration, or validation blockers and report the exact blocker.
- Do not expose credentials or copy Cloudflare Access secrets into logs, PRs, notes, or source files.
- Keep the PR narrowly scoped to the approved release and required release plumbing.
