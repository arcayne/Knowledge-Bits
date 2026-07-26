import { readFile } from 'node:fs/promises';

import { materializeNugletMigration } from '../src/migrations/nuglet-migration.js';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const [inventoryPath, artifactRoot, nugletMediaPublicBaseUrl = 'https://media.nuglet.app'] = args;
if (!inventoryPath || !artifactRoot) {
  throw new Error(
    'Usage: prepare-nuglet-migration <inventory.json> <artifact-root> [nuglet-media-public-base-url]',
  );
}

const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as unknown;
const receipt = await materializeNugletMigration(inventory, {
  artifactRoot,
  nugletR2PublicBaseUrl: nugletMediaPublicBaseUrl,
});
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
