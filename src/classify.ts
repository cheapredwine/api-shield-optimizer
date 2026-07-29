import type { NormalizedGroup, Action } from './types.js';

const SAVE_PATH_PATTERNS = [
  /\/auth/i,
  /\/login/i,
  /\/oauth/i,
  /\/token/i,
  /\/account/i,
  /\/profile/i,
  /\/user/i,
  /\/payment/i,
  /\/checkout/i,
  /\/billing/i,
  /\/admin/i,
  /\/priv/i,
  /\/api\/v?\d+\/ai/i,
  /\/llm/i,
  /\/gpt/i,
  /\/generate/i,
  /\/embed/i,
  /\/predict/i,
];

const IGNORE_PATH_PATTERNS = [
  /(?:^|\/)health(?:\/|$)/i,
  /(?:^|\/)ping(?:\/|$)/i,
  /(?:^|\/)ready(?:\/|$)/i,
  /(?:^|\/)live(?:\/|$)/i,
  /(?:^|\/)debug(?:\/|$)/i,
  /(?:^|\/)test(?:\/|$)/i,
  /(?:^|\/)fixture(?:\/|$)/i,
  /\/internal\/probe/i,
  /\/_next\/static/i,
  /(?:^|\/)assets(?:\/|$)/i,
  /(?:^|\/)favicon(?:\.ico)?(?:$|\?)/i,
  /(?:^|\/)robots\.txt(?:$|\?)/i,
  /(?:^|\/)\.well-known(?:\/|$)/i,
  /(?:^|\/)sitemap\.xml(?:$|\?)/i,
  /(?:^|\/)cdn-cgi(?:\/|$)/i,
  /\.map(?:$|\?)/i,
  /(?:^|\/)static(?:\/|$)/i,
];

const SENSITIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function classifyGroup(group: NormalizedGroup): { action: Action; confidence: number; reasoning: string[]; flags: string[] } {
  const reasoning: string[] = [];
  const flags: string[] = [];

  // Collect signals
  const hasSavePattern = SAVE_PATH_PATTERNS.some((re) => re.test(group.normalizedPathPattern));
  const hasIgnorePattern = IGNORE_PATH_PATTERNS.some((re) => re.test(group.normalizedPathPattern));
  const totalHits = group.members.reduce((sum, m) => sum + m.hits, 0);
  const distinctHosts = new Set(group.members.map((m) => m.host)).size;
  const hasVariableHost = group.normalizedHostPattern.includes('{hostVar');
  const hasVariablePath = group.normalizedPathPattern.includes('{var');
  const method = group.method.toUpperCase();
  const sensitiveMethod = SENSITIVE_METHODS.has(method);
  const hasGraphql = /(?:^|\/)graphql(?:\/|$)/i.test(group.normalizedPathPattern);
  const hasApiVersion = /\/v\d+(?:\/|$)/i.test(group.normalizedPathPattern);
  const hasContractPath = /(?:^|\/)(openapi|swagger)(?:\/|$|\.)/i.test(group.normalizedPathPattern);
  const hasStaleObservation = group.members.every((m) => {
    const ts = Date.parse(m.lastSeenAt);
    if (Number.isNaN(ts)) return false;
    const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    return ageDays > 90;
  });
  const hasFreshObservation = group.members.some((m) => {
    const ts = Date.parse(m.lastSeenAt);
    if (Number.isNaN(ts)) return false;
    const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    return ageDays <= 14;
  });
  const hasManualSource = group.members.some((m) => m.source === 'manual');

  // Scoring
  let score = 0.5;

  if (hasSavePattern) {
    score += 0.35;
    reasoning.push('matches production-critical path pattern (auth/account/payment/admin/AI)');
  }

  if (hasIgnorePattern) {
    score -= 0.45;
    reasoning.push('matches debug/health/test noise pattern');
    flags.push('likely-noise');
  }

  if (totalHits > 10000) {
    score += 0.1;
    reasoning.push('high traffic volume');
  }

  if (totalHits < 10) {
    score -= 0.15;
    reasoning.push('very low traffic');
    flags.push('low-confidence');
  }

  if (sensitiveMethod) {
    score += 0.1;
    reasoning.push('sensitive HTTP method observed');
  }

  if (method === 'OPTIONS') {
    score -= 0.5;
    reasoning.push('CORS preflight method is usually low-value for protection policies');
    flags.push('likely-noise');
  }

  if (hasGraphql || hasApiVersion || hasContractPath) {
    score += 0.08;
    reasoning.push('API contract-oriented path detected (version/graphql/openapi/swagger)');
  }

  if (hasManualSource) {
    score += 0.08;
    reasoning.push('contains manually managed operations');
  }

  if (hasFreshObservation && totalHits > 1000) {
    score += 0.05;
    reasoning.push('recently active endpoint shape with meaningful traffic');
  }

  if (hasStaleObservation && totalHits < 100) {
    score -= 0.08;
    reasoning.push('stale endpoint shape with low observed traffic');
    flags.push('stale-observation');
  }

  if (hasVariableHost && distinctHosts > 1) {
    score -= 0.05;
    reasoning.push('host consolidation across multiple subdomains');
    flags.push('host-consolidation');
  }

  if (hasVariablePath) {
    score -= 0.05;
    reasoning.push('path variables detected — verify shape coverage');
    flags.push('path-variable');
  }

  if (group.members.some((m) => m.status === 'saved')) {
    score += 0.2;
    reasoning.push('some members already saved');
  }

  if (group.members.some((m) => m.status === 'ignored')) {
    score -= 0.2;
    reasoning.push('some members already ignored');
  }

  score = Math.max(0, Math.min(1, score));

  // Decision boundary
  let action: Action;
  let confidence: number;

  if (score >= 0.65) {
    action = 'save';
    confidence = Math.min(0.95, score);
  } else if (score <= 0.35) {
    action = 'ignore';
    confidence = Math.min(0.9, 1 - score);
  } else {
    action = 'manual_review';
    confidence = 0.5 + Math.abs(score - 0.5);
    flags.push('borderline-score');
    reasoning.push('score fell in ambiguous middle range');
  }

  return { action, confidence, reasoning, flags };
}
