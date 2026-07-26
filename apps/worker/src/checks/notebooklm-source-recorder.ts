import { createHash } from 'node:crypto';

import type { ProviderBinaryAsset } from '../providers/types.js';

interface CandidateSource {
  sourceId: string;
  title: string;
  url: string;
}

interface SourceDecision extends CandidateSource {
  readability: { passed: boolean; reason: string | null };
  credibility: { passed: boolean; policy: string; reason: string | null };
}

export interface NotebookLmResearchEvidence {
  acceptedSources: Array<SourceDecision & { retrievedAt: string; snapshotChecksum: string }>;
  rejectedSources: SourceDecision[];
  coverageGaps: Array<{ topic: string; reason: string }>;
}

/** Records NotebookLM's selected source list without re-evaluating the documents. */
export class NotebookLmSourceRecorder {
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async verify(value: unknown, _signal: AbortSignal): Promise<{
    evidence: NotebookLmResearchEvidence;
    snapshots: ProviderBinaryAsset[];
  }> {
    const acceptedSources: NotebookLmResearchEvidence['acceptedSources'] = [];
    const rejectedSources: NotebookLmResearchEvidence['rejectedSources'] = [];
    const snapshots: ProviderBinaryAsset[] = [];
    const seenUrls = new Set<string>();

    for (const source of parseCandidates(value)) {
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
        rejectedSources.push(rejected(source, 'https_required', 'https_required'));
        continue;
      }

      const retrievedAt = this.now().toISOString();
      const body = Buffer.from(JSON.stringify({
        schemaVersion: 'notebooklm.source-receipt.v1',
        sourceId: source.sourceId,
        title: source.title,
        url: normalizedUrl,
        selectedAt: retrievedAt,
      }));
      const snapshotChecksum = createHash('sha256').update(body).digest('hex');
      acceptedSources.push({
        ...source,
        url: normalizedUrl,
        retrievedAt,
        snapshotChecksum,
        readability: { passed: true, reason: null },
        credibility: { passed: true, policy: 'notebooklm-source-selection.v1', reason: null },
      });
      snapshots.push({
        kind: 'source_snapshot',
        mediaType: 'application/json',
        body,
        inputChecksum: null,
        provenance: {
          provider: 'notebooklm',
          sourceId: source.sourceId,
          sourceUrl: normalizedUrl,
          sourceRecord: 'notebooklm.source-receipt.v1',
        },
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
      policy: 'notebooklm-source-selection.v1',
      reason: credibilityReason,
    },
  };
}
