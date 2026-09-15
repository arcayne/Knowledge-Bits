import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { ProviderBinaryAsset } from '../providers/types.js';

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
    allowPublicHosts?: boolean;
    fetch?: typeof fetch;
    resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
    now?: () => Date;
    timeoutMs?: number;
    maxBytes?: number;
    maxPdfBytes?: number;
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
      const publicUrlRejection = publicUrlRejectionReason(url);
      if (publicUrlRejection) {
        rejectedSources.push(rejected(source, 'not_fetched_untrusted', publicUrlRejection));
        continue;
      }
      const trustedHost = this.trustedHosts.has(url.hostname.toLowerCase());
      const hostRejection = await this.hostRejectionReason(url);
      if (hostRejection) {
        rejectedSources.push(rejected(source, 'not_fetched_untrusted', hostRejection));
        continue;
      }

      let retrieval: { response: Response; finalUrl: URL };
      try {
        retrieval = await this.fetchSource(url, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        rejectedSources.push(rejected(
          source,
          error instanceof SourceRetrievalError ? error.reason : 'source_transport_unavailable',
          null,
        ));
        continue;
      }
      const { response, finalUrl } = retrieval;
      const retrievedUrl = finalUrl.toString();
      const mediaType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!response.ok) {
        rejectedSources.push(rejected(source, `http_${response.status}`, null));
        continue;
      }
      if (!['text/html', 'text/plain', 'application/xhtml+xml', 'application/pdf'].includes(mediaType)) {
        rejectedSources.push(rejected(source, 'unsupported_media_type', null));
        continue;
      }
      const maxBytes = mediaType === 'application/pdf'
        ? this.options.maxPdfBytes ?? 10_000_000
        : this.options.maxBytes ?? 2_000_000;
      const declaredSize = Number(response.headers.get('Content-Length'));
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        rejectedSources.push(rejected(source, 'snapshot_too_large', null));
        continue;
      }
      let body: Uint8Array;
      try {
        body = await readBoundedBody(response, maxBytes);
      } catch (error) {
        rejectedSources.push(rejected(
          source,
          error instanceof SourceRetrievalError ? error.reason : 'source_read_failed',
          null,
        ));
        continue;
      }
      if (mediaType === 'application/pdf') {
        if (!Buffer.from(body.subarray(0, 5)).equals(Buffer.from('%PDF-'))) {
          rejectedSources.push(rejected(source, 'invalid_pdf', null));
          continue;
        }
      } else {
        const readable = Buffer.from(body).toString('utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (readable.length < (this.options.minimumReadableCharacters ?? 120)) {
          rejectedSources.push(rejected(source, 'content_too_short', null));
          continue;
        }
      }

      const snapshotChecksum = createHash('sha256').update(body).digest('hex');
      acceptedSources.push({
        ...source,
        url: retrievedUrl,
        retrievedAt: this.now().toISOString(),
        snapshotChecksum,
        readability: { passed: true, reason: null },
        credibility: {
          passed: true,
          policy: trustedHost ? 'trusted-https-hosts.v1' : 'public-readable-source.v1',
          reason: null,
        },
      });
      snapshots.push({
        kind: 'source_snapshot',
        mediaType,
        body,
        inputChecksum: null,
        provenance: { sourceId: source.sourceId, sourceUrl: retrievedUrl },
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

  private async fetchSource(url: URL, signal: AbortSignal): Promise<{ response: Response; finalUrl: URL }> {
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
      const combined = AbortSignal.any([signal, timeout]);
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(current, { redirect: 'manual', signal: combined });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SourceRetrievalError(timeout.aborted ? 'source_snapshot_timeout' : 'source_transport_unavailable');
      }
      if (response.status === 429 || response.status >= 500) {
        throw new SourceRetrievalError(`http_${response.status}`);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return { response, finalUrl: current };
      }
      const location = response.headers.get('Location');
      if (!location) throw new SourceRetrievalError('redirect_location_missing');
      const next = new URL(location, current);
      const rejection = publicUrlRejectionReason(next);
      if (rejection) throw new SourceRetrievalError(rejection);
      const hostRejection = await this.hostRejectionReason(next);
      if (hostRejection) throw new SourceRetrievalError(hostRejection);
      current = next;
    }
    throw new SourceRetrievalError('too_many_redirects');
  }

  private async hostRejectionReason(url: URL): Promise<string | null> {
    if (this.trustedHosts.has(url.hostname.toLowerCase())) return null;
    if (!this.options.allowPublicHosts) return 'host_not_trusted';
    let addresses: readonly string[];
    try {
      addresses = await (this.options.resolveAddresses ?? resolvePublicAddresses)(url.hostname);
    } catch {
      return 'dns_unresolved';
    }
    return addresses.length === 0 || addresses.some(isPrivateAddress)
      ? 'non_public_address'
      : null;
  }
}

class SourceRetrievalError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SourceRetrievalError('snapshot_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceRetrievalError) throw error;
    throw new SourceRetrievalError('source_read_failed');
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export function publicUrlRejectionReason(url: URL): string | null {
  if (url.protocol !== 'https:') return 'https_required';
  if (url.username || url.password) return 'url_credentials_not_allowed';
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'metadata.google.internal'
    || (!hostname.includes('.') && isIP(hostname) === 0)) {
    return 'non_public_host';
  }
  if (isPrivateAddress(hostname)) return 'non_public_address';
  return null;
}

function isPrivateAddress(hostname: string): boolean {
  if (isIP(hostname) === 4) {
    const parts = hostname.split('.').map(Number);
    const [first = 0, second = 0] = parts;
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || first >= 224;
  }
  if (isIP(hostname) === 6) {
    const normalized = hostname.toLowerCase();
    const mapped = normalized.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (mapped?.[2] && mapped[3]) {
      const high = Number.parseInt(mapped[2], 16);
      const low = Number.parseInt(mapped[3], 16);
      return isPrivateAddress([
        high >> 8,
        high & 0xff,
        low >> 8,
        low & 0xff,
      ].join('.'));
    }
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('ff');
  }
  return false;
}

async function resolvePublicAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
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
      policy: 'deterministic-source-policy.v2',
      reason: credibilityReason,
    },
  };
}
