export interface ResearchSourceCandidate {
  sourceId: string;
  title: string;
  url: string;
  sourceType: string;
  rationale: string;
}

export interface ResearchSourceDiscoveryResult {
  candidates: ResearchSourceCandidate[];
  report: {
    schemaVersion: 'research-source-discovery.v1';
    provider: string;
    model: string;
    topic: string;
    seedSourceCount: number;
    requestedCandidateCount: number;
    returnedCandidateCount: number;
    searchQueries?: string[];
  };
}

export interface ResearchSourceDiscoveryClient {
  discoverSources(input: {
    topic: string;
    audience: string;
    objective: string;
    seedUrls: readonly string[];
    maxCandidates: number;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<ResearchSourceDiscoveryResult>;
}
