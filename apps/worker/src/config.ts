import { isAbsolute } from 'node:path';

export function parseProductRecipeRoots(value: string | undefined): Readonly<Record<string, string>> {
  if (!value?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || Object.keys(parsed).length === 0) throw new TypeError('expected a non-empty object');
    for (const [contentKind, root] of Object.entries(parsed)) {
      if (!contentKind.trim() || typeof root !== 'string' || !root.trim() || !isAbsolute(root)) {
        throw new TypeError('expected absolute recipe roots');
      }
    }
    return parsed as Record<string, string>;
  } catch {
    throw new Error('product_recipe_roots_invalid');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
