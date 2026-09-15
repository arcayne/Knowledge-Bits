# Compatibility policy

This policy describes the supported development and runtime contract. It does not promise compatibility with untested platforms or future releases.

## Supported versions

| Dependency | Supported version |
| --- | --- |
| Node.js | 24.x, enforced by `>=24 <25` |
| pnpm | 9.12.0 |
| PostgreSQL | 16.x; the local demo uses `postgres:16-alpine` |
| Docker | A current Docker Engine and Compose implementation that supports the repository compose file |

The repository uses ESM and workspace packages. Use the lockfile and the supported Node and pnpm versions when reproducing a failure.

## Package and schema versions

Versioned boundaries are explicit:

- `knowledge-bits.package.v1` is the package envelope.
- `knowledge-bits.review-package.v1` is the review-package representation.
- `knowledge-bits.content.v1` is the content envelope.
- `nuglet.lesson.v1` is the current target kind.
- The current story/playbook generation plan is schema `1.1.0`.
- Recipe bindings use semantic versions and a SHA-256 recipe checksum.

A patch release should preserve accepted input and output semantics. A backward-compatible feature can add optional fields or a new adapter version when old consumers can ignore it. A required-field change, changed meaning, removed field, or changed checksum material is breaking.

## Checksum compatibility

Package checksums cover adapter version, content, evidence, QA, asset inventory, locale, owner, and usage-rights metadata. Changing any of these inputs changes the package checksum. Canonicalization changes, checksum algorithm changes, or changes to the fields included in checksum material are checksum-breaking changes.

Never recalculate an existing approved package in place. Store a new package revision and require approval for the new checksum. A delivery retry must use the original package checksum and idempotency key.

## Database migrations and upgrades

Prisma migrations are append-only deployment history. Review each migration for data loss, lock duration, runtime-role grants, and rollback behavior. Apply migrations before starting code that requires the new schema. Keep the migration owner URL separate from the runtime URL.

An upgrade must:

1. create a backup of PostgreSQL and artifact storage;
2. identify the current migration and application revision;
3. apply the migration with the migration helper;
4. run `pnpm prisma:generate`, build, typecheck, and tests;
5. verify package and adapter compatibility with a fixture run; and
6. drain or reconcile in-flight jobs before changing lease or state semantics.

A migration that removes or renames data, changes checksum material, changes lease fencing, or changes delivery identity requires a documented upgrade plan and explicit maintainer review. Do not delete old package or artifact rows as an upgrade shortcut.

## Runtime compatibility limits

V1 is compatible with the repository's Nuglet lesson target only. It is not a generic adapter registry with a promise that every arbitrary JSON payload will work. Provider output must match the configured contract and recipe. A destination must implement the delivery and verification response schemas.

The local fixture profile is not production-compatible: fixture results, local reviewer configuration, filesystem objects, and local delivery receipts must not be promoted as production state. Production review requires an identity boundary. Production artifact storage and destination integrations require their own credentials and operational controls.

When compatibility is uncertain, fail closed with a clear migration, schema, or configuration error. Do not silently coerce a changed package into an older contract.
