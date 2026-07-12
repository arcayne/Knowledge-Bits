import {
  artifactPrepareResponseSchema,
  artifactReferenceSchema,
  jobClaimSchema,
  type ArtifactCompleteRequest,
  type ArtifactPrepareRequest,
  type ArtifactPrepareResponse,
  type JobClaim,
  type JobResult,
  type ReportJobResultRequest,
} from '@knowledge-bits/contracts';

export type HeartbeatResult = { kind: 'continue' } | { kind: 'interrupted' };

export interface WorkerEngineClient {
  claim(leaseSeconds: number): Promise<JobClaim | null>;
  heartbeat(job: JobClaim): Promise<HeartbeatResult>;
  prepareArtifact(input: ArtifactPrepareRequest): Promise<ArtifactPrepareResponse>;
  uploadArtifact(prepared: ArtifactPrepareResponse, body: Uint8Array): Promise<void>;
  completeArtifact(input: ArtifactCompleteRequest): Promise<void>;
  reportResult(result: JobResult, retryAt?: string): Promise<void>;
}

export class EngineClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'EngineClientError';
  }
}

export class HttpEngineClient implements WorkerEngineClient {
  private readonly baseUrl: string;

  constructor(
    private readonly options: {
      baseUrl: string;
      workerToken: string;
      fetch?: typeof fetch;
    },
  ) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  async claim(leaseSeconds: number): Promise<JobClaim | null> {
    const response = await this.request('/jobs/claim', {
      method: 'POST',
      body: JSON.stringify({ leaseSeconds }),
    });
    if (response.status === 204) return null;
    return jobClaimSchema.parse(await this.readJson(response));
  }

  async heartbeat(job: JobClaim): Promise<HeartbeatResult> {
    const response = await this.request(`/jobs/${job.jobId}/heartbeat`, { method: 'POST' });
    if (response.status === 204) return { kind: 'continue' };
    const body = await this.readJson(response);
    if (isHeartbeatResult(body)) return body;
    throw new EngineClientError('Invalid heartbeat response', response.status);
  }

  async prepareArtifact(input: ArtifactPrepareRequest): Promise<ArtifactPrepareResponse> {
    const response = await this.request('/artifacts/prepare', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return artifactPrepareResponseSchema.parse(await this.readJson(response));
  }

  async uploadArtifact(prepared: ArtifactPrepareResponse, body: Uint8Array): Promise<void> {
    const response = await (this.options.fetch ?? fetch)(prepared.uploadUrl, {
      method: 'PUT',
      headers: prepared.requiredHeaders,
      body: Buffer.from(body),
    });
    if (!response.ok) {
      throw new EngineClientError(`Artifact upload failed with ${response.status}`, response.status);
    }
  }

  async completeArtifact(input: ArtifactCompleteRequest): Promise<void> {
    const response = await this.request('/artifacts/complete', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    artifactReferenceSchema.parse(await this.readJson(response));
  }

  async reportResult(result: JobResult, retryAt?: string): Promise<void> {
    const request: ReportJobResultRequest = retryAt ? { result, retryAt } : { result };
    await this.request(`/jobs/${result.jobId}/result`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.workerToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (response.ok) return response;

    const body = await response.text();
    throw new EngineClientError(
      body ? `Engine API request failed with ${response.status}: ${body}` : `Engine API request failed with ${response.status}`,
      response.status,
    );
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new EngineClientError('Engine API returned invalid JSON', response.status);
    }
  }
}

function isHeartbeatResult(value: unknown): value is HeartbeatResult {
  return typeof value === 'object'
    && value !== null
    && 'kind' in value
    && (value.kind === 'continue' || value.kind === 'interrupted');
}
