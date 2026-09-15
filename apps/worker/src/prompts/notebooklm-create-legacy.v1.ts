export const NOTEBOOKLM_CREATE_PROMPT_VERSION = 'notebooklm-create.v1';

export function renderNotebookLmCreatePrompt(input: {
  topic: string;
  revision: number;
  sources?: readonly { sourceId: string; title: string }[];
}): string {
  const sourceInstructions = input.sources?.length
    ? [
      'Approved source IDs for citations (use these exact strings, never numeric source indexes):',
      ...input.sources.map((source) => `- ${source.sourceId}: ${source.title}`),
    ]
    : ['No approved source list was supplied; do not invent citation source IDs.'];
  return [
    'Return JSON only.',
    `Topic: ${input.topic}`,
    `Candidate revision: ${input.revision}`,
    'Draft a complete candidate with title, takeaway, action, depths.quick, depths.core, depths.deep, grounded claims with UUID claimId values, and claimCoverage.',
    'Every claim citation must use an approved sourceId from the list below and include a short supporting excerpt. Never use NotebookLM numeric citation indexes.',
    'claimCoverage must be an array of objects, not a keyed object. It must list title, takeaway, action, depths.quick, depths.core, and depths.deep exactly once, and every entry must contain at least one claimId from claims. The title entry must not have an empty claimIds array.',
    ...sourceInstructions,
    'Use only cited source material. Do not provide a partial patch.',
  ].join('\n');
}
