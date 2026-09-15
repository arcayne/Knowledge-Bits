export const NOTEBOOKLM_RESEARCH_PROMPT_VERSION = 'notebooklm-research.v1';

export function renderNotebookLmResearchPrompt(input: { topic: string }): string {
  return [
    'Return JSON only.',
    `Topic: ${input.topic}`,
    'Return the useful sources already available in this notebook for this topic.',
    'Use this shape: {"sources":[{"sourceId":"...","title":"...","url":"https://..."}]}.',
    'Do not return claims, analysis, or a lesson draft in this step.',
  ].join('\n');
}
