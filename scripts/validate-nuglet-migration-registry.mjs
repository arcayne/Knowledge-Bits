import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const registryPath = new URL('../examples/nuglet-migration-registry.example.json', import.meta.url);
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const errors = validateRegistry(registry);
if (process.argv.includes('--live')) errors.push(...verifyLiveNotebookLm(registry));

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Valid NotebookLM migration registry: ${registry.summary.notebookCount} notebooks, ${registry.summary.canonicalNugletCount} canonical Nuglets, ${registry.summary.pendingCanonicalMigrationCount} pending migrations.\n`);
}

function validateRegistry(value) {
  const failures = [];
  if (value?.schemaVersion !== 'knowledge-bits.notebooklm-migration-registry.v1') failures.push('Invalid schemaVersion');
  if (!Array.isArray(value?.notebooks)) return [...failures, 'notebooks must be an array'];
  const ids = new Set();
  const slugs = new Set();
  const runIds = new Set();
  const byId = new Map(value.notebooks.map((entry) => [entry.notebookId, entry]));
  const classifications = new Set(['canonical', 'duplicate', 'manual_review', 'discard']);
  const statuses = new Set(['represented', 'pending', 'duplicate', 'manual_review', 'discard']);
  const readiness = new Set(['complete', 'partial', 'missing']);

  for (const entry of value.notebooks) {
    const label = entry.notebookId || '<missing notebookId>';
    if (!isUuid(entry.notebookId)) failures.push(`${label}: notebookId must be a UUID`);
    if (ids.has(entry.notebookId)) failures.push(`${label}: duplicate notebookId`);
    ids.add(entry.notebookId);
    if (!classifications.has(entry.classification)) failures.push(`${label}: invalid classification`);
    if (!statuses.has(entry.migrationStatus)) failures.push(`${label}: invalid migrationStatus`);
    if (!readiness.has(entry.mediaReadiness)) failures.push(`${label}: invalid mediaReadiness`);
    if (!Number.isInteger(entry.sourceCount) || entry.sourceCount < 0) failures.push(`${label}: invalid sourceCount`);
    for (const role of ['audio', 'infographic', 'quiz', 'other']) {
      if (!Number.isInteger(entry.completedArtifacts?.[role]) || entry.completedArtifacts[role] < 0) failures.push(`${label}: invalid completedArtifacts.${role}`);
    }
    const expectedReadiness = entry.completedArtifacts?.audio >= 2 && entry.completedArtifacts?.infographic >= 1
      ? 'complete'
      : entry.completedArtifacts?.audio === 0 && entry.completedArtifacts?.infographic === 0
        ? 'missing'
        : 'partial';
    if (entry.mediaReadiness !== expectedReadiness) failures.push(`${label}: mediaReadiness must be ${expectedReadiness}`);
    if (entry.classification === 'canonical') {
      if (!entry.nugletTitle || !entry.nugletSlug) failures.push(`${label}: canonical entry requires Nuglet identity`);
      if (slugs.has(entry.nugletSlug)) failures.push(`${label}: canonical nugletSlug ${entry.nugletSlug} is duplicated`);
      slugs.add(entry.nugletSlug);
      if (!['represented', 'pending'].includes(entry.migrationStatus)) failures.push(`${label}: canonical entry must be represented or pending`);
    }
    if (entry.classification === 'duplicate') {
      const canonical = byId.get(entry.canonicalNotebookId);
      if (!canonical || canonical.classification !== 'canonical') failures.push(`${label}: duplicate must reference a canonical notebook`);
    }
    if (entry.migrationStatus === 'represented') {
      if (!isUuid(entry.knowledgeBitsRunId)) failures.push(`${label}: represented entry requires a Knowledge Bits run UUID`);
      if (runIds.has(entry.knowledgeBitsRunId)) failures.push(`${label}: Knowledge Bits run is mapped more than once`);
      runIds.add(entry.knowledgeBitsRunId);
    } else if (entry.knowledgeBitsRunId !== null) failures.push(`${label}: only represented entries may have a knowledgeBitsRunId`);
  }

  const canonical = value.notebooks.filter((entry) => entry.classification === 'canonical');
  const calculated = {
    notebookCount: value.notebooks.length,
    canonicalNugletCount: canonical.length,
    representedInKnowledgeBitsCount: count(canonical, (entry) => entry.migrationStatus === 'represented'),
    pendingCanonicalMigrationCount: count(canonical, (entry) => entry.migrationStatus === 'pending'),
    duplicateCount: count(value.notebooks, (entry) => entry.classification === 'duplicate'),
    manualReviewCount: count(value.notebooks, (entry) => entry.classification === 'manual_review'),
    discardCount: count(value.notebooks, (entry) => entry.classification === 'discard'),
    completeNotebookMediaCount: count(canonical, (entry) => entry.mediaReadiness === 'complete'),
    partialNotebookMediaCount: count(canonical, (entry) => entry.mediaReadiness === 'partial'),
    missingNotebookMediaCount: count(canonical, (entry) => entry.mediaReadiness === 'missing'),
  };
  for (const [key, expected] of Object.entries(calculated)) {
    if (value.summary?.[key] !== expected) failures.push(`summary.${key} must be ${expected}`);
  }
  return failures;
}

function verifyLiveNotebookLm(value) {
  const result = spawnSync('nlm', ['list', 'notebooks', '--json'], { encoding: 'utf8' });
  if (result.error) return [`Could not run nlm: ${result.error.message}`];
  if (result.status !== 0) return [`nlm list notebooks failed: ${(result.stderr || result.stdout).trim()}`];
  let live;
  try { live = JSON.parse(result.stdout); } catch (error) { return [`nlm returned invalid JSON: ${error.message}`]; }
  const failures = [];
  const registryById = new Map(value.notebooks.map((entry) => [entry.notebookId, entry]));
  const liveById = new Map(live.map((entry) => [entry.id, entry]));
  for (const entry of live) {
    const recorded = registryById.get(entry.id);
    if (!recorded) failures.push(`Live notebook ${entry.id} (${entry.title || 'untitled'}) is missing from the registry`);
    else {
      if (recorded.sourceCount !== entry.source_count) failures.push(`${entry.id}: sourceCount is ${entry.source_count} live, ${recorded.sourceCount} recorded`);
      const artifactResult = spawnSync('nlm', ['list', 'artifacts', entry.id, '--json'], { encoding: 'utf8' });
      if (artifactResult.status !== 0) {
        failures.push(`${entry.id}: could not inspect live artifacts: ${(artifactResult.stderr || artifactResult.stdout).trim()}`);
        continue;
      }
      let artifacts;
      try { artifacts = JSON.parse(artifactResult.stdout); } catch (error) {
        failures.push(`${entry.id}: artifact list returned invalid JSON: ${error.message}`);
        continue;
      }
      const completed = { audio: 0, infographic: 0, quiz: 0, other: 0 };
      for (const artifact of artifacts.filter((candidate) => candidate.status === 'completed')) {
        if (artifact.type in completed && artifact.type !== 'other') completed[artifact.type] += 1;
        else completed.other += 1;
      }
      for (const role of Object.keys(completed)) {
        if (recorded.completedArtifacts[role] !== completed[role]) failures.push(`${entry.id}: completed ${role} count is ${completed[role]} live, ${recorded.completedArtifacts[role]} recorded`);
      }
    }
  }
  for (const entry of value.notebooks) if (!liveById.has(entry.notebookId)) failures.push(`Registry notebook ${entry.notebookId} is no longer present live`);
  return failures;
}

function count(values, predicate) { return values.filter(predicate).length; }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
