export type DiscoverySource = 'machinelearning' | 'sessionidentifier' | 'manual' | 'imported';
export type EndpointStatus = 'candidate' | 'saved' | 'ignored';
export type Action = 'save' | 'ignore' | 'manual_review';

/** Which axis a scoring signal contributes to. */
export type SignalAxis = 'api' | 'sensitivity';

export interface Signal {
  /** Stable identifier so downstream tooling can filter/diff on signals. */
  id: string;
  axis: SignalAxis;
  /** Signed contribution applied to the axis score. */
  weight: number;
  detail: string;
}

/**
 * Per-operation observability derived from the API Shield discovery `features`
 * block. Every field is optional: absence means "not observed", which is
 * meaningfully different from a zero value.
 */
export interface EndpointFeatures {
  /** Distinct authentication identifiers seen on the operation. */
  authIdTokens?: number;
  /** Number of samples backing the threshold estimates. */
  dataPoints?: number;
  /** Suggested rate-limit threshold from API Shield. */
  suggestedThreshold?: number;
  p50?: number;
  p90?: number;
  p99?: number;
  /** Requests counted within the feature observation period. */
  periodRequests?: number;
  periodSeconds?: number;
}

export interface Endpoint {
  id: string;
  accountId: string;
  zoneId: string;
  host: string;
  method: string;
  path: string;
  source: DiscoverySource;
  /**
   * Observed request count, or `null` when traffic data is unavailable.
   * Managed operations carry no traffic data; treating them as `0` would
   * incorrectly penalise already-saved production endpoints.
   */
  hits: number | null;
  lastSeenAt: string;
  labels?: string[];
  status?: EndpointStatus;
  /** True when the operation appears in a customer-uploaded API schema. */
  inSchema?: boolean;
  features?: EndpointFeatures;
  rawReference: unknown;
}

export interface GroupScore {
  /** 0..1 confidence that the group represents an API rather than a web page. */
  api: number;
  /** 0..1 estimate of how valuable the group is to protect. */
  sensitivity: number;
  /** Weighted combination used for the decision boundary. */
  combined: number;
}

export interface NormalizedGroup {
  groupId: string;
  normalizedHostPattern: string;
  normalizedPathPattern: string;
  method: string;
  /** All HTTP methods observed on this host+path shape, across groups. */
  methodsOnPath: string[];
  members: Endpoint[];
  recommendedAction: Action;
  /** Strength of the evidence behind the recommendation, independent of score. */
  confidence: number;
  score: GroupScore;
  signals: Signal[];
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
    /** Bounded sample of source endpoints. See `membersOmitted` for the remainder. */
    rawEndpoints: Endpoint[];
    membersOmitted: number;
  };
  after: {
    normalizedHostPattern: string;
    normalizedPathPattern: string;
    method: string;
  };
  reason: string;
  evidence: string[];
  score: GroupScore;
  signals: Signal[];
  /**
   * Triage markers carried over from the group, e.g. `sensitive-not-api-shaped`
   * or `reclaimable-slot`. Distinct from `signals`, which are scoring
   * contributions: flags are what an operator filters on.
   */
  flags: string[];
  risk: string;
  requiresHumanReview: boolean;
  suggestedFollowUp: string;
  whyThisGroupingIsSafe: string;
  whyThisGroupingIsUseful: string;
  whyItMayBeWrong: string;
  confidenceScore: number;
  operatorNotes: string;
}

export interface BudgetReport {
  /** Operation cap for the zone plan, when known. */
  limit?: number;
  /** Operations already saved in the zone. */
  alreadySaved: number;
  /** Operations this run recommends saving. */
  proposedSaves: number;
  /** Remaining headroom after applying the proposals, when the limit is known. */
  remaining?: number;
  overBudget: boolean;
  notes: string[];
}

export interface ProposalBundle {
  generatedAt: string;
  /** Version of the scoring ruleset, so proposals are reproducible. */
  rulesetVersion: string;
  scope: {
    accountId?: string;
    zoneId?: string;
    /** Groups retained in this bundle after `maxGroups` truncation. */
    endpointCount: number;
    groupCount: number;
    /** Totals before truncation, so summary counts are never misleading. */
    analyzedEndpointCount: number;
    analyzedGroupCount: number;
    truncated: boolean;
  };
  proposals: Proposal[];
  summary: {
    saveCount: number;
    ignoreCount: number;
    manualReviewCount: number;
    /** Sum of observed hits. Endpoints without traffic data are excluded. */
    totalHits: number;
    /**
     * Summed request rate. The discovery API reports a rate rather than an
     * absolute count, so this is the only traffic figure available in API mode.
     */
    totalRequestsPerHour: number | null;
    /** Members whose traffic volume is unknown. */
    endpointsWithoutTrafficData: number;
  };
  /** Operations already saved/ignored in the zone, excluded from proposals. */
  alreadyDecided: {
    saved: number;
    ignored: number;
    /** Groups whose members disagree about their current state. */
    conflicting: string[];
  };
  budget: BudgetReport;
}

/**
 * Connection details for the live Cloudflare API. There is no mode selector:
 * the API Shield discovery endpoints are the only data source, so a
 * configuration that scored well can never have been scored on fields the API
 * does not actually return.
 */
export interface ConnectorConfig {
  apiToken?: string;
  accountId?: string;
  zoneId?: string;
  state?: string;
  /** Enrich endpoints with uploaded schema membership. Defaults to true. */
  useSchemas?: boolean;
  /**
   * Reports conditions the operator must know about but which are not fatal:
   * discarded malformed records, and a zone larger than the pagination cap. Both
   * mean the analysis ran on less than the full surface, which is exactly when a
   * missing endpoint matters most, so neither may be swallowed.
   */
  onWarning?: (message: string) => void;
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

/** A recorded operator decision, used to drive exports and future runs. */
export interface OperatorDecision {
  groupId: string;
  canonicalPattern: string;
  method: string;
  /** What the operator chose, which may differ from the recommendation. */
  decision: Action;
  recommendedAction: Action;
  decidedAt: string;
  note?: string;
}

export interface DecisionFile {
  zoneId?: string;
  rulesetVersion: string;
  decidedAt: string;
  decisions: OperatorDecision[];
}
