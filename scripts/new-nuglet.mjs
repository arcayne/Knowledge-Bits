#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const apiUrl = required('ENGINE_API_BASE_URL');
const token = required('ENGINE_API_TOKEN');
const title = requiredArg(args, 'title');
const objective = requiredArg(args, 'objective');
const notebookLmNotebookId = requiredArg(args, 'notebook');
const locale = args.locale ?? 'en';
const audience = args.audience ?? 'general adult learners';
const sourceUrls = (args.source ?? []).map((value) => value.trim()).filter(Boolean);

const brief = {
  topic: title,
  title,
  objective,
  audience,
  locale,
  notebookLmNotebookId,
  ...(sourceUrls.length ? { sourceUrls } : {}),
  intake: { requestedBy: 'cli', requestedFormat: 'story_playbook' },
};

const response = await fetch(new URL('/runs', apiUrl), {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ title, locale, notebookLmNotebookId, brief }),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(payload.error ?? `Knowledge Bits API returned ${response.status}`);
  process.exit(1);
}

console.log(`Run created: ${payload.id}`);
console.log(`Review: ${process.env.KNOWLEDGE_BITS_REVIEW_URL ?? 'http://127.0.0.1:4321'}/runs/${payload.id}`);
console.log('Next: let the worker claim Research, then follow the run from the review dashboard.');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function parseArgs(values) {
  const result = { source: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const name = value.slice(2);
    const next = values[index + 1];
    if (name === 'source') {
      if (!next || next.startsWith('--')) throw new Error('--source requires a URL');
      result.source.push(next);
      index += 1;
      continue;
    }
    if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value`);
    result[name] = next;
    index += 1;
  }
  return result;
}
