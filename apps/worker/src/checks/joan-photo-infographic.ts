import {
  joanPhotoInfographicSeriesSchema,
  type JoanPhotoInfographicSeries,
} from '@knowledge-bits/contracts';

export interface JoanPhotoInfographicFinding {
  code: 'contract' | 'claim-reference';
  message: string;
  path?: readonly (string | number)[];
}

export interface JoanPhotoInfographicValidationReport {
  passed: boolean;
  series?: JoanPhotoInfographicSeries;
  findings: readonly JoanPhotoInfographicFinding[];
}

/**
 * Validates the ordered Joan image series after content claims are available.
 * The contract validates shape and ordering. This check also verifies that
 * every card claim reference resolves to a checked claim.
 */
export function validateJoanPhotoInfographicSeries(input: {
  series: unknown;
  claimIds: readonly string[];
}): JoanPhotoInfographicValidationReport {
  const parsed = joanPhotoInfographicSeriesSchema.safeParse(input.series);
  if (!parsed.success) {
    return {
      passed: false,
      findings: parsed.error.issues.map((issue) => ({
        code: 'contract' as const,
        message: issue.message,
        path: issue.path,
      })),
    };
  }

  const claimIds = new Set(input.claimIds);
  const findings: JoanPhotoInfographicFinding[] = [];
  parsed.data.cards.forEach((card, cardIndex) => {
    card.claimRefs.forEach((claimId, claimIndex) => {
      if (!claimIds.has(claimId)) {
        findings.push({
          code: 'claim-reference',
          message: `Card claim reference does not resolve to a checked claim: ${claimId}`,
          path: ['cards', cardIndex, 'claimRefs', claimIndex],
        });
      }
    });
  });

  return {
    passed: findings.length === 0,
    series: parsed.data,
    findings,
  };
}
