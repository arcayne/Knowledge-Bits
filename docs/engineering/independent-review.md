# Independent reviewer-agent pilot

Status: advisory for PR #51 and the next 10 pull requests. Human approval remains mandatory for Orange/Red changes; the agent verdict is not a GitHub approval rule.

## Flow

```text
Person A + builder agent → PR at exact SHA + evidence
                                  ↓
Person B → fresh-context reviewer agent → reproduced evidence + verdict
                                  ↓
                      human handles risk exceptions
                                  ↓
             merge only after required CI is successful
```

The reviewer may know the PR goal but must not receive the builder conversation. Every verdict records the base SHA, head SHA, reviewer identity, commands/evidence, and timestamp. Any new commit makes it stale and returns the PR to `pending_review`.

## Builder evidence contract

- Intended user/system outcome and concrete acceptance scenarios.
- Exact head SHA.
- Changed trust boundaries, credentials, data writes, and contracts.
- Commands run with outcomes and environment/version limits.
- Preview URL plus what a human actually inspected, or `not verified`.
- Known gaps and downstream assumptions.

Builder-reported commands are never relabeled as independent CI or reviewer evidence.

## Reviewer instruction

```text
Act as the independent reviewer of this pull request. You did not build it.

Do not trust the PR description's validation claims without reproducing them
or finding independent CI evidence.

1. Reconstruct the intended user and system outcome.
2. Classify the change as Green, Yellow, Orange or Red.
3. Identify changed trust boundaries, credentials, data writes and contracts.
4. Look for unsupported assumptions about environments or downstream systems.
5. Run or inspect the smallest set of checks that can disprove correctness.
6. Look for missing regression, integration and failure-path tests.
7. Separate definite defects from risks or unproven assumptions.
8. Return:

Risk tier:
Acceptance scenarios checked:
Independent evidence:
Blocking findings:
Non-blocking findings:
Unproven assumptions:
Verdict: approve / comment / request changes
```

For PR #51, also answer:

```text
- Can PDF evidence reach the narrative writer?
- Can source text contain instructions that influence the writer?
- What is the maximum total writer context?
- What happens when writer credentials are not configured?
- Can V2 be delivered before Nuglet supports it?
- Was a real review preview deployed?
```

Immediately before posting, query the live head again. Record the observed SHA and UTC timestamp. Post only when it matches the reviewed SHA.

## Verdict and escalation

| Verdict | Meaning | Next state |
| --- | --- | --- |
| `approve` | Reproduced evidence supports the outcome and no blocker remains | Human applies tier-specific decision |
| `comment` | No proven blocker, but risks or assumptions need a human decision | Human decides or builder supplies evidence |
| `request changes` | A definite defect, unmet acceptance scenario, or unsafe gap exists | Builder fixes; new SHA requires a new review |

## First metrics

Track these in the baseline for 10–20 PRs; do not build a dashboard yet.

- **Accepted changes/week:** merged; acceptance scenario works in preview/production; no same-defect corrective PR within 48 hours.
- **Human minutes/accepted change:** `(review minutes + repair minutes) / accepted changes`.
- **Independent review coverage:** merged PRs with a fresh-context verdict / total merged PRs.
- **First-pass acceptance:** changes accepted without a corrective implementation round / total attempted changes.
- **Independently verified coverage:** PRs with required CI against the exact head / merged PRs.

Guardrails: production defects, Orange/Red merges without human approval, unintended delivery/publication, exposed credentials/permissions, and learner content published without human review.

## CI enforcement status

The repository workflow's expected check is `Quality / quality`. It runs frozen dependency installation, credential scanning, build, tests, and typecheck. GitHub workflow `312160979` was restored to `active` on 2026-08-01. Enablement and successful exact-head execution are separate facts: PR #51 still has no Actions run for its reviewed SHA. GitHub rejects branch protection and rulesets for this private repository with a plan limitation, so the check cannot yet be made a server-enforced merge requirement; record that as a blocker rather than claiming enforcement.
