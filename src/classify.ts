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
  /\/health/i,
  /\/ping/i,
  /\/ready/i,
  /\/live/i,
  /\/debug/i,
  /\/test/i,
  /\/fixture/i,
  /\/internal\/probe/i,
  /\/_next\/static/i,
  /\/assets\//i,
  /\/favicon/i,
  /\/robots\.txt/i,
  /\/\.well-known/i,
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
  const methods = new Set(group.members.map((m) => m.method));
  const mixedMethods = methods.size > 1;
  const sensitiveMethod = [...methods].some((m) => SENSITIVE_METHODS.has(m));

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

  if (mixedMethods) {
    score -= 0.1;
    reasoning.push('mixed HTTP methods on same path shape');
    flags.push('method-ambiguity');
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
