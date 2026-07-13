export const NOTEBOOKLM_RESEARCH_PROMPT_VERSION = 'notebooklm-research.v1';

export function renderNotebookLmResearchPrompt(input: { topic: string }): string {
  return [
    'Return JSON only.',
    `Topic: ${input.topic}`,
    'Recommend grounded source candidates and factual claims.',
    'Each claim must include citation sourceId values and quoted excerpts.',
    'Sources remain candidates until deterministic verification accepts them.',
  ].join('\n');
}
