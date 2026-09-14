# Adapters

Adapters keep provider and destination choices outside the workflow state machine. Provider-backed integrations are optional. The local demo uses fixture responses and local filesystem implementations.

## Extension points

### Source

A Source adapter discovers or accepts candidate sources. It must return bounded, inspectable source material and provenance. The worker validates public HTTPS sources, captures exact snapshot bytes, computes a checksum, and records the accepted source before later stages use it. A source recommendation is not evidence until this boundary accepts it.

### Generation

A Generation adapter creates structured content from the lease-scoped brief, accepted evidence, and resolved recipe bindings. Its result includes parsed output, the raw response, an execution report, and any generation support artifacts. The API and worker validate the output against the target contract and bind it to input checksums.

### Check

A Check adapter runs deterministic schema, evidence, and quality checks. A failed quality result can request a bounded create revision. It must report explicit findings. It must not approve content or advance a stage by itself.

### Artifact

An Artifact adapter produces binary or structured stage output, such as a hero, infographic, or audio file. Each output declares a kind, media type, bytes, provenance, and the input checksum it represents. The API computes or inspects the stored checksum and rejects metadata mismatches.

### ArtifactStorage

`ArtifactStorageAdapter` is the storage boundary used by the API:

```ts
interface ArtifactStorageAdapter {
  preparePut(input: {
    storageKey: string;
    mediaType: string;
    expiresInSeconds: number;
  }): Promise<{
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
  }>;
  inspect(storageKey: string): Promise<{
    checksum: string;
    byteSize: number;
    mediaType: string;
  }>;
  read(storageKey: string): Promise<Uint8Array>;
}
```

The repository provides a local filesystem adapter and an optional Cloudflare R2 adapter. The API owns storage keys and verifies bytes after upload.

### Destination

`DeliveryAdapter` sends an approved package and verifies the resulting destination state:

```ts
interface DeliveryAdapter {
  deliver(input: DeliveryAdapterInput, signal?: AbortSignal): Promise<{
    externalId: string;
    previewUrl: string;
    status: 'imported' | 'already_imported';
  }>;
  verify(input: {
    externalId: string;
    packageChecksum: string;
  }, signal?: AbortSignal): Promise<{
    matches: boolean;
    url: string;
  }>;
}
```

Delivery receives a stable idempotency key. It must not mutate a package or treat a different checksum as the same import.

## Local fixture customization

A fixture provider implements the worker provider contract. It maps each worker action to a JSON response and returns deterministic raw bytes and a fixture checksum. Use a copy outside the repository when experimenting so generated data does not become a repository change.

1. Copy the checked-in fixtures and edit one response:

```bash
rm -rf /tmp/knowledge-bits-fixtures
cp -R apps/worker/src/providers/fixtures /tmp/knowledge-bits-fixtures
# Edit /tmp/knowledge-bits-fixtures/check-content.json.
# Keep the fixture envelope and required output fields valid.
```

2. Configure a worker to use the copy. The API must already be running with a local runtime database, local API token, and fixture-compatible worker credential. The worker receives only its own token:

```bash
export ENGINE_API_BASE_URL=http://127.0.0.1:3000
export ENGINE_WORKER_TOKEN=replace-with-your-local-worker-token
export WORKER_PROVIDER_MODE=fixture
export WORKER_FIXTURE_DIRECTORY=/tmp/knowledge-bits-fixtures
pnpm --filter @knowledge-bits/worker exec tsx src/index.ts
```

3. Validate the customization before relying on it:

```bash
pnpm --filter @knowledge-bits/worker typecheck
pnpm --filter @knowledge-bits/worker test
pnpm test:local-demo
```

The fixture directory must contain the action files used by the run: `collect-sources.json`, `create-content.json` (or the schema-specific content fixture), `check-content.json`, `produce-assets.json`, and `deliver-package.json`. The edited response must pass the target schema and preserve required evidence and checksum placeholders. A malformed response fails the worker; it does not create fallback content.

For a complete isolated run, use the local demo setup and seed commands from the [README](../README.md), then start the API and worker with the copied fixture directory. The `local-demo` command itself checks the committed fixture set, so do not replace its committed directory or claim that a custom file is part of the demo proof.

## Production adapters

Production providers may include NotebookLM, Pi/Vertex inference, and deterministic local media tools. Configure them only in a worker environment. Production mode does not fall back to fixtures when provider configuration is absent or invalid; the affected stage waits or needs human action.

A production destination can implement the HTTP delivery contract. The destination URL and token are deployment configuration. Do not place destination credentials in fixture files, examples, issue reports, or commits.
