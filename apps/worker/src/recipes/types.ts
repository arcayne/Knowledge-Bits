import type { NugletGenerationPlan } from '@knowledge-bits/contracts';

export interface RecipeBinding {
  contentKind: string;
  id: string;
  version: string;
  checksum: string;
}

export interface ResolvedRecipe {
  id: string;
  version: string;
  checksum: string;
  canonicalBytes: Uint8Array;
  value: Readonly<Record<string, unknown>>;
}

export interface RecipeRegistry {
  resolve(binding: RecipeBinding): ResolvedRecipe;
  verify(plan: NugletGenerationPlan): boolean;
}
