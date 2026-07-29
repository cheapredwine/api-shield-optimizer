export type DiscoverySource = 'machinelearning' | 'sessionidentifier' | 'manual' | 'imported';
export type EndpointStatus = 'candidate' | 'saved' | 'ignored';
export type Action = 'save' | 'ignore' | 'manual_review';

export interface Endpoint {
  id: string;
  accountId: string;
  zoneId: string;
  host: string;
  method: string;
  path: string;
  source: DiscoverySource;
  hits: number;
  lastSeenAt: string;
  labels?: string[];
  status?: EndpointStatus;
  rawReference: unknown;
}

export interface NormalizedGroup {
  groupId: string;
  normalizedHostPattern: string;
  normalizedPathPattern: string;
  method: string;
  members: Endpoint[];
  recommendedAction: Action;
  confidence: number;
  reasoning: string[];
  flags: string[];
}

export interface Proposal {
  proposalId: string;
  groupId: string;
  action: Action;
  target: {
    canonicalPattern: string;
    membersCount: number;
    representativeMembers: Endpoint[];
  };
  before: {
    rawEndpoints: Endpoint[];
  };
  after: {
    normalizedHostPattern: string;
    normalizedPathPattern: string;
    method: string;
  };
  reason: string;
  evidence: string[];
  risk: string;
  requiresHumanReview: boolean;
  suggestedFollowUp: string;
  whyThisGroupingIsSafe: string;
  whyThisGroupingIsUseful: string;
  whyItMayBeWrong: string;
  confidenceScore: number;
  operatorNotes: string;
}

export interface ProposalBundle {
  generatedAt: string;
  scope: {
    accountId?: string;
    zoneId?: string;
    endpointCount: number;
    groupCount: number;
  };
  proposals: Proposal[];
  summary: {
    saveCount: number;
    ignoreCount: number;
    manualReviewCount: number;
    totalHits: number;
  };
}

export interface ConnectorConfig {
  mode: 'api' | 'mcp' | 'snapshot';
  apiToken?: string;
  accountId?: string;
  zoneId?: string;
  snapshotPath?: string;
  state?: string;
}

export interface Zone {
  id: string;
  name: string;
  accountId: string;
  status: string;
  plan: string;
}

export interface DataConnector {
  fetchEndpoints(config: ConnectorConfig): Promise<Endpoint[]>;
}
