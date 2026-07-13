import type { NugletLessonV1Payload } from '@knowledge-bits/contracts';
import { calculateContentChecksum } from '@knowledge-bits/pipeline';

export interface GroundedCitation {
  sourceId: string;
  snapshotArtifactId: string;
  excerpt: string;
}

export interface GroundedClaim {
  claimId: string;
  statement: string;
  citations: readonly GroundedCitation[];
}

export type ContentCandidate = NugletLessonV1Payload;

export interface EvidenceManifest {
  sources: readonly { sourceId: string; title: string; snapshotArtifactId: string }[];
}

export interface DeterministicFinding {
  code: 'placeholder' | 'duplicate-depth' | 'citation-source' | 'citation-excerpt' | 'content-shape' | 'claim-inventory' | 'claim-coverage';
  message: string;
}

export interface DeterministicCheckReport {
  passed: boolean;
  contentChecksum: string;
  findings: readonly DeterministicFinding[];
}

const PLACEHOLDER = /\b(?:todo|tbd|placeholder|opportunity score|competitor)\b/i;
const LEARNER_PATHS = ['title', 'takeaway', 'action', 'depths.quick', 'depths.core', 'depths.deep'] as const;

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

  if (input.candidate.claims.length === 0) {
    findings.push({ code: 'claim-inventory', message: 'Learner content requires at least one supported claim.' });
  }
  const claimsById = new Map(input.candidate.claims.map((claim) => [claim.claimId, claim]));
  const coverageByPath = new Map(input.candidate.claimCoverage.map((coverage) => [coverage.path, coverage]));
  if (coverageByPath.size !== input.candidate.claimCoverage.length) {
    findings.push({ code: 'claim-coverage', message: 'Learner claim coverage paths must be unique.' });
  }
  for (const path of LEARNER_PATHS) {
    const coverage = coverageByPath.get(path);
    if (!coverage || coverage.claimIds.length === 0 || coverage.claimIds.some((claimId) => !claimsById.has(claimId))) {
      findings.push({ code: 'claim-coverage', message: `Learner field ${path} requires valid claim coverage.` });
    }
  }

  const sourcesById = new Map(input.evidence.sources.map((source) => [source.sourceId, source]));
  for (const claim of input.candidate.claims) {
    if (!claim.claimId.trim() || !claim.statement.trim() || claim.citations.length === 0) {
      findings.push({ code: 'citation-source', message: 'Every factual claim requires a cited source.' });
      continue;
    }
    for (const citation of claim.citations) {
      const source = sourcesById.get(citation.sourceId);
      if (!source || source.snapshotArtifactId !== citation.snapshotArtifactId) {
        findings.push({ code: 'citation-source', message: `Citation source ${citation.sourceId} is not in the evidence manifest.` });
      }
      if (!citation.excerpt.trim()) {
        findings.push({ code: 'citation-excerpt', message: 'Every citation requires a non-empty excerpt.' });
      }
    }
  }

  return {
    passed: findings.length === 0,
    contentChecksum: calculateContentChecksum(input.candidate),
    findings,
  };
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
