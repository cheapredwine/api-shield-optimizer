export * from './types.js';
export { ShieldOptimizerAgent, rankValue } from './agent.js';
export { createConnector, CloudflareApiConnector, SnapshotConnector } from './connectors/index.js';
export {
  groupEndpoints,
  normalizePath,
  normalizeHost,
  isVariableSegment,
  isHighCardinalitySegment,
  registrableDomainLabelCount,
  canonicalizeHost,
  pathVarIndex,
  hostVarIndex,
} from './normalize.js';
export { classifyGroup, applySiblingPropagation, totalKnownHits } from './classify.js';
export {
  DEFAULT_SCORING_CONFIG,
  compileScoringConfig,
  resolveScoringConfig,
  getDefaultCompiledConfig,
} from './scoring-config.js';
export type { ScoringConfig, CompiledScoringConfig, PatternRule } from './scoring-config.js';
export { generateProposal, generateBundle, MAX_EMBEDDED_MEMBERS } from './proposal.js';
export { formatBundleAsText } from './format.js';
export { buildApplyPayload, bundleToCsv, buildDecisionFile } from './export.js';
export type { ApplyPayload, RequestPreview, OperationIdentity } from './export.js';
export { runInteractiveReview } from './review.js';
export { LineReader, askOnce } from './prompt.js';
export { saveZoneIdToConfig } from './config.js';
export type { SaveZoneResult } from './config.js';
export type { ReviewOptions, ReviewResult } from './review.js';
export {
  ValidationError,
  assertCloudflareId,
  assertOptionalCloudflareId,
  isCloudflareId,
  parseDiscoveryStates,
  parseBoundedInt,
  ALLOWED_DISCOVERY_STATES,
} from './validate.js';
