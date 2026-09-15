import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const trackedFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.endsWith('pnpm-lock.yaml'));

const forbidden = [
  {
    label: 'Nuglet credential assignment',
    pattern: /NUGLET_(?:DATABASE_URL|RUNTIME_DATABASE_URL|DIRECT_DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY)\s*=/,
  },
  {
    label: 'Supabase secret token',
    pattern: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}\b/,
  },
  {
    label: 'Supabase project URL',
    pattern: /https:\/\/[a-z0-9]{8,}\.supabase\.co\b/i,
  },
  {
    label: 'Supabase PostgreSQL host',
    pattern: /\b(?:db\.[a-z0-9-]+\.supabase\.co|(?:[a-z0-9-]+\.)*pooler\.supabase\.com)\b/i,
  },
  {
    label: 'JWT-shaped credential',
    pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  },
];

const findings = [];
for (const file of trackedFiles) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? ` (${error.code})` : '';
    findings.push(`${file} could not be read${code}`);
    continue;
  }
  for (const { label, pattern } of forbidden) {
    const match = pattern.exec(contents);
    if (match) findings.push(`${file}:${lineNumber(contents, match.index)} ${label}`);
  }
}

if (findings.length) {
  console.error('Forbidden Nuglet or Supabase credentials were found:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Credential scan passed for ${trackedFiles.length} tracked files.`);
}

function lineNumber(contents, offset) {
  return contents.slice(0, offset).split('\n').length;
}
