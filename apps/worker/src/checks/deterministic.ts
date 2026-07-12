import { createHash } from 'node:crypto';

export interface GroundedCitation {
  sourceId: string;
  excerpt: string;
}

export interface GroundedClaim {
  statement: string;
  citations: readonly GroundedCitation[];
}

export interface ContentCandidate {
  title: string;
  takeaway: string;
  action: string;
  depths: { quick: string; core: string; deep: string };
  claims: readonly GroundedClaim[];
}

export interface EvidenceManifest {
  sources: readonly { sourceId: string; title: string }[];
}

export interface DeterministicFinding {
  code: 'placeholder' | 'duplicate-depth' | 'citation-source' | 'citation-excerpt' | 'content-shape';
  message: string;
}

export interface DeterministicCheckReport {
  passed: boolean;
  contentChecksum: string;
  findings: readonly DeterministicFinding[];
}

const PLACEHOLDER = /\b(?:todo|tbd|placeholder|opportunity score|competitor)\b/i;

export function runDeterministicChecks(input: {
  candidate: ContentCandidate;
  evidence: EvidenceManifest;
}): DeterministicCheckReport {
  const findings: DeterministicFinding[] = [];
  const fields = [
    input.candidate.title,
    input.candidate.takeaway,
    input.candidate.action,
    input.candidate.depths.quick,
    input.candidate.depths.core,
    input.candidate.depths.deep,
  ];
  if (fields.some((value) => !value?.trim())) {
    findings.push({ code: 'content-shape', message: 'Candidate requires all learner-facing fields.' });
  }
  if (fields.some((value) => PLACEHOLDER.test(value))) {
    findings.push({ code: 'placeholder', message: 'Candidate contains a placeholder or internal metadata label.' });
  }

  const depths = Object.values(input.candidate.depths).map(normalize);
  if (new Set(depths).size !== depths.length) {
    findings.push({ code: 'duplicate-depth', message: 'Quick, Core, and Deep content must be distinct.' });
  }

  const sourceIds = new Set(input.evidence.sources.map(({ sourceId }) => sourceId));
  for (const claim of input.candidate.claims) {
    if (!claim.statement.trim() || claim.citations.length === 0) {
      findings.push({ code: 'citation-source', message: 'Every factual claim requires a cited source.' });
      continue;
    }
    for (const citation of claim.citations) {
      if (!sourceIds.has(citation.sourceId)) {
        findings.push({ code: 'citation-source', message: `Citation source ${citation.sourceId} is not in the evidence manifest.` });
      }
      if (!citation.excerpt.trim()) {
        findings.push({ code: 'citation-excerpt', message: 'Every citation requires a non-empty excerpt.' });
      }
    }
  }

  return {
    passed: findings.length === 0,
    contentChecksum: checksum(input.candidate),
    findings,
  };
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
