import type { Action, Endpoint, GroupScore, NormalizedGroup, Signal } from './types.js';
import { getDefaultCompiledConfig, type CompiledScoringConfig } from './scoring-config.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const API_CONTENT_TYPES = [/json/i, /grpc/i, /protobuf/i, /^application\/xml/i, /graphql/i];
const PAGE_CONTENT_TYPES = [/text\/html/i, /text\/plain/i];

export interface ClassificationResult {
  action: Action;
  confidence: number;
  score: GroupScore;
  signals: Signal[];
  reasoning: string[];
  flags: string[];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Total observed hits, ignoring members with no traffic data. */
export function totalKnownHits(members: Endpoint[]): number {
  return members.reduce((sum, m) => sum + (m.hits ?? 0), 0);
}

function membersWithTrafficData(members: Endpoint[]): Endpoint[] {
  return members.filter((m) => m.hits !== null && m.hits !== undefined);
}

/**
 * Observed request rate in requests per hour, or `null` when unknown.
 *
 * The discovery API reports traffic as a rate over an observation window
 * (`features.traffic_stats.requests` across `period_seconds`) and never as an
 * absolute total, so `hits` is always `null` in API mode. The traffic signals
 * and the budget ranking depend on this to see anything at all on live data.
 *
 * A rate is also the sounder basis for comparison: an absolute total favours
 * whichever endpoint happened to be observed for longer.
 */
export function requestsPerHour(endpoint: Endpoint): number | null {
  const requests = endpoint.features?.periodRequests;
  const seconds = endpoint.features?.periodSeconds;
  if (typeof requests !== 'number' || !Number.isFinite(requests)) return null;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return (requests * 3600) / seconds;
}

/** Summed request rate across members that report one, or `null` if none do. */
export function totalRequestsPerHour(members: Endpoint[]): number | null {
  let total = 0;
  let known = false;
  for (const member of members) {
    const rate = requestsPerHour(member);
    if (rate !== null) {
      total += rate;
      known = true;
    }
  }
  return known ? total : null;
}

/** Human-readable request rate for signal explanations. */
export function formatRate(perHour: number): string {
  if (perHour >= 1) return `${Math.round(perHour).toLocaleString()} req/hour`;
  const perDay = perHour * 24;
  if (perDay >= 1) return `${perDay.toFixed(1)} req/day`;
  return `${(perDay * 30).toFixed(2)} req/month`;
}

function ageInDays(iso: string): number | null {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return (Date.now() - ts) / (1000 * 60 * 60 * 24);
}

interface AggregatedEvidence {
  totalHits: number;
  /** True when either an absolute count or a request rate is available. */
  hasTrafficData: boolean;
  /** Summed requests per hour, or `null` when no member reports a rate. */
  ratePerHour: number | null;
  authIdTokens: number;
  hasFeatureData: boolean;
  dataPoints: number;
  contentTypes: string[];
  statusCodes: Record<string, number>;
  cacheHitRatio: number | null;
  inSchema: boolean;
  inSitemap: boolean;
  /** Union of operation labels across members, lowercased. */
  labels: Set<string>;
  freshest: number | null;
  oldest: number | null;
}

function aggregate(members: Endpoint[]): AggregatedEvidence {
  const withTraffic = membersWithTrafficData(members);
  const contentTypes = new Set<string>();
  const statusCodes: Record<string, number> = {};
  let authIdTokens = 0;
  let dataPoints = 0;
  let hasFeatureData = false;
  let cacheRatioSum = 0;
  let cacheRatioCount = 0;
  let freshest: number | null = null;
  let oldest: number | null = null;

  for (const member of members) {
    for (const ct of member.contentTypes ?? []) contentTypes.add(ct.toLowerCase());

    for (const [code, count] of Object.entries(member.statusCodes ?? {})) {
      statusCodes[code] = (statusCodes[code] ?? 0) + count;
    }

    if (member.features) {
      hasFeatureData = true;
      authIdTokens = Math.max(authIdTokens, member.features.authIdTokens ?? 0);
      dataPoints += member.features.dataPoints ?? 0;
    }

    if (typeof member.cacheHitRatio === 'number') {
      cacheRatioSum += member.cacheHitRatio;
      cacheRatioCount += 1;
    }

    const age = ageInDays(member.lastSeenAt);
    if (age !== null) {
      freshest = freshest === null ? age : Math.min(freshest, age);
      oldest = oldest === null ? age : Math.max(oldest, age);
    }
  }

  const ratePerHour = totalRequestsPerHour(members);

  return {
    totalHits: totalKnownHits(members),
    // A known rate is traffic data. Reporting "no traffic data" for every live
    // endpoint understated what we actually know.
    hasTrafficData: withTraffic.length > 0 || ratePerHour !== null,
    ratePerHour,
    authIdTokens,
    hasFeatureData,
    dataPoints,
    contentTypes: [...contentTypes],
    statusCodes,
    cacheHitRatio: cacheRatioCount > 0 ? cacheRatioSum / cacheRatioCount : null,
    inSchema: members.some((m) => m.inSchema === true),
    inSitemap: members.some((m) => m.inSitemap === true),
    labels: new Set(members.flatMap((m) => m.labels ?? []).map((l) => l.trim().toLowerCase())),
    freshest,
    oldest,
  };
}

function statusFraction(statusCodes: Record<string, number>, predicate: (code: number) => boolean): number | null {
  const entries = Object.entries(statusCodes);
  if (entries.length === 0) return null;
  let total = 0;
  let matched = 0;
  for (const [code, count] of entries) {
    const numeric = Number.parseInt(code, 10);
    if (!Number.isFinite(numeric)) continue;
    total += count;
    if (predicate(numeric)) matched += count;
  }
  return total === 0 ? null : matched / total;
}

/**
 * Scores a group on two independent axes:
 *
 *  - `api`         how confident we are the group is an API rather than a page
 *  - `sensitivity` how valuable the group is to protect
 *
 * A single keyword match never decides the outcome on its own: an endpoint must
 * clear the API floor before it is eligible to be saved.
 */
export function classifyGroup(
  group: NormalizedGroup,
  config: CompiledScoringConfig = getDefaultCompiledConfig(),
): ClassificationResult {
  const signals: Signal[] = [];
  const flags: string[] = [];
  const path = group.normalizedPathPattern;
  const method = group.method.toUpperCase();
  const evidence = aggregate(group.members);

  const add = (axis: Signal['axis'], id: string, weight: number, detail: string): void => {
    if (weight === 0) return;
    signals.push({ id, axis, weight, detail });
  };

  // ---------------------------------------------------------------- API axis

  if (evidence.inSchema) {
    add('api', 'in-uploaded-schema', 0.5, 'operation appears in an uploaded API schema');
  }

  // Managed labels reflect Cloudflare's own response inspection and traffic
  // analysis, so they outrank path guesses. Applied to both axes.
  for (const rule of config.labelRules) {
    if (evidence.labels.has(rule.label)) {
      add(rule.axis, `label-${rule.label}`, rule.weight, `${rule.detail} (${rule.label})`);
    }
  }

  if (evidence.labels.has('cf-web-page')) flags.push('labelled-web-page');
  if (evidence.labels.has('cf-api-endpoint')) flags.push('labelled-api');
  if (evidence.labels.has('cf-risk-zombie')) flags.push('zombie-operation');
  if ([...evidence.labels].some((l) => l.startsWith('cf-risk-'))) flags.push('cloudflare-risk-label');

  for (const rule of config.compiled.api) {
    if (rule.regex.test(path)) add('api', rule.id, rule.weight, rule.detail);
  }
  for (const rule of config.compiled.noise) {
    if (rule.regex.test(path)) {
      add('api', rule.id, rule.weight, rule.detail);
      flags.push('likely-noise');
    }
  }
  for (const rule of config.compiled.staticAsset) {
    if (rule.regex.test(path)) {
      add('api', rule.id, rule.weight, rule.detail);
      flags.push('static-asset');
    }
  }

  const hasApiContentType = evidence.contentTypes.some((ct) => API_CONTENT_TYPES.some((re) => re.test(ct)));
  const hasPageContentType = evidence.contentTypes.some((ct) => PAGE_CONTENT_TYPES.some((re) => re.test(ct)));
  if (hasApiContentType) {
    add('api', 'api-content-type', 0.35, `structured response content type (${evidence.contentTypes.join(', ')})`);
  }
  if (hasPageContentType && !hasApiContentType) {
    add('api', 'page-content-type', -0.45, 'response content type indicates a rendered web page');
  }

  if (evidence.inSitemap) {
    add('api', 'in-sitemap', -0.4, 'path is listed in the zone sitemap, indicating a web page');
  }

  if (evidence.cacheHitRatio !== null && evidence.cacheHitRatio >= 0.8) {
    add('api', 'high-cache-hit', -0.3, `served from cache ${(evidence.cacheHitRatio * 100).toFixed(0)}% of the time`);
  }

  // Path variables indicate a parameterised resource, which is evidence FOR an
  // API. The previous ruleset penalised them, which was backwards.
  if (path.includes('{var')) {
    add('api', 'path-variable', 0.12, 'parameterised path segment indicates a REST resource');
    flags.push('path-variable');
  }

  if (WRITE_METHODS.has(method)) {
    add('api', 'write-method', 0.12, `state-changing method ${method}`);
  }

  const writeMethodsOnPath = group.methodsOnPath.filter((m) => WRITE_METHODS.has(m));
  if (group.methodsOnPath.length >= 2 && writeMethodsOnPath.length >= 1) {
    add('api', 'rest-method-set', 0.12, `path serves multiple methods (${group.methodsOnPath.join(', ')})`);
  }

  if (evidence.authIdTokens > 0) {
    add('api', 'auth-tokens-observed', 0.15, `${evidence.authIdTokens} distinct authentication identifiers observed`);
  }

  const notFoundFraction = statusFraction(evidence.statusCodes, (c) => c === 404);
  if (notFoundFraction !== null && notFoundFraction >= 0.7) {
    add('api', 'mostly-not-found', -0.25, 'most responses are 404, indicating scanner noise');
    flags.push('likely-noise');
  }

  if (method === 'OPTIONS') {
    add('api', 'cors-preflight', -0.5, 'CORS preflight requests are not useful protection targets');
    flags.push('likely-noise');
  }

  // Authentication paths are themselves weak evidence of an API surface, which
  // lets endpoints like `POST /auth/login` clear the API floor without an
  // `/api` prefix.
  const sensitiveMatches = config.compiled.sensitive.filter((rule) => rule.regex.test(path));
  const hasAuthPath = sensitiveMatches.some((rule) => rule.id === 'authn');
  if (hasAuthPath) {
    add('api', 'auth-path-implies-api', 0.15, 'authentication endpoints are API surfaces even without an /api prefix');
  }

  // -------------------------------------------------------- Sensitivity axis

  for (const rule of sensitiveMatches) {
    add('sensitivity', rule.id, rule.weight, rule.detail);
  }

  if (evidence.authIdTokens > 0) {
    add('sensitivity', 'authenticated-traffic', 0.25, 'endpoint carries authenticated traffic');
  }

  const deniedFraction = statusFraction(evidence.statusCodes, (c) => c === 401 || c === 403);
  if (deniedFraction !== null && deniedFraction >= 0.1) {
    add('sensitivity', 'access-controlled', 0.2, 'endpoint returns authorization failures, indicating protected data');
  }

  if (WRITE_METHODS.has(method)) {
    add('sensitivity', 'write-method', 0.15, `state-changing method ${method}`);
  }

  if (evidence.totalHits >= config.highTrafficHits) {
    add('sensitivity', 'high-traffic', 0.1, `high traffic volume (${evidence.totalHits.toLocaleString()} hits)`);
  } else if (evidence.ratePerHour !== null && evidence.ratePerHour >= config.highTrafficRatePerHour) {
    add(
      'sensitivity',
      'high-traffic-rate',
      0.1,
      `high request rate (${formatRate(evidence.ratePerHour)})`,
    );
  }

  if (evidence.inSchema) {
    add('sensitivity', 'schema-documented', 0.15, 'operation is part of the documented API contract');
  }

  // --------------------------------------------------------------- Aggregate

  const apiScore = clamp01(
    config.baseApiScore + signals.filter((s) => s.axis === 'api').reduce((sum, s) => sum + s.weight, 0),
  );
  const sensitivityScore = clamp01(
    config.baseSensitivityScore + signals.filter((s) => s.axis === 'sensitivity').reduce((sum, s) => sum + s.weight, 0),
  );
  const combined = clamp01(config.apiWeight * apiScore + config.sensitivityWeight * sensitivityScore);

  const score: GroupScore = { api: apiScore, sensitivity: sensitivityScore, combined };

  // ---------------------------------------------------------------- Decision

  const isZombie = evidence.labels.has('cf-risk-zombie');

  let action: Action;
  const reasoning: string[] = [];

  // The `apiFloor` check below is a hard short-circuit, so a sensitive endpoint
  // that does not look API-shaped — an unlabelled `POST /checkout/session/{id}`
  // scores api 0.35 against a 0.40 floor — would be dropped without its
  // sensitivity ever being weighed. Silently discarding a financial endpoint is
  // the worst failure direction for a security tool, so escalate to a human
  // rather than decide.
  const sensitiveButNotApiShaped =
    apiScore < config.apiFloor &&
    apiScore >= config.sensitivityRescueApiFloor &&
    sensitivityScore >= config.sensitivityRescueThreshold;

  if (sensitiveButNotApiShaped) {
    action = 'manual_review';
    flags.push('sensitive-not-api-shaped');
    reasoning.push(
      `API confidence ${apiScore.toFixed(2)} is below the ${config.apiFloor} floor, but sensitivity ` +
        `${sensitivityScore.toFixed(2)} is too high to ignore without a human decision`,
    );
  } else if (apiScore < config.apiFloor) {
    action = 'ignore';
    reasoning.push(`API confidence ${apiScore.toFixed(2)} is below the ${config.apiFloor} floor — not an API surface`);
  } else if (isZombie) {
    // An already-saved operation with no traffic for 32 days is definitionally
    // an API, so the `apiCertain` shortcut would save it unconditionally. But it
    // is already saved, and the useful question is whether to reclaim its
    // operation slot. That is a judgement call, not an automatic save.
    action = 'manual_review';
    flags.push('reclaimable-slot');
    reasoning.push(
      'already saved but idle for 32 days (cf-risk-zombie) — review whether to reclaim the operation slot',
    );
  } else if (apiScore >= config.apiCertain) {
    action = 'save';
    reasoning.push(`API confidence ${apiScore.toFixed(2)} is conclusive`);
  } else if (combined >= config.saveThreshold) {
    action = 'save';
    reasoning.push(
      `combined score ${combined.toFixed(2)} clears the ${config.saveThreshold} save threshold ` +
        `(api ${apiScore.toFixed(2)}, sensitivity ${sensitivityScore.toFixed(2)})`,
    );
  } else if (combined <= config.ignoreThreshold) {
    action = 'ignore';
    reasoning.push(`combined score ${combined.toFixed(2)} is at or below the ${config.ignoreThreshold} ignore threshold`);
  } else {
    action = 'manual_review';
    flags.push('borderline-score');
    reasoning.push(
      `combined score ${combined.toFixed(2)} falls between the ignore and save thresholds ` +
        `(api ${apiScore.toFixed(2)}, sensitivity ${sensitivityScore.toFixed(2)})`,
    );
  }

  for (const signal of signals) {
    reasoning.push(`${signal.axis}: ${signal.detail} (${signal.weight >= 0 ? '+' : ''}${signal.weight.toFixed(2)})`);
  }

  // --------------------------------------------------------------- Confidence

  const confidence = computeConfidence(group, evidence, config, flags);

  return { action, confidence, score, signals, reasoning, flags: [...new Set(flags)] };
}

/**
 * Evidence strength, computed independently of the score.
 *
 * This answers "how much do we know about this group?", not "how sure are we
 * it should be saved?". Conflating the two made borderline scores look
 * confident.
 */
function computeConfidence(
  group: NormalizedGroup,
  evidence: AggregatedEvidence,
  config: CompiledScoringConfig,
  flags: string[],
): number {
  let confidence = 0.3;

  if (evidence.hasTrafficData) {
    // Log-scaled so an order-of-magnitude increase adds a comparable amount.
    // Absolute counts are preferred; a rate is used when that is all we have.
    const magnitude =
      evidence.totalHits > 0
        ? evidence.totalHits
        : evidence.ratePerHour !== null
          ? evidence.ratePerHour
          : 0;
    confidence += Math.min(0.25, Math.log10(Math.max(1, magnitude)) / 24);

    const negligible =
      evidence.totalHits > 0
        ? evidence.totalHits < config.lowTrafficHits
        : evidence.ratePerHour !== null && evidence.ratePerHour < config.lowTrafficRatePerHour;

    if (negligible) {
      confidence -= 0.1;
      flags.push('low-traffic');
    }
  } else {
    flags.push('no-traffic-data');
  }

  if (group.members.length > 1) {
    confidence += Math.min(0.1, Math.log10(group.members.length) / 20);
  }

  if (evidence.hasFeatureData) {
    confidence += 0.12;
    if (evidence.dataPoints >= 1000) confidence += 0.03;
  } else {
    flags.push('no-feature-data');
  }

  if (evidence.contentTypes.length > 0) confidence += 0.08;
  if (evidence.inSchema) confidence += 0.15;

  // A Cloudflare-managed label is direct evidence about the endpoint, not an
  // inference from its URL, so it raises confidence regardless of direction.
  const hasClassifyingLabel =
    evidence.labels.has('cf-web-page') || evidence.labels.has('cf-api-endpoint') || evidence.labels.has('cf-mcp');
  if (hasClassifyingLabel) confidence += 0.15;

  // Risk labels are added automatically from observed traffic.
  const riskLabelCount = [...evidence.labels].filter((l) => l.startsWith('cf-risk-')).length;
  if (riskLabelCount > 0) confidence += Math.min(0.1, 0.04 * riskLabelCount);

  if (evidence.freshest !== null && evidence.freshest <= config.freshWithinDays) {
    confidence += 0.08;
  }

  if (evidence.oldest !== null && evidence.freshest !== null && evidence.freshest > config.staleAfterDays) {
    confidence -= 0.1;
    flags.push('stale-observation');
  }

  if (group.normalizedHostPattern.includes('{hostVar')) {
    confidence -= 0.05;
    flags.push('host-consolidation');
  }

  return Math.max(0.05, Math.min(0.95, confidence));
}

/**
 * Propagates API confidence down the path tree. If `/v1/orders` is confidently
 * an API, `/v1/orders/{var1}` almost certainly is too. Runs one pass so a boost
 * cannot cascade indefinitely.
 */
export function applySiblingPropagation(
  groups: NormalizedGroup[],
  config: CompiledScoringConfig = getDefaultCompiledConfig(),
): NormalizedGroup[] {
  const confidentPrefixes = new Set<string>();
  for (const group of groups) {
    if (group.score.api >= config.siblingSourceMin) {
      confidentPrefixes.add(`${group.normalizedHostPattern}${group.normalizedPathPattern}`);
    }
  }

  if (confidentPrefixes.size === 0) return groups;

  return groups.map((group) => {
    if (group.score.api >= config.siblingSourceMin) return group;

    const full = `${group.normalizedHostPattern}${group.normalizedPathPattern}`;
    const segments = group.normalizedPathPattern.split('/').filter(Boolean);

    let matchedAncestor: string | null = null;
    for (let i = segments.length - 1; i >= 1; i--) {
      const ancestor = `${group.normalizedHostPattern}/${segments.slice(0, i).join('/')}`;
      if (ancestor !== full && confidentPrefixes.has(ancestor)) {
        matchedAncestor = ancestor;
        break;
      }
    }

    if (!matchedAncestor) return group;

    const apiScore = clamp01(group.score.api + config.siblingBoost);
    const combined = clamp01(config.apiWeight * apiScore + config.sensitivityWeight * group.score.sensitivity);
    const signals: Signal[] = [
      ...group.signals,
      {
        id: 'sibling-api-evidence',
        axis: 'api',
        weight: config.siblingBoost,
        detail: `parent path ${matchedAncestor} is a confirmed API surface`,
      },
    ];

    const score: GroupScore = { api: apiScore, sensitivity: group.score.sensitivity, combined };
    // Preserve the zombie veto; a sibling boost must not turn a reclaimable
    // slot into an automatic save.
    const action = redecide(score, config, group.flags.includes('zombie-operation'));

    return {
      ...group,
      score,
      signals,
      recommendedAction: action,
      reasoning: [
        ...group.reasoning,
        `api: parent path ${matchedAncestor} is a confirmed API surface (+${config.siblingBoost.toFixed(2)})`,
        ...(action !== group.recommendedAction
          ? [`recommendation changed from ${group.recommendedAction} to ${action} after sibling propagation`]
          : []),
      ],
      flags: action === 'manual_review' ? group.flags : group.flags.filter((f) => f !== 'borderline-score'),
    };
  });
}

function redecide(score: GroupScore, config: CompiledScoringConfig, isZombie = false): Action {
  // Mirrors the escalation in `classifyGroup`. Sibling propagation only ever
  // raises the api score, but it re-runs the whole decision, so omitting this
  // would let a rescued endpoint fall back to `ignore`.
  if (
    score.api < config.apiFloor &&
    score.api >= config.sensitivityRescueApiFloor &&
    score.sensitivity >= config.sensitivityRescueThreshold
  ) {
    return 'manual_review';
  }
  if (score.api < config.apiFloor) return 'ignore';
  if (isZombie) return 'manual_review';
  if (score.api >= config.apiCertain) return 'save';
  if (score.combined >= config.saveThreshold) return 'save';
  if (score.combined <= config.ignoreThreshold) return 'ignore';
  return 'manual_review';
}
