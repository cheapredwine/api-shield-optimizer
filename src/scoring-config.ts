/**
 * Tunable scoring configuration.
 *
 * Everything the classifier uses lives here so a deployment can be retuned
 * without editing classifier logic. `rulesetVersion` is embedded in every
 * proposal bundle so results stay reproducible across releases.
 */

export interface PatternRule {
  id: string;
  /** Source form of the pattern, kept for serialisation and documentation. */
  pattern: string;
  weight: number;
  detail: string;
}

/**
 * A rule keyed to an exact operation label. Cloudflare's managed labels
 * (`cf-web-page`, `cf-api-endpoint`, `cf-log-in`, the `cf-risk-*` family) are
 * produced by Cloudflare's own classification and traffic analysis, so they are
 * treated as stronger evidence than any path heuristic. A label may appear on
 * both axes.
 */
export interface LabelRule {
  label: string;
  axis: 'api' | 'sensitivity';
  weight: number;
  detail: string;
}

export interface ScoringConfig {
  rulesetVersion: string;

  /** Starting value for each axis before signals are applied. */
  baseApiScore: number;
  baseSensitivityScore: number;

  /** Relative axis weights used to build the combined score. */
  apiWeight: number;
  sensitivityWeight: number;

  /** Below this API score the group is never proposed for saving. */
  apiFloor: number;
  /**
   * Sensitivity at or above which an endpoint below `apiFloor` is escalated to
   * manual review instead of being ignored outright.
   */
  sensitivityRescueThreshold: number;
  /**
   * Minimum api score for that escalation to apply. Below this there is
   * positive evidence the endpoint is *not* an API — a `cf-web-page` label, for
   * example — and a sensitivity signal should not drag it back into review.
   */
  sensitivityRescueApiFloor: number;
  /** At or above this API score the group is treated as certainly an API. */
  apiCertain: number;

  saveThreshold: number;
  ignoreThreshold: number;

  /** Traffic level treated as "high" for scoring purposes. */
  highTrafficHits: number;
  /** Traffic level treated as "negligible". */
  lowTrafficHits: number;

  /**
   * Rate equivalents, used when the API reports a rate rather than a total.
   * In API mode this is the only traffic evidence available.
   */
  highTrafficRatePerHour: number;
  lowTrafficRatePerHour: number;

  staleAfterDays: number;
  freshWithinDays: number;

  /** API score boost propagated from a confirmed API parent path. */
  siblingBoost: number;
  /** Minimum parent API score required to propagate a boost. */
  siblingSourceMin: number;

  apiPathPatterns: PatternRule[];
  noisePathPatterns: PatternRule[];
  staticAssetPatterns: PatternRule[];
  sensitivePathPatterns: PatternRule[];
  labelRules: LabelRule[];
}

