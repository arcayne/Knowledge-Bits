import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = /^(?:$|null|undefined|none|false|true|redacted|changeme|change[-_ ]?me|example|sample|dummy|test|testing|password|secret|token|credential|runtime|your[-_ ]?(?:token|secret|password|key)|<[^>]+>|\$\{[^}]+\})$/i;

const SECRET_PATTERNS = [
  { label: 'private-key material', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: 'JWT-shaped credential', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/ },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { label: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { label: 'credential-bearing URL', pattern: /\b(?:https?|postgres(?:ql)?):\/\/[^\s/:@]+:[^\s/@]+@[^\s/?#"'`,;]+/i },
];

const ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)*)\b\s*=\s*(?:(["'`])([^"'`]*?)\2|(<[^>\r\n]+>|\$\{[^}\r\n]+\}|[^\s"'`,;]+))/;
const SENSITIVE_ASSIGNMENT_NAME = /(?:^|[_-])(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTHORIZATION)(?:$|[_-])/;

const IGNORED_LOCAL_NAMES = new Set([
  '.codex-work', '.local-artifacts', '.local-supervisor', '.pi', '.pi-subagents',
  '.tmp', '.vercel', '.worktrees', '.env', 'tmp', 'scratch', 'sessions', 'session',
]);
const IGNORED_LOCAL_SUFFIXES = /(?:^|\/)(?:\.env\.[^/]+|\.cache|cache|coverage|\.DS_Store|[^/]+\.session)(?:\/|$)/i;
const GENERATED_NAMES = new Set(['node_modules', 'dist', 'build', '.turbo']);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function nulList(value) {
  return value.split('\0').filter(Boolean);
}

export function candidatePaths(cwd = process.cwd()) {
  try {
    const tracked = nulList(git(cwd, ['ls-files', '--cached', '-z']));
    const untracked = nulList(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
    return { tracked, untracked, files: [...new Set([...tracked, ...untracked])] };
  } catch {
    return { tracked: [], untracked: [], files: [], unavailable: true };
  }
}

export function ignoredCandidatePaths(cwd = process.cwd(), candidate = null) {
  try {
    const ignored = nulList(git(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']));
    const tracked = candidate ?? nulList(git(cwd, ['ls-files', '--cached', '-z']));
    if (!tracked.length) return ignored;
    let matched = '';
    try {
      matched = execFileSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
        cwd,
        encoding: 'utf8',
        input: `${tracked.join('\0')}\0`,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) {
      matched = typeof error?.stdout === 'string' ? error.stdout : '';
    }
    return [...new Set([...ignored, ...nulList(matched)])];
  } catch {
    return [];
  }
}

export function isUnintendedIgnoredPath(file) {
  const normalized = file.replaceAll(sep, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  const basename = segments.at(-1) ?? '';
  if (basename === '.env.example' || basename === '.env.demo.example') return false;
  if (segments.some((segment) => GENERATED_NAMES.has(segment))) return false;
  if (segments.some((segment) => IGNORED_LOCAL_NAMES.has(segment))) return true;
  return IGNORED_LOCAL_SUFFIXES.test(normalized);
}

function isPlaceholder(value) {
  const normalized = value.trim().replace(/^['"`]|['"`]$/g, '');
  return PLACEHOLDER.test(normalized) || normalized === '...' || /^(?:local|test|fixture|postgres|must-not-be-read|do-not-use|not-used)(?:[-_].*)?$/i.test(normalized);
}

function isSafeExampleHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized.endsWith('.test')
    || normalized.endsWith('.example')
    || normalized === 'example.com'
    || normalized.endsWith('.example.com')
    || normalized === 'example.net'
    || normalized.endsWith('.example.net')
    || normalized === 'example.org'
    || normalized.endsWith('.example.org');
}

function isSafeCredentialUrl(value) {
  const authority = value.match(/@([^/?#]+)/)?.[1] ?? '';
  const hasInterpolatedHost = authority.includes('${');
  let parsed;
  try {
    parsed = new URL(value.replace(/\$\{[^}]+\}/g, '0'));
  } catch {
    return false;
  }
  let username;
  let password;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    return false;
  }
  return (isSafeExampleHost(parsed.hostname) || hasInterpolatedHost) && isPlaceholder(password);
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

export function scanText(text, source = '<input>') {
  const findings = [];
  for (const { label, pattern } of SECRET_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    for (const match of text.matchAll(globalPattern)) {
      if (label === 'credential-bearing URL' && isSafeCredentialUrl(match[0])) continue;
      findings.push({ source, line: lineNumber(text, match.index ?? 0), label });
    }
  }
  for (const match of text.matchAll(new RegExp(ASSIGNMENT_PATTERN.source, 'gm'))) {
    const preceding = text[match.index - 1] ?? '';
    if (/[?&#=/:]/.test(preceding) || !SENSITIVE_ASSIGNMENT_NAME.test(match[1])) continue;
    if (!isPlaceholder(match[3] ?? match[4])) {
      findings.push({ source, line: lineNumber(text, match.index ?? 0), label: `${match[1].toUpperCase()} assignment` });
    }
  }
  return findings;
}

export function scanCandidate(cwd = process.cwd(), paths = candidatePaths(cwd).files) {
  const findings = [];
  for (const file of paths) {
    try {
      const contents = readFileSync(join(cwd, file), 'utf8');
      findings.push(...scanText(contents, file));
    } catch (error) {
      findings.push({ source: file, label: `could not be read${error?.code ? ` (${error.code})` : ''}` });
    }
  }
  return findings;
}

export function scanReachableHistory(cwd = process.cwd()) {
  let objects;
  try {
    if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
      return { available: false, findings: [] };
    }
    objects = git(cwd, ['rev-list', '--objects', '--all']).split(/\r?\n/).filter(Boolean);
  } catch {
    return { available: false, findings: [] };
  }
  const findings = [];
  for (const object of objects) {
    const [oid, ...pathParts] = object.trim().split(/\s+/);
    if (!oid) continue;
    let contents;
    try {
      contents = execFileSync('git', ['cat-file', 'blob', oid], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }
    // Binary blobs are not useful for text credential detection and can be large.
    if (contents.includes('\0')) continue;
    const source = `history:${pathParts.join(' ') || oid}`;
    findings.push(...scanText(contents, source));
  }
  return { available: true, findings };
}

function workspacePatterns(cwd) {
  const workspaceFile = join(cwd, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceFile)) return [];
  return readFileSync(workspaceFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s*["']?([^"'#]+)["']?\s*$/)?.[1]?.trim())
    .filter(Boolean);
}

export async function workspacePackageManifests(cwd = process.cwd()) {
  const manifests = [];
  for (const pattern of workspacePatterns(cwd)) {
    if (!pattern.endsWith('/*')) continue;
    const parent = join(cwd, pattern.slice(0, -2));
    let entries = [];
    try { entries = await readdir(parent, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = join(parent, entry.name, 'package.json');
      if (existsSync(file)) manifests.push(file);
    }
  }
  return manifests.sort();
}

async function dependencyManifest(dependency, packageDirectory, cwd, workspaceByName) {
  if (workspaceByName.has(dependency)) return workspaceByName.get(dependency);
  let directory = packageDirectory;
  while (true) {
    const candidate = join(directory, 'node_modules', ...dependency.split('/'), 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // pnpm's content-addressed layout is still deterministic without adding a package.
  const pnpmDirectory = join(cwd, 'node_modules', '.pnpm');
  try {
    for (const entry of await readdir(pnpmDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(pnpmDirectory, entry.name, 'node_modules', ...dependency.split('/'), 'package.json');
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* an install is optional for this report */ }
  return null;
}

function licenseOf(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim()) return manifest.license.trim();
  if (Array.isArray(manifest.licenses) && manifest.licenses.length) {
    const values = manifest.licenses.map((item) => typeof item === 'string' ? item : item?.type).filter(Boolean);
    if (values.length) return values.join(' OR ');
  }
  return null;
}

export async function inventoryLicenses(cwd = process.cwd()) {
  const rootManifest = join(cwd, 'package.json');
  const files = [
    ...(existsSync(rootManifest) ? [rootManifest] : []),
    ...await workspacePackageManifests(cwd),
  ];
  const workspacePackages = [];
  const workspaceByName = new Map();
  for (const file of [...new Set(files)]) {
    const rootImporter = file === rootManifest;
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      const record = { name: manifest.name ?? relative(cwd, dirname(file)), version: manifest.version ?? 'unknown', file, license: licenseOf(manifest), kind: rootImporter ? 'root importer' : 'workspace package' };
      workspacePackages.push(record);
      if (manifest.name) workspaceByName.set(manifest.name, file);
    } catch {
      workspacePackages.push({ name: relative(cwd, file), version: 'unknown', file, license: null, kind: rootImporter ? 'root importer' : 'workspace package', malformed: true });
    }
  }

  const dependencies = [];
  for (const packageRecord of workspacePackages) {
    let manifest;
    try { manifest = JSON.parse(await readFile(packageRecord.file, 'utf8')); } catch { continue; }
    const groups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    for (const group of groups) {
      for (const [name, requested] of Object.entries(manifest[group] ?? {})) {
        const file = await dependencyManifest(name, dirname(packageRecord.file), cwd, workspaceByName);
        if (!file) {
          dependencies.push({ package: packageRecord.name, name, requested, status: 'unresolved' });
          continue;
        }
        try {
          const installed = JSON.parse(await readFile(file, 'utf8'));
          dependencies.push({ package: packageRecord.name, name, requested, installed: installed.version ?? 'unknown', license: licenseOf(installed), status: licenseOf(installed) ? 'resolved' : 'missing' });
        } catch {
          dependencies.push({ package: packageRecord.name, name, requested, status: 'unresolved' });
        }
      }
    }
  }
  return {
    workspacePackages,
    importers: workspacePackages,
    dependencies,
    missing: [...workspacePackages.filter((item) => !item.license).map((item) => `${item.name} (${item.kind})`), ...dependencies.filter((item) => item.status === 'missing').map((item) => item.name)],
    unresolved: dependencies.filter((item) => item.status === 'unresolved').map((item) => item.name),
  };
}

function printInventory(report) {
  console.log(`License inventory: ${report.workspacePackages.length} package importers, ${report.dependencies.length} direct dependency references.`);
  for (const item of report.workspacePackages) console.log(`- ${item.name}: ${item.license ?? 'UNSPECIFIED'}`);
  for (const item of report.dependencies) {
    if (item.status === 'resolved') console.log(`- ${item.name}: ${item.license}`);
    else console.log(`- ${item.name}: ${item.status.toUpperCase()} (no license asserted)`);
  }
  if (report.missing.length) console.log(`Missing license metadata (${report.missing.length}): ${report.missing.join(', ')}`);
  if (report.unresolved.length) console.log(`Unresolved installed metadata (${report.unresolved.length}): ${report.unresolved.join(', ')}`);
  console.log('Inventory result: informational; unresolved metadata is a publication gate, not an invented license.');
}

export async function runReleaseCheck(cwd = process.cwd(), { includeHistory = true } = {}) {
  const candidate = candidatePaths(cwd);
  const ignored = ignoredCandidatePaths(cwd, candidate.files);
  const unintended = ignored.filter(isUnintendedIgnoredPath);
  const findings = candidate.unavailable ? [{ source: 'git', label: 'candidate file list unavailable' }] : scanCandidate(cwd, candidate.files);
  const history = includeHistory ? scanReachableHistory(cwd) : { available: false, findings: [] };
  return { candidate, ignored, unintended, findings, history, passed: findings.length === 0 && history.findings.length === 0 && unintended.length === 0 };
}

async function main() {
  const cwd = process.cwd();
  const licensesOnly = process.argv.includes('--licenses');
  if (licensesOnly) {
    printInventory(await inventoryLicenses(cwd));
    return;
  }
  const result = await runReleaseCheck(cwd);
  if (result.candidate.untracked.length) console.log(`Untracked candidate paths (review and explicitly select): ${result.candidate.untracked.join(', ')}`);
  if (result.history.available) console.log(`Reachable Git history inspected (${result.history.findings.length} finding(s)).`);
  else console.log('Reachable Git history unavailable; current candidate was inspected.');
  if (result.unintended.length) {
    console.error('Ignored local/session/cache paths are not release-candidate files:');
    for (const path of result.unintended) console.error(`- ${path}`);
  }
  for (const finding of [...result.findings, ...result.history.findings]) console.error(`- ${finding.source}:${finding.line ?? '?'} ${finding.label}`);
  if (!result.passed) {
    console.error('Public release check failed without printing matched values.');
    process.exitCode = 1;
  } else {
    console.log(`Public release check passed for ${result.candidate.files.length} candidate files.`);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();

export { SECRET_PATTERNS };
