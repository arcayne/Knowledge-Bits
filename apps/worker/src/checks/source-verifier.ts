import { createHash } from 'node:crypto';

import { ProviderWaitingError, type ProviderBinaryAsset } from '../providers/types.js';

interface CandidateSource {
  sourceId: string;
  title: string;
  url: string;
}

interface SourceDecision {
  sourceId: string;
  title: string;
  url: string;
  readability: { passed: boolean; reason: string | null };
  credibility: { passed: boolean; policy: string; reason: string | null };
}

export interface VerifiedResearchEvidence {
  acceptedSources: Array<SourceDecision & { retrievedAt: string; snapshotChecksum: string }>;
  rejectedSources: SourceDecision[];
  coverageGaps: Array<{ topic: string; reason: string }>;
}

export class DeterministicSourceVerifier {
  private readonly trustedHosts: Set<string>;
  private readonly now: () => Date;

  constructor(private readonly options: {
    trustedHosts: readonly string[];
    fetch?: typeof fetch;
    now?: () => Date;
    timeoutMs?: number;
    maxBytes?: number;
    minimumReadableCharacters?: number;
  }) {
    this.trustedHosts = new Set(options.trustedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
    this.now = options.now ?? (() => new Date());
  }

  async verify(value: unknown, signal: AbortSignal): Promise<{
    evidence: VerifiedResearchEvidence;
    snapshots: ProviderBinaryAsset[];
  }> {
    const sources = parseCandidates(value);
    const acceptedSources: VerifiedResearchEvidence['acceptedSources'] = [];
    const rejectedSources: VerifiedResearchEvidence['rejectedSources'] = [];
    const snapshots: ProviderBinaryAsset[] = [];
    const seenUrls = new Set<string>();

    for (const source of sources) {
      let url: URL;
      try {
        url = new URL(source.url);
      } catch {
        rejectedSources.push(rejected(source, 'invalid_url', 'invalid_url'));
        continue;
      }
      const normalizedUrl = url.toString();
      if (seenUrls.has(normalizedUrl)) {
        rejectedSources.push(rejected(source, 'duplicate_url', null));
        continue;
      }
      seenUrls.add(normalizedUrl);
      if (url.protocol !== 'https:') {
        rejectedSources.push(rejected(source, 'not_fetched_untrusted', 'https_required'));
        continue;
      }
      if (!this.trustedHosts.has(url.hostname.toLowerCase())) {
        rejectedSources.push(rejected(source, 'not_fetched_untrusted', 'host_not_trusted'));
        continue;
      }

      const response = await this.fetchSource(url, signal);
      const mediaType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!response.ok) {
        rejectedSources.push(rejected(source, `http_${response.status}`, null));
        continue;
      }
      if (!['text/html', 'text/plain', 'application/xhtml+xml'].includes(mediaType)) {
        rejectedSources.push(rejected(source, 'unsupported_media_type', null));
        continue;
      }
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > (this.options.maxBytes ?? 1_000_000)) {
        rejectedSources.push(rejected(source, 'snapshot_too_large', null));
        continue;
      }
      const readable = Buffer.from(body).toString('utf8')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (readable.length < (this.options.minimumReadableCharacters ?? 120)) {
        rejectedSources.push(rejected(source, 'content_too_short', null));
        continue;
      }

      const snapshotChecksum = createHash('sha256').update(body).digest('hex');
      acceptedSources.push({
        ...source,
        retrievedAt: this.now().toISOString(),
        snapshotChecksum,
        readability: { passed: true, reason: null },
        credibility: { passed: true, policy: 'trusted-https-hosts.v1', reason: null },
      });
      snapshots.push({
        kind: 'source_snapshot',
        mediaType,
        body,
        inputChecksum: null,
        provenance: { sourceId: source.sourceId, sourceUrl: normalizedUrl },
      });
    }

    return {
      evidence: {
        acceptedSources,
        rejectedSources,
        coverageGaps: rejectedSources.map((source) => ({
          topic: source.title,
          reason: source.readability.reason ?? source.credibility.reason ?? 'source_rejected',
        })),
      },
      snapshots,
    };
  }

  private async fetchSource(url: URL, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await (this.options.fetch ?? fetch)(url, { redirect: 'error', signal: combined });
      if (response.status === 429 || response.status >= 500) {
        throw new ProviderWaitingError('source_snapshot_transport_unavailable', new Date(this.now().getTime() + 60_000).toISOString());
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderWaitingError || signal.aborted) throw error;
      throw new ProviderWaitingError(
        timeout.aborted ? 'source_snapshot_timeout' : 'source_snapshot_transport_unavailable',
        new Date(this.now().getTime() + 60_000).toISOString(),
      );
    }
  }
}

function parseCandidates(value: unknown): CandidateSource[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { sources?: unknown }).sources)) {
    throw new TypeError('Research output requires candidate sources');
  }
  return (value as { sources: unknown[] }).sources.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Research candidate must be an object');
    const candidate = source as Record<string, unknown>;
    if (typeof candidate.sourceId !== 'string'
      || typeof candidate.title !== 'string'
      || typeof candidate.url !== 'string') {
      throw new TypeError('Research candidate requires sourceId, title, and url');
    }
    return { sourceId: candidate.sourceId, title: candidate.title, url: candidate.url };
  });
}

function rejected(source: CandidateSource, readabilityReason: string, credibilityReason: string | null): SourceDecision {
  return {
    ...source,
    readability: { passed: false, reason: readabilityReason },
    credibility: {
      passed: credibilityReason === null,
      policy: 'trusted-https-hosts.v1',
      reason: credibilityReason,
    },
  };
}
