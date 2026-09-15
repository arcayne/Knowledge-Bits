import { createHash } from 'node:crypto';

import type { ProviderExecutionInput, ProviderSupportArtifact } from '../providers/types.js';
import type { ResolvedRecipe } from './types.js';

export function generationSupportArtifacts(input: {
  recipe: ResolvedRecipe;
  prompt: Uint8Array;
  model: string;
  executionInput: ProviderExecutionInput;
}): readonly ProviderSupportArtifact[] {
  const promptChecksum = prefixedChecksum(input.prompt);
  const provenance = {
    recipeId: input.recipe.id,
    recipeVersion: input.recipe.version,
    recipeChecksum: input.recipe.checksum,
    promptChecksum,
    model: input.model,
    referenceChecksums: dependencyChecksums(input.executionInput),
  };
  return [{
    kind: 'generation.recipe.snapshot',
    mediaType: 'application/json',
    body: input.recipe.canonicalBytes,
    inputChecksum: null,
    provenance,
  }, {
    kind: 'generation.prompt.rendered',
    mediaType: 'text/plain',
    body: input.prompt,
    inputChecksum: input.recipe.checksum.replace(/^sha256:/, ''),
    provenance,
  }];
}

function dependencyChecksums(input: ProviderExecutionInput): readonly string[] {
  if (!Array.isArray(input.job.input.dependencies)) return [];
  return [...new Set(input.job.input.dependencies.flatMap((dependency) => {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) return [];
    const checksum = (dependency as { checksum?: unknown }).checksum;
    if (typeof checksum !== 'string') return [];
    if (/^[a-f0-9]{64}$/.test(checksum)) return [`sha256:${checksum}`];
    return /^sha256:[a-f0-9]{64}$/.test(checksum) ? [checksum] : [];
  }))].sort();
}

function prefixedChecksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
