export const EDITORIAL_CHECK_PROMPT_VERSION = 'editorial-check.v1';

export function renderEditorialCheckPrompt(rubric: string): string {
  return [
    'Evaluate the candidate independently. Return JSON only.',
    'Return exactly {"summary": string, "findings": array}. Each finding must be exactly {"code": string, "severity": "critical"|"major"|"minor", "message": string}. Use an empty findings array when there is no issue.',
    'Findings must use critical, major, or minor severity.',
    'Do not rewrite content and do not request workflow actions.',
    `Rubric: ${rubric}`,
  ].join('\n');
}
