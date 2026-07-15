import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type { NugletGenerationPlan } from '@knowledge-bits/contracts';

import type { RecipeBinding, RecipeRegistry, ResolvedRecipe } from './types.js';

interface RecipeManifestEntry {
  id: string;
  version: string;
  status: 'approved' | 'retired';
  path: string;
  checksum: string;
}

interface RecipeManifest {
  contentKind: string;
  recipes: readonly RecipeManifestEntry[];
}

export class RecipeRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RecipeRegistryError';
  }
}

export class FileRecipeRegistry implements RecipeRegistry {
  private readonly roots: Readonly<Record<string, string>>;

  constructor(roots: Readonly<Record<string, string>>) {
    this.roots = Object.fromEntries(Object.entries(roots).map(([contentKind, root]) => [
      contentKind,
      realDirectory(root),
    ]));
  }

  resolve(binding: RecipeBinding): ResolvedRecipe {
    const root = this.roots[binding.contentKind];
    if (!root) throw new RecipeRegistryError('recipe_registry_missing', `No recipe registry is configured for ${binding.contentKind}`);
    const manifest = readManifest(root);
    if (manifest.contentKind !== binding.contentKind) {
      throw new RecipeRegistryError('recipe_manifest_invalid', 'Recipe manifest content kind does not match its configured root');
    }
    const entry = manifest.recipes.find((candidate) => (
      candidate.id === binding.id && candidate.version === binding.version
    ));
    if (!entry) throw new RecipeRegistryError('recipe_not_found', `Recipe ${binding.id}@${binding.version} is not registered`);
    const recipePath = resolveInside(root, entry.path);
    const value = readJsonObject(recipePath, 'recipe_json_invalid');
    if (value.id !== entry.id || value.version !== entry.version || value.status !== entry.status) {
      throw new RecipeRegistryError('recipe_identity_mismatch', `Recipe identity does not match ${entry.id}@${entry.version}`);
    }
    const canonicalBytes = canonicalJsonBytes(value);
    const calculated = prefixedChecksum(canonicalBytes);
    if (calculated !== entry.checksum || calculated !== binding.checksum) {
      throw new RecipeRegistryError('recipe_checksum_mismatch', `Recipe checksum does not match ${entry.id}@${entry.version}`);
    }
    return {
      id: entry.id,
      version: entry.version,
      checksum: calculated,
      canonicalBytes,
      value,
    };
  }

  verify(plan: NugletGenerationPlan): boolean {
    try {
      return Object.values(plan.recipes).every((binding) => {
        this.resolve({ contentKind: plan.contentKind, ...binding });
        return true;
      });
    } catch (error) {
      if (error instanceof RecipeRegistryError) return false;
      throw error;
    }
  }
}

export function renderPromptSections(sections: readonly string[]): Uint8Array {
  const rendered = sections
    .map((section) => section
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[\t ]+$/g, ''))
      .join('\n')
      .replace(/\n+$/g, ''))
    .filter(Boolean)
    .join('\n\n');
  return Buffer.from(rendered);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(sortJson(value), null, 2)}\n`);
}

function readManifest(root: string): RecipeManifest {
  const value = readJsonObject(resolveInside(root, 'manifest.json'), 'recipe_manifest_invalid');
  if (typeof value.contentKind !== 'string' || !value.contentKind.trim() || !Array.isArray(value.recipes)) {
    throw new RecipeRegistryError('recipe_manifest_invalid', 'Recipe manifest requires contentKind and recipes');
  }
  const recipes = value.recipes.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.id !== 'string'
      || typeof candidate.version !== 'string'
      || (candidate.status !== 'approved' && candidate.status !== 'retired')
      || typeof candidate.path !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(String(candidate.checksum))) {
      throw new RecipeRegistryError('recipe_manifest_invalid', 'Recipe manifest contains an invalid entry');
    }
    const status: RecipeManifestEntry['status'] = candidate.status;
    return {
      id: candidate.id,
      version: candidate.version,
      status,
      path: candidate.path,
      checksum: String(candidate.checksum),
    };
  });
  return { contentKind: value.contentKind, recipes };
}

function resolveInside(root: string, path: string): string {
  if (!path || isAbsolute(path)) throw new RecipeRegistryError('recipe_path_invalid', 'Recipe paths must be relative');
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new RecipeRegistryError('recipe_path_invalid', 'Recipe path escapes its configured root');
  }
  try {
    const real = realpathSync(candidate);
    const realRelative = relative(root, real);
    if (!realRelative || realRelative.startsWith('..') || isAbsolute(realRelative) || !lstatSync(real).isFile()) {
      throw new Error('not a contained file');
    }
    return real;
  } catch (error) {
    if (error instanceof RecipeRegistryError) throw error;
    throw new RecipeRegistryError('recipe_path_invalid', `Cannot resolve recipe path: ${String(error)}`);
  }
}

function realDirectory(path: string): string {
  try {
    const root = realpathSync(resolve(path));
    if (!lstatSync(root).isDirectory()) throw new Error('not a directory');
    return root;
  } catch (error) {
    throw new RecipeRegistryError('recipe_registry_missing', `Cannot resolve recipe registry: ${String(error)}`);
  }
}

function readJsonObject(path: string, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(value)) throw new TypeError('expected an object');
    return value;
  } catch (error) {
    throw new RecipeRegistryError(code, `Cannot read recipe JSON: ${String(error)}`);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value)
      .sort(codeUnitCompare)
      .map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function prefixedChecksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
