export const NOTEBOOKLM_CREATE_PROMPT_VERSION = 'notebooklm-create.v1';

export function renderNotebookLmCreatePrompt(input: { topic: string; revision: number }): string {
  return [
    'Return JSON only.',
    `Topic: ${input.topic}`,
    `Candidate revision: ${input.revision}`,
    'Draft a complete candidate with title, takeaway, action, quick, core, deep, and grounded claims.',
    'Use only cited source material. Do not provide a partial patch.',
  ].join('\n');
}