/**
 * Path patterns are anchored to complete path segments. Unanchored substrings
 * caused false positives such as `/privacy-policy` matching `priv` and
 * `/user-guide` matching `user`.
 */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  rulesetVersion: '2.3.0',

  baseApiScore: 0.35,
  baseSensitivityScore: 0.2,

  apiWeight: 0.6,
  sensitivityWeight: 0.4,

  apiFloor: 0.4,
  // An endpoint with no signal either way sits at `baseApiScore` (0.35), while a
  // managed `cf-web-page` label pulls it to ~0.21. The 0.3 floor separates
  // "unknown" from "known not to be an API".
  sensitivityRescueThreshold: 0.5,
  sensitivityRescueApiFloor: 0.3,
  apiCertain: 0.8,

  saveThreshold: 0.62,
  ignoreThreshold: 0.38,

  highTrafficHits: 10000,
  lowTrafficHits: 10,

  highTrafficRatePerHour: 1000,
  lowTrafficRatePerHour: 1,

  staleAfterDays: 90,
  freshWithinDays: 14,

  siblingBoost: 0.12,
  siblingSourceMin: 0.7,

  apiPathPatterns: [
    { id: 'api-prefix', pattern: '(?:^|/)api(?:/|$)', weight: 0.2, detail: 'path contains an /api segment' },
    { id: 'api-version', pattern: '(?:^|/)v\\d+(?:/|$)', weight: 0.18, detail: 'versioned API path segment' },
    { id: 'graphql', pattern: '(?:^|/)graphql(?:/|$)', weight: 0.25, detail: 'GraphQL endpoint' },
    { id: 'grpc', pattern: '(?:^|/)grpc(?:/|$)', weight: 0.2, detail: 'gRPC endpoint' },
    { id: 'rest-suffix', pattern: '(?:^|/)rest(?:/|$)', weight: 0.15, detail: 'REST path segment' },
    {
      id: 'contract-doc',
      pattern: '(?:^|/)(openapi|swagger)(?:/|$|\\.)',
      weight: 0.15,
      detail: 'API contract document path',
    },
  ],

  noisePathPatterns: [
    { id: 'healthcheck', pattern: '(?:^|/)(health|healthz|ping|ready|readyz|live|livez)(?:/|$)', weight: -0.45, detail: 'health or liveness probe' },
    { id: 'debug', pattern: '(?:^|/)(debug|__debug|trace)(?:/|$)', weight: -0.4, detail: 'debug endpoint' },
    { id: 'test-fixture', pattern: '(?:^|/)(test|tests|fixture|fixtures|mock|mocks)(?:/|$)', weight: -0.35, detail: 'test or fixture path' },
    { id: 'internal-probe', pattern: '(?:^|/)internal/probe(?:/|$)', weight: -0.4, detail: 'internal probe path' },
    { id: 'cdn-cgi', pattern: '(?:^|/)cdn-cgi(?:/|$)', weight: -0.5, detail: 'Cloudflare internal path' },
    { id: 'well-known', pattern: '(?:^|/)\\.well-known(?:/|$)', weight: -0.35, detail: 'well-known metadata path' },
  ],

  staticAssetPatterns: [
    { id: 'next-static', pattern: '(?:^|/)_next/static(?:/|$)', weight: -0.5, detail: 'framework static bundle' },
    { id: 'static-dir', pattern: '(?:^|/)(static|assets|public|dist|build)(?:/|$)', weight: -0.4, detail: 'static asset directory' },
    {
      id: 'asset-extension',
      pattern: '\\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|pdf)$',
      weight: -0.5,
      detail: 'static asset file extension',
    },
    { id: 'crawler-file', pattern: '(?:^|/)(robots\\.txt|sitemap\\.xml|favicon\\.ico)$', weight: -0.5, detail: 'crawler metadata file' },
  ],

  sensitivePathPatterns: [
    {
      id: 'authn',
      pattern: '(?:^|/)(auth|authn|authorize|login|logout|signin|signup|register|oauth|oauth2|sso|saml|token|tokens|refresh|mfa|otp|2fa|password|passwords|reset)(?:/|$)',
      weight: 0.35,
      detail: 'authentication or credential path',
    },
    {
      id: 'identity',
      pattern: '(?:^|/)(account|accounts|profile|profiles|user|users|customer|customers|member|members|identity|me)(?:/|$)',
      weight: 0.22,
      detail: 'identity or personal-data path',
    },
    {
      id: 'financial',
      pattern: '(?:^|/)(payment|payments|pay|checkout|billing|invoice|invoices|subscription|subscriptions|transfer|transfers|transaction|transactions|refund|refunds|card|cards|wallet)(?:/|$)',
      weight: 0.3,
      detail: 'financial transaction path',
    },
    {
      id: 'business-data',
      pattern: '(?:^|/)(order|orders|cart|carts|document|documents|file|files|report|reports|export|exports|download|downloads|search)(?:/|$)',
      weight: 0.2,
      detail: 'business data access path',
    },
    {
      id: 'privileged',
      pattern: '(?:^|/)(admin|administrator|internal|private|superuser|root|manage|management|console)(?:/|$)',
      weight: 0.32,
      detail: 'administrative or privileged path',
    },
    {
      id: 'ai-inference',
      pattern: '(?:^|/)(ai|llm|gpt|chat|completions|embeddings|inference|predict|prediction|generate|generation|model|models|prompt|prompts)(?:/|$)',
      weight: 0.3,
      detail: 'AI or inference endpoint',
    },
    {
      id: 'secrets',
      pattern: '(?:^|/)(secret|secrets|credential|credentials|key|keys|apikey|api-key|certificate|certificates)(?:/|$)',
      weight: 0.35,
      detail: 'secret or credential management path',
    },
    {
      // A single GraphQL or gRPC endpoint fronts an entire schema, so path
      // inspection cannot differentiate operations. These are the highest-value
      // API Shield targets in most zones.
      id: 'schema-fronted',
      pattern: '(?:^|/)(graphql|graphiql|grpc)(?:/|$)',
      weight: 0.25,
      detail: 'single endpoint fronting an entire API schema',
    },
  ],

  /**
   * Cloudflare managed labels. Names and semantics come from the zone
   * `api_gateway/labels` endpoint, where every entry has `source: "managed"`.
   *
   * These carry more weight than path patterns because they reflect
   * Cloudflare's own response inspection and traffic analysis rather than a
   * guess from the URL. `cf-web-page` in particular is the authoritative
   * "this serves HTML" marker that no path heuristic can reliably reproduce.
   */
  labelRules: [
    // --- Is it an API? -----------------------------------------------------
    { label: 'cf-api-endpoint', axis: 'api', weight: 0.45, detail: 'labelled by Cloudflare as a machine-readable API endpoint' },
    { label: 'cf-mcp', axis: 'api', weight: 0.4, detail: 'implements the Model Context Protocol' },
    { label: 'cf-web-page', axis: 'api', weight: -0.5, detail: 'labelled by Cloudflare as serving HTML pages' },
    { label: 'cf-contains-ads', axis: 'api', weight: -0.25, detail: 'returns ad-supported content, indicating a rendered page' },
    { label: 'cf-content', axis: 'api', weight: -0.1, detail: 'serves unique page content' },

    // A learned schema or an API-shaped attack both imply an API surface.
    { label: 'cf-risk-missing-schema', axis: 'api', weight: 0.25, detail: 'a learned schema is available, implying a structured API' },
    { label: 'cf-risk-bola-enumeration', axis: 'api', weight: 0.2, detail: 'object enumeration attacks observed, which target APIs' },
    { label: 'cf-risk-bola-pollution', axis: 'api', weight: 0.2, detail: 'parameter pollution attacks observed, which target APIs' },

    // --- Is it worth protecting? ------------------------------------------
    { label: 'cf-add-payment', axis: 'sensitivity', weight: 0.45, detail: 'accepts payment card or bank details' },
    { label: 'cf-purchase', axis: 'sensitivity', weight: 0.4, detail: 'final step in a purchase flow' },
    { label: 'cf-log-in', axis: 'sensitivity', weight: 0.35, detail: 'accepts user credentials' },
    { label: 'cf-password-reset', axis: 'sensitivity', weight: 0.35, detail: 'password reset endpoint' },
    { label: 'cf-account-update', axis: 'sensitivity', weight: 0.3, detail: 'participates in account updates' },
    { label: 'cf-sign-up', axis: 'sensitivity', weight: 0.3, detail: 'final step in account creation' },
    { label: 'cf-check-value', axis: 'sensitivity', weight: 0.3, detail: 'checks stored or gift-card balances' },
    { label: 'cf-llm', axis: 'sensitivity', weight: 0.3, detail: 'backed by an LLM, making abuse expensive' },
    { label: 'cf-mcp', axis: 'sensitivity', weight: 0.3, detail: 'exposes tool access to agents' },
    { label: 'cf-add-cart', axis: 'sensitivity', weight: 0.2, detail: 'adds items to a cart' },
    { label: 'cf-add-post', axis: 'sensitivity', weight: 0.15, detail: 'posts user-generated content' },

    // Risk labels are added automatically by Cloudflare, so they are observed
    // facts about live traffic rather than inferences.
    { label: 'cf-risk-sensitive', axis: 'sensitivity', weight: 0.45, detail: 'WAF Sensitive Data Detection matched responses' },
    { label: 'cf-risk-bola-enumeration', axis: 'sensitivity', weight: 0.4, detail: 'object enumeration attacks detected' },
    { label: 'cf-risk-bola-pollution', axis: 'sensitivity', weight: 0.4, detail: 'parameter pollution attacks detected' },
    { label: 'cf-risk-missing-auth', axis: 'sensitivity', weight: 0.3, detail: 'all successful requests were unauthenticated' },
    { label: 'cf-risk-mixed-auth', axis: 'sensitivity', weight: 0.25, detail: 'some successful requests were unauthenticated' },
    { label: 'cf-risk-errors-anomaly', axis: 'sensitivity', weight: 0.1, detail: 'recent anomaly in error rate' },
    { label: 'cf-risk-latency-anomaly', axis: 'sensitivity', weight: 0.1, detail: 'recent anomaly in latency' },
    { label: 'cf-risk-size-anomaly', axis: 'sensitivity', weight: 0.1, detail: 'recent anomaly in response size' },

    // A feed is machine-readable but rarely worth an operation slot.
    { label: 'cf-rss-feed', axis: 'sensitivity', weight: -0.2, detail: 'RSS feed, machine-readable but low value to protect' },

    // Already saved and idle for 32 days. Not a reason to save, and a candidate
    // for reclaiming an operation slot.
    { label: 'cf-risk-zombie', axis: 'sensitivity', weight: -0.25, detail: 'saved but no traffic in the last 32 days' },
  ],
};

