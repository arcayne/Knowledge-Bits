import type {
  ArtifactReference,
  KnowledgeBitsContent,
  KnowledgeBitsEvidence,
  KnowledgeBitsQa,
} from '@knowledge-bits/contracts';

export interface ImmutableApprovedKnowledgeBits {
  id: string;
  schemaVersion: 'knowledge-bits.review-package.v1';
  packageId: string;
  revision: number;
  packageChecksum: string;
  adapterVersion: string;
  locale: string;
  owner: string;
  usageRights: Record<string, unknown>;
  content: KnowledgeBitsContent;
  evidence: KnowledgeBitsEvidence;
  qa: KnowledgeBitsQa;
  artifactInventory: ArtifactReference[];
  approval: {
    status: 'approved';
    reviewerId: string;
    decidedAt: string;
    approvedChecksum: string;
    comment: null;
  };
}

export interface DeliveryAdapterInput {
  knowledgeBits: ImmutableApprovedKnowledgeBits;
  packageVersionId: string;
  packageChecksum: string;
  idempotencyKey: string;
}

export interface DeliveryAdapterResponse {
  externalId: string;
  previewUrl: string;
  status: 'imported' | 'already_imported';
}

export interface DeliveryVerificationResponse {
  matches: boolean;
  url: string;
}

export interface DeliveryAdapter {
  deliver(input: DeliveryAdapterInput, signal?: AbortSignal): Promise<DeliveryAdapterResponse>;
  verify(input: {
    externalId: string;
    packageChecksum: string;
  }, signal?: AbortSignal): Promise<DeliveryVerificationResponse>;
}
