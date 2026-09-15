#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const apiUrl = required('ENGINE_API_BASE_URL');
const token = required('ENGINE_API_TOKEN');
const input = {
  title: requiredArg(args, 'title'),
  objective: requiredArg(args, 'objective'),
  audience: args.audience ?? 'general adult learners',
  locale: args.locale ?? 'en',
};

const response = await fetch(new URL('/runs/similarity', apiUrl), {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(input),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(payload.error ?? `Knowledge Bits similarity API returned ${response.status}`);
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredArg(values, name) {
  const value = values[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const name = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value`);
    result[name] = next;
    index += 1;
  }
  return result;
}