export interface CompiledPattern {
  id: string;
  regex: RegExp;
  weight: number;
  detail: string;
}

export interface CompiledScoringConfig extends ScoringConfig {
  compiled: {
    api: CompiledPattern[];
    noise: CompiledPattern[];
    staticAsset: CompiledPattern[];
    sensitive: CompiledPattern[];
  };
}

function compile(rules: PatternRule[]): CompiledPattern[] {
  return rules.map((rule) => ({
    id: rule.id,
    regex: new RegExp(rule.pattern, 'i'),
    weight: rule.weight,
    detail: rule.detail,
  }));
}

export function compileScoringConfig(config: ScoringConfig = DEFAULT_SCORING_CONFIG): CompiledScoringConfig {
  return {
    ...config,
    compiled: {
      api: compile(config.apiPathPatterns),
      noise: compile(config.noisePathPatterns),
      staticAsset: compile(config.staticAssetPatterns),
      sensitive: compile(config.sensitivePathPatterns),
    },
  };
}

/**
 * Merges a partial user override onto the defaults. Pattern arrays replace
 * wholesale rather than merging, so an operator can fully control them.
 */
export function resolveScoringConfig(overrides?: Partial<ScoringConfig>): CompiledScoringConfig {
  if (!overrides) return compileScoringConfig(DEFAULT_SCORING_CONFIG);
  return compileScoringConfig({ ...DEFAULT_SCORING_CONFIG, ...overrides });
}

let defaultCompiled: CompiledScoringConfig | null = null;

export function getDefaultCompiledConfig(): CompiledScoringConfig {
  if (!defaultCompiled) {
    defaultCompiled = compileScoringConfig(DEFAULT_SCORING_CONFIG);
  }
  return defaultCompiled;
}
