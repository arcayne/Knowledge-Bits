export const NOTEBOOKLM_CREATE_PROMPT_VERSION = 'notebooklm-create.v1';

export function renderNotebookLmCreatePrompt(input: { topic: string; revision: number }): string {
  return [
    'Return JSON only.',
    `Topic: ${input.topic}`,
    `Candidate revision: ${input.revision}`,
    'Draft a complete candidate with title, takeaway, action, depths.quick, depths.core, depths.deep, grounded claims with UUID claimId values, and claimCoverage.',
    'Claim coverage must list title, takeaway, action, depths.quick, depths.core, and depths.deep exactly once with supported claim IDs.',
    'Use only cited source material. Do not provide a partial patch.',
  ].join('\n');
}
