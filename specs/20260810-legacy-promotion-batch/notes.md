Workflow: agentic-delivery-playbook v0.2
Task fit: broad-ticket
Approval: user explicitly requested the ten-item batch be carried through to human review.
Active model: runtime-default
Critic: self-review

The existing production pipeline already generates `socialPost` during strict Create, but ordinary Produce Assets does not yet request `public_preview` by default. Approved legacy packages cannot be edited in place, so the batch uses fenced new revisions and preserves prior approvals as history.

Implementation QA passed: contracts 42/42, API 150/150 with four Docker-only skips, worker 178/178, public-preview compilation 10/10, and workspace typecheck 5/5.
