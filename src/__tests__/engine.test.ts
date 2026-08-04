import { describe, it, expect } from 'vitest';
import {
  isVariableSegment,
  isHighCardinalitySegment,
  normalizePath,
  normalizeHost,
  groupEndpoints,
  inferSiblingVariables,
} from '../normalize.js';
import {
  classifyGroup,
  applySiblingPropagation,
  requestsPerHour,
  totalRequestsPerHour,
  formatRate,
  computeTrafficThresholds,
} from '../classify.js';
import { rankValue, ShieldOptimizerAgent } from '../agent.js';
import {
  resolveScoringConfig,
  validateScoringOverrides,
  getDefaultCompiledConfig,
  DEFAULT_SCORING_CONFIG,
} from '../scoring-config.js';
import { ValidationError } from '../validate.js';
import { generateProposal, generateBundle } from '../proposal.js';
import { bundleToCsv, buildApplyPayload } from '../export.js';
import { formatBundleAsText } from '../format.js';
import type { Endpoint, NormalizedGroup, ProposalBundle } from '../types.js';
import type { AgentOptions } from '../agent.js';

function makeEp(partial: Partial<Endpoint> & { path: string; host: string }): Endpoint {
  return {
    id: 'x',
    accountId: 'a',
    zoneId: 'z',
    method: 'GET',
    source: 'machinelearning',
    hits: 100,
    lastSeenAt: new Date().toISOString(),
    rawReference: {},
    ...partial,
  } as Endpoint;
}

function makeGroup(partial: Partial<NormalizedGroup> & { normalizedPathPattern: string }): NormalizedGroup {
  const method = partial.method ?? 'GET';
  // A real group's host pattern is derived from its members, so a fixture that
  // sets member hosts must not be scored against an unrelated default host.
  const host = partial.normalizedHostPattern ?? partial.members?.[0]?.host ?? 'api.example.com';
  return {
    groupId: 'g1',
    recommendedAction: 'manual_review',
    confidence: 0.5,
    score: { api: 0, sensitivity: 0, combined: 0 },
    signals: [],
    reasoning: [],
    flags: [],
    ...partial,
    normalizedHostPattern: host,
    method,
    methodsOnPath: partial.methodsOnPath ?? [method],
    members: partial.members ?? [makeEp({ path: partial.normalizedPathPattern, host, method })],
  };
}

/** Runs the classifier and folds the result back onto the group. */
function classify(group: NormalizedGroup): NormalizedGroup {
  const c = classifyGroup(group);
  return {
    ...group,
    recommendedAction: c.action,
    confidence: c.confidence,
    score: c.score,
    signals: c.signals,
    reasoning: c.reasoning,
    flags: c.flags,
  };
}

describe('isVariableSegment', () => {
  it('detects numeric IDs', () => {
    expect(isVariableSegment('12345')).toBe(true);
  });
  it('detects UUIDs', () => {
    expect(isVariableSegment('ab12cd34-ef56-7890-ab12-cd34ef567890')).toBe(true);
  });
  it('detects dates', () => {
    expect(isVariableSegment('2026-07-28')).toBe(true);
  });
  it('detects Mongo ObjectId', () => {
    expect(isVariableSegment('507f1f77bcf86cd799439011')).toBe(true);
  });
  it('rejects plain words', () => {
    expect(isVariableSegment('users')).toBe(false);
  });
  it('rejects allowlisted static nouns', () => {
    expect(isVariableSegment('customers')).toBe(false);
  });
});

describe('isHighCardinalitySegment', () => {
  // The previous heuristic flagged readable product slugs as opaque IDs,
  // merging distinct pages into one bogus pattern.
  it.each(['iphone13promax', 'windows11pro', 'top10bestlaptops', 'office365business', 'html5videoplayer'])(
    'does not treat readable slug %s as a variable',
    (slug) => {
      expect(isHighCardinalitySegment(slug)).toBe(false);
      expect(isVariableSegment(slug)).toBe(false);
    },
  );

  it.each([
    'eJ4xD5L_92QaA11dwM7A9-bNxQ1wYhK2',
    'aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ',
    '20240115-88372615523',
  ])('treats opaque token %s as a variable', (token) => {
    expect(isHighCardinalitySegment(token)).toBe(true);
  });

  it('does not treat hyphenated word slugs as variables', () => {
    expect(isHighCardinalitySegment('how-to-choose-the-right-plan')).toBe(false);
  });
});

describe('normalizePath', () => {
  it('collapses numeric IDs', () => {
    const r = normalizePath('/api/v1/users/123');
    expect(r.pattern).toBe('/api/v1/users/{var1}');
    expect(r.varCount).toBe(1);
  });
  it('collapses UUIDs', () => {
    expect(normalizePath('/orders/ab12cd34-ef56-7890-ab12-cd34ef567890').pattern).toBe('/orders/{var1}');
  });
  it('preserves static paths', () => {
    const r = normalizePath('/health');
    expect(r.pattern).toBe('/health');
    expect(r.varCount).toBe(0);
  });
  it('collapses high-cardinality random-like segment', () => {
    const r = normalizePath('/files/eJ4xD5L_92QaA11dwM7A9-bNxQ1wYhK2');
    expect(r.pattern).toBe('/files/{var1}');
    expect(r.rules).toContain('high-cardinality-segment');
  });
  it('preserves readable slugs', () => {
    expect(normalizePath('/blog/iphone13promax-review').pattern).toBe('/blog/iphone13promax-review');
  });
});

describe('normalizeHost', () => {
  it('returns single host unchanged', () => {
    const r = normalizeHost(['api.example.com']);
    expect(r.pattern).toBe('api.example.com');
    expect(r.canCollapse).toBe(true);
  });

  it('collapses single differing subdomain label', () => {
    const r = normalizeHost(['us-api.example.com', 'de-api.example.com', 'fr-api.example.com']);
    expect(r.pattern).toBe('{hostVar1}.example.com');
    expect(r.canCollapse).toBe(true);
  });

  it('refuses multi-label differences', () => {
    const r = normalizeHost(['a.b.example.com', 'c.d.example.com']);
    expect(r.canCollapse).toBe(false);
  });

  it('refuses variable-depth subdomains', () => {
    const r = normalizeHost(['api.example.com', 'foo.bar.example.com']);
    expect(r.canCollapse).toBe(false);
  });

  // Collapsing any label of the registrable domain would merge unrelated
  // organisations into a single pattern.
  it('refuses to variabilise the public suffix', () => {
    const r = normalizeHost(['api.example.com', 'api.example.org']);
    expect(r.canCollapse).toBe(false);
    expect(r.pattern).not.toContain('hostVar');
  });

  it('refuses to variabilise the apex label', () => {
    const r = normalizeHost(['api.acme.com', 'api.evilcorp.com']);
    expect(r.canCollapse).toBe(false);
    expect(r.pattern).not.toContain('hostVar');
  });

  it('refuses to variabilise a label inside a multi-label public suffix', () => {
    const r = normalizeHost(['api.shop.co.uk', 'api.store.co.uk']);
    expect(r.canCollapse).toBe(false);
  });

  it('still collapses a deeper subdomain above a multi-label suffix', () => {
    const r = normalizeHost(['us.api.shop.co.uk', 'de.api.shop.co.uk']);
    expect(r.canCollapse).toBe(true);
    expect(r.pattern).toBe('{hostVar1}.api.shop.co.uk');
  });

  // Regression: `com.co` (and any other `<generic>.<cc>` ccTLD suffix not on
  // the explicit list) must still protect its two labels. Two unrelated
  // organisations under the same suffix must never collapse into one pattern.
  it.each([
    ['com.co', 'api.acme.com.co', 'api.evilcorp.com.co'],
    ['com.vn', 'api.acme.com.vn', 'api.evilcorp.com.vn'],
    ['com.ph', 'api.acme.com.ph', 'api.evilcorp.com.ph'],
  ])('refuses to variabilise the apex label under the unlisted suffix %s', (_suffix, a, b) => {
    const r = normalizeHost([a, b]);
    expect(r.canCollapse).toBe(false);
    expect(r.pattern).not.toContain('hostVar');
  });

  it('still collapses a deeper subdomain above an unlisted generic ccTLD suffix', () => {
    const r = normalizeHost(['us.api.acme.com.co', 'de.api.acme.com.co']);
    expect(r.canCollapse).toBe(true);
    expect(r.pattern).toBe('{hostVar1}.api.acme.com.co');
  });
});

describe('groupEndpoints', () => {
  it('groups identical normalized paths', () => {
    const groups = groupEndpoints([
      makeEp({ id: '1', path: '/users/123', host: 'api.example.com' }),
      makeEp({ id: '2', path: '/users/456', host: 'api.example.com' }),
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].members.length).toBe(2);
    expect(groups[0].normalizedPathPattern).toBe('/users/{var1}');
  });

  it('separates different methods but records the full method set', () => {
    const groups = groupEndpoints([
      makeEp({ id: '1', path: '/users', method: 'GET', host: 'api.example.com' }),
      makeEp({ id: '2', path: '/users', method: 'POST', host: 'api.example.com' }),
    ]);
    expect(groups.length).toBe(2);
    for (const group of groups) {
      expect(group.methodsOnPath).toEqual(['GET', 'POST']);
    }
  });

  it('splits hosts that cannot share one safe pattern', () => {
    const groups = groupEndpoints([
      makeEp({ id: '1', path: '/v1/a', host: 'api.acme.com' }),
      makeEp({ id: '2', path: '/v1/a', host: 'api.evilcorp.com' }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.normalizedHostPattern).sort()).toEqual(['api.acme.com', 'api.evilcorp.com']);
  });

  it('produces identical output regardless of input order', () => {
    const endpoints = [
      makeEp({ id: '1', path: '/v1/a', host: 'us.api.example.com' }),
      makeEp({ id: '2', path: '/v1/a', host: 'de.api.example.com' }),
      makeEp({ id: '3', path: '/v1/b', host: 'api.other.com' }),
    ];
    const forward = groupEndpoints(endpoints);
    const reverse = groupEndpoints([...endpoints].reverse());

    const shape = (groups: NormalizedGroup[]) =>
      groups.map((g) => `${g.groupId} ${g.method} ${g.normalizedHostPattern}${g.normalizedPathPattern}`);

    expect(shape(forward)).toEqual(shape(reverse));
  });

  it('does not corrupt paths containing a pipe character', () => {
    const groups = groupEndpoints([makeEp({ id: '1', path: '/search/a||b', host: 'api.example.com' })]);
    expect(groups.length).toBe(1);
    expect(groups[0].normalizedPathPattern).toBe('/search/a||b');
    expect(groups[0].normalizedHostPattern).toBe('api.example.com');
  });
});

describe('classifyGroup — true positives', () => {
  it('saves authentication endpoints even without an /api prefix', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/auth/login',
        method: 'POST',
        members: [makeEp({ path: '/auth/login', method: 'POST', hits: 25000, host: 'api.example.com' })],
      }),
    );
    expect(c.action).toBe('save');
  });

  it('saves versioned business APIs', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/api/v1/orders/{var1}',
        method: 'POST',
        members: [makeEp({ path: '/api/v1/orders/9', method: 'POST', hits: 900, host: 'api.example.com' })],
      }),
    );
    expect(c.action).toBe('save');
  });

  it('saves financial write endpoints', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/api/v1/transfers',
        method: 'POST',
        members: [makeEp({ path: '/api/v1/transfers', method: 'POST', hits: 400, host: 'api.example.com' })],
      }),
    );
    expect(c.action).toBe('save');
  });

  it('saves GraphQL endpoints', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/graphql',
        method: 'POST',
        members: [makeEp({ path: '/graphql', method: 'POST', hits: 500000, host: 'api.example.com' })],
      }),
    );
    expect(c.action).toBe('save');
  });

  it('treats uploaded schema membership as decisive', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/internal-thing',
        members: [makeEp({ path: '/internal-thing', hits: 5, host: 'api.example.com', inSchema: true })],
      }),
    );
    expect(c.action).toBe('save');
    expect(c.signals.map((s) => s.id)).toContain('in-uploaded-schema');
  });
});

describe('classifyGroup — false positives that used to occur', () => {
  // Every one of these was previously classified `save` because the keyword
  // patterns were unanchored substrings.
  it.each([
    ['/privacy-policy', 'GET', 3],
    ['/blog/generate-more-leads', 'GET', 5],
    ['/user-guide', 'GET', 20000],
    ['/embed/video', 'GET', 50000],
    ['/testimonials', 'GET', 200],
  ])('does not save %s', (path, method, hits) => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: path,
        method,
        members: [makeEp({ path, method, hits, host: 'www.example.com' })],
      }),
    );
    expect(c.action).not.toBe('save');
  });

  it('ignores health probes regardless of traffic volume', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/health',
        members: [makeEp({ path: '/health', hits: 900000, host: 'api.example.com' })],
      }),
    );
    expect(c.action).toBe('ignore');
    expect(c.flags).toContain('likely-noise');
  });

  it('ignores static assets', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/assets/app.js',
        members: [makeEp({ path: '/assets/app.js', hits: 1000000, host: 'www.example.com' })],
      }),
    );
    expect(c.action).toBe('ignore');
    expect(c.flags).toContain('static-asset');
  });

  it('downranks OPTIONS preflight operations', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/v1/users',
        method: 'OPTIONS',
        members: [makeEp({ path: '/v1/users', method: 'OPTIONS', hits: 50, host: 'api.example.com' })],
      }),
    );
    expect(c.action).toBe('ignore');
    expect(c.flags).toContain('likely-noise');
  });

  // The discovery API returns no response metadata, so a rendered page is
  // recognised from its managed label instead.
  it('uses a managed web-page label to reject a rendered page on an API-looking path', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/api/docs',
        members: [
          makeEp({ path: '/api/docs', hits: 5000, host: 'www.example.com', labels: ['cf-web-page'] }),
        ],
      }),
    );
    expect(c.signals.map((s) => s.id)).toContain('label-cf-web-page');
    expect(c.action).not.toBe('save');
  });
});

describe('classifyGroup — decision ladder rule 7 (ignore via combined threshold)', () => {
  // Regression: every other `ignore` case in this file reaches it via rule 2
  // (`apiScore < apiFloor`), which is a hard short-circuit before `combined`
  // is even consulted. Rule 7 — `ignore` because `combined <= ignoreThreshold`
  // while `apiScore` has already cleared both `apiFloor` and the evidence gate
  // — was reachable but had no test exercising it at all.
  it('ignores an API-shaped endpoint whose combined score is still too low to save', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/rest/foo',
        members: [makeEp({ path: '/rest/foo', hits: 0, host: 'example.com' })],
      }),
    );

    // Confirms this really is exercising rule 7, not rule 2: the api score
    // must clear the floor and the evidence gate must be satisfied.
    expect(c.score.api).toBeGreaterThanOrEqual(0.4);
    expect(c.flags).not.toContain('no-api-evidence');
    expect(c.score.combined).toBeLessThanOrEqual(0.38);
    expect(c.action).toBe('ignore');
    expect(c.reasoning[0]).toMatch(/is at or below the 0\.38 ignore threshold/);
  });
});

describe('classifyGroup — signal handling', () => {
  it('treats path variables as evidence FOR an API', () => {
    const c = classifyGroup(makeGroup({ normalizedPathPattern: '/things/{var1}' }));
    const signal = c.signals.find((s) => s.id === 'path-variable');
    expect(signal).toBeDefined();
    expect(signal!.weight).toBeGreaterThan(0);
  });

  it('boosts endpoints with observed authentication identifiers', () => {
    const withAuth = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/v2/records',
        members: [makeEp({ path: '/v2/records', hits: 500, host: 'api.example.com', features: { authIdTokens: 42 } })],
      }),
    );
    const withoutAuth = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/v2/records',
        members: [makeEp({ path: '/v2/records', hits: 500, host: 'api.example.com' })],
      }),
    );
    expect(withAuth.score.combined).toBeGreaterThan(withoutAuth.score.combined);
  });

  it('rewards REST method sets on the same path', () => {
    const single = classifyGroup(makeGroup({ normalizedPathPattern: '/v1/items', methodsOnPath: ['GET'] }));
    const multi = classifyGroup(
      makeGroup({ normalizedPathPattern: '/v1/items', methodsOnPath: ['GET', 'POST', 'DELETE'] }),
    );
    expect(multi.score.api).toBeGreaterThan(single.score.api);
  });

  it('never lets a single keyword hit alone force a save', () => {
    // Sensitive keyword on a path with no other API evidence.
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/admin',
        members: [makeEp({ path: '/admin', hits: 4, host: 'www.example.com' })],
      }),
    );
    expect(c.action).not.toBe('save');
  });
});

describe('classifyGroup — confidence', () => {
  it('is independent of the decision score', () => {
    const sparse = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/api/v1/payments',
        method: 'POST',
        members: [makeEp({ path: '/api/v1/payments', method: 'POST', hits: 3, host: 'api.example.com' })],
      }),
    );
    const rich = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/api/v1/payments',
        method: 'POST',
        members: [
          makeEp({
            path: '/api/v1/payments',
            method: 'POST',
            hits: 4_000_000,
            host: 'api.example.com',
            features: { authIdTokens: 90, dataPoints: 50000 },
            inSchema: true,
          }),
        ],
      }),
    );

    expect(rich.confidence).toBeGreaterThan(sparse.confidence);
    expect(sparse.flags).toContain('low-traffic');
    expect(sparse.flags).toContain('no-feature-data');
  });

  it('flags members with no traffic data instead of treating them as zero', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/api/v1/payments',
        method: 'POST',
        members: [makeEp({ path: '/api/v1/payments', method: 'POST', hits: null, host: 'api.example.com', status: 'saved' })],
      }),
    );
    expect(c.flags).toContain('no-traffic-data');
    expect(c.flags).not.toContain('low-traffic');
  });

  it('flags stale observations', () => {
    const stale = new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString();
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/v1/legacy',
        members: [makeEp({ path: '/v1/legacy', hits: 5, host: 'api.example.com', lastSeenAt: stale })],
      }),
    );
    expect(c.flags).toContain('stale-observation');
  });

  it('survives an unparsable timestamp on one member', () => {
    const stale = new Date(Date.now() - 1000 * 60 * 60 * 24 * 200).toISOString();
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/v1/legacy',
        members: [
          makeEp({ path: '/v1/legacy', hits: 2, host: 'api.example.com', lastSeenAt: stale }),
          makeEp({ path: '/v1/legacy', hits: 2, host: 'api.example.com', lastSeenAt: 'not-a-date' }),
        ],
      }),
    );
    expect(c.flags).toContain('stale-observation');
  });
});

describe('applySiblingPropagation', () => {
  it('promotes a child path when its parent is a confirmed API', () => {
    // The parent is confirmed via schema membership on a host with no /api
    // prefix, so the child has no independent API evidence of its own.
    const parent = classify(
      makeGroup({
        groupId: 'g-parent',
        normalizedHostPattern: 'www.example.com',
        normalizedPathPattern: '/checkout/session',
        method: 'POST',
        members: [
          makeEp({ path: '/checkout/session', method: 'POST', hits: 90000, host: 'www.example.com', inSchema: true }),
        ],
      }),
    );
    const child = classify(
      makeGroup({
        groupId: 'g-child',
        normalizedHostPattern: 'www.example.com',
        normalizedPathPattern: '/checkout/session/{var1}/status',
        members: [makeEp({ path: '/checkout/session/1/status', hits: 12, host: 'www.example.com' })],
      }),
    );

    expect(parent.score.api).toBeGreaterThanOrEqual(0.7);
    expect(child.score.api).toBeLessThan(0.7);

    const [, promoted] = applySiblingPropagation([parent, child]);
    expect(promoted.score.api).toBeGreaterThan(child.score.api);
    expect(promoted.signals.map((s) => s.id)).toContain('sibling-api-evidence');
  });

  it('leaves groups untouched when no confident parent exists', () => {
    const lone = classify(makeGroup({ groupId: 'g-lone', normalizedPathPattern: '/about-us' }));
    const [result] = applySiblingPropagation([lone]);
    expect(result.score.api).toBe(lone.score.api);
  });
});

describe('classifyGroup — Cloudflare managed labels', () => {
  const withLabels = (path: string, method: string, labels: string[], hits = 5000) =>
    classify(
      makeGroup({
        normalizedPathPattern: path,
        method,
        members: [makeEp({ path, host: 'www.acme.com', method, hits, labels })],
      }),
    );

  // The decisive case. An HTML login form and a real API login endpoint share
  // every path keyword, so only Cloudflare's own labelling separates them.
  it('rejects an HTML login form carrying cf-web-page', () => {
    const group = withLabels('/users/login', 'POST', ['cf-web-page', 'cf-log-in']);
    expect(group.recommendedAction).toBe('ignore');
    expect(group.score.api).toBeLessThan(0.4);
    // Pins the exact api score the README's worked example quotes. Left as a
    // range above, this drifted to 0.24 in the docs across a weight change with
    // no test noticing; anchor the number so the example cannot go stale again.
    expect(group.score.api).toBeCloseTo(0.12, 2);
  });

  it('still saves an API login endpoint carrying cf-api-endpoint', () => {
    const group = withLabels('/v1/sessions', 'POST', ['cf-api-endpoint', 'cf-log-in']);
    expect(group.recommendedAction).toBe('save');
  });

  it('keeps sensitivity high on the rejected form, so the score is not simply inverted', () => {
    const group = withLabels('/users/login', 'POST', ['cf-web-page', 'cf-log-in']);
    // It genuinely is credential-handling; it just is not an API surface.
    expect(group.score.sensitivity).toBeGreaterThan(0.6);
  });

  it.each([
    ['/v2/pricing', ['cf-web-page', 'cf-content']],
    ['/docs/api/getting-started', ['cf-web-page']],
    ['/about-us', ['cf-web-page']],
  ])('ignores page %s labelled cf-web-page', (path, labels) => {
    expect(withLabels(path, 'GET', labels).recommendedAction).toBe('ignore');
  });

  it('treats cf-risk-sensitive as strong sensitivity evidence', () => {
    const group = withLabels('/checkout/pay', 'POST', ['cf-api-endpoint', 'cf-add-payment', 'cf-risk-sensitive']);
    expect(group.recommendedAction).toBe('save');
    expect(group.score.sensitivity).toBeGreaterThan(0.9);
  });

  it('prioritises an endpoint under active enumeration attack', () => {
    const group = withLabels('/v1/accounts/{var1}', 'GET', [
      'cf-api-endpoint',
      'cf-risk-bola-enumeration',
      'cf-risk-missing-auth',
    ]);
    expect(group.recommendedAction).toBe('save');
    expect(group.flags).toContain('cloudflare-risk-label');
  });

  it('routes a zombie to manual review instead of auto-saving it', () => {
    // api score is conclusive, which would otherwise short-circuit to `save`.
    const group = withLabels('/v1/legacy/report', 'GET', ['cf-api-endpoint', 'cf-risk-zombie'], 0);
    expect(group.score.api).toBeGreaterThanOrEqual(0.8);
    expect(group.recommendedAction).toBe('manual_review');
    expect(group.flags).toContain('reclaimable-slot');
  });

  it('does not let a sibling boost override the zombie veto', () => {
    const zombie = withLabels('/v1/legacy/report', 'GET', ['cf-api-endpoint', 'cf-risk-zombie'], 0);
    const parent = classify(
      makeGroup({
        normalizedPathPattern: '/v1',
        members: [makeEp({ path: '/v1', host: 'www.acme.com', labels: ['cf-api-endpoint'] })],
      }),
    );
    const [, propagated] = applySiblingPropagation([parent, zombie]);
    expect(propagated.recommendedAction).toBe('manual_review');
  });

  it('does not treat an RSS feed as worth an operation slot', () => {
    expect(withLabels('/feed.xml', 'GET', ['cf-rss-feed']).recommendedAction).toBe('ignore');
  });

  it('raises confidence when a classifying label is present', () => {
    const withLabel = withLabels('/v1/things', 'GET', ['cf-api-endpoint']);
    const withoutLabel = withLabels('/v1/things', 'GET', []);
    expect(withLabel.confidence).toBeGreaterThan(withoutLabel.confidence);
  });

  it('matches labels case-insensitively', () => {
    expect(withLabels('/users/login', 'POST', ['CF-Web-Page']).recommendedAction).toBe('ignore');
  });

  it('surfaces every label contribution as a visible signal', () => {
    const group = withLabels('/checkout/pay', 'POST', ['cf-api-endpoint', 'cf-add-payment']);
    const labelSignals = group.signals.filter((s) => s.id.startsWith('label-'));
    expect(labelSignals).toHaveLength(2);
    for (const signal of labelSignals) {
      expect(signal.detail).toMatch(/\(cf-[a-z-]+\)$/);
    }
  });
});

describe('page-versus-API evidence gate', () => {
  const at = (host: string, method: string, path: string, partial: Partial<Endpoint> = {}) =>
    classify(
      makeGroup({
        normalizedPathPattern: path,
        method,
        normalizedHostPattern: host,
        members: [makeEp({ path, host, method, hits: 5000, labels: [], ...partial })],
      }),
    );

  // Regression: a rendered HTML login form is reached with POST and sits on an
  // authentication path, which is enough to score api 0.62 / combined 0.74 and
  // clear the save threshold. Nothing in that evidence distinguishes it from a
  // JSON endpoint, so it must not be saved on the strength of it.
  it('does not save an unlabelled login form on write-method and path keywords alone', () => {
    const group = at('www.acme.com', 'POST', '/users/login');
    expect(group.score.combined).toBeGreaterThan(0.62);
    expect(group.recommendedAction).toBe('manual_review');
    expect(group.flags).toContain('no-api-evidence');
  });

  // The same shape with the label present is rejected outright rather than
  // escalated, so the label still does strictly more than the gate.
  it('still rejects the labelled form outright', () => {
    const group = at('www.acme.com', 'POST', '/users/login', { labels: ['cf-web-page', 'cf-log-in'] });
    expect(group.recommendedAction).toBe('ignore');
  });

  // Escalate, never ignore: absent evidence is not evidence of absence, and
  // silently dropping a real API is the worse failure for a security tool.
  it('escalates rather than ignoring, so a real API is never silently dropped', () => {
    expect(at('acme.com', 'POST', '/checkout/session/{var1}').recommendedAction).toBe('manual_review');
  });

  it.each([
    ['an /api segment', 'acme.com', 'POST', '/api/orders', {}],
    ['a version segment', 'api.acme.com', 'POST', '/v2/payments', {}],
    ['a GraphQL path', 'acme.com', 'POST', '/graphql', {}],
    ['an uploaded schema', 'acme.com', 'POST', '/checkout', { inSchema: true }],
    ['a cf-api-endpoint label', 'acme.com', 'GET', '/orders', { labels: ['cf-api-endpoint'] }],
    ['observed auth identifiers', 'acme.com', 'POST', '/login', { features: { authIdTokens: 40 } }],
  ])('still saves an operation evidenced by %s', (_why, host, method, path, partial) => {
    const group = at(host, method, path, partial as Partial<Endpoint>);
    expect(group.recommendedAction).toBe('save');
    expect(group.flags).not.toContain('no-api-evidence');
  });

  // A confirmed API parent is evidence about the child, so propagation must
  // clear the gate rather than leaving a stale flag behind.
  it('clears the gate when a confirmed API parent propagates down', () => {
    const child = at('www.acme.com', 'POST', '/account/transfer');
    expect(child.recommendedAction).toBe('manual_review');
    expect(child.flags).toContain('no-api-evidence');

    const parent = classify(
      makeGroup({
        normalizedPathPattern: '/account',
        normalizedHostPattern: 'www.acme.com',
        members: [makeEp({ path: '/account', host: 'www.acme.com', labels: ['cf-api-endpoint'] })],
      }),
    );
    const [, propagated] = applySiblingPropagation([parent, child]);
    expect(propagated.flags).not.toContain('no-api-evidence');
    expect(propagated.recommendedAction).toBe('save');
  });

  it('reports zero label evidence as a flag and a confidence penalty', () => {
    const unlabelled = at('api.acme.com', 'GET', '/v1/orders/{var1}');
    const labelled = at('api.acme.com', 'GET', '/v1/orders/{var1}', { labels: ['cf-api-endpoint'] });
    expect(unlabelled.flags).toContain('no-label-evidence');
    expect(labelled.flags).not.toContain('no-label-evidence');
    expect(unlabelled.confidence).toBeLessThan(labelled.confidence);
  });
});

describe('Cloudflare variable convention', () => {
  // API Shield discovery returns pre-normalized shapes. Lowercasing them
  // produced `{hostvar1}` in every report.
  it('preserves a Cloudflare host placeholder verbatim', () => {
    expect(normalizeHost(['{hostVar1}.example.com']).pattern).toBe('{hostVar1}.example.com');
  });

  it('still lowercases the rest of the hostname', () => {
    expect(normalizeHost(['{hostVar1}.API.Example.COM']).pattern).toBe('{hostVar1}.api.example.com');
  });

  it('repairs a lowercased placeholder into canonical form', () => {
    expect(normalizeHost(['{hostvar1}.example.com']).pattern).toBe('{hostVar1}.example.com');
  });

  it('does not collapse hosts of differing depth even with placeholders', () => {
    const result = normalizeHost(['{hostVar1}.example.com', '{hostVar1}.demo.example.com']);
    expect(result.canCollapse).toBe(false);
  });

  it('continues Cloudflare numbering instead of colliding with it', () => {
    // The varying label is the second, and `{hostVar1}` is already taken.
    const result = normalizeHost(['{hostVar1}.eu.example.com', '{hostVar1}.us.example.com']);
    expect(result.canCollapse).toBe(true);
    expect(result.pattern).toBe('{hostVar1}.{hostVar2}.example.com');
  });

  it('preserves a Cloudflare path variable', () => {
    const result = normalizePath('/api/v1/orders/{var1}');
    expect(result.pattern).toBe('/api/v1/orders/{var1}');
    expect(result.varCount).toBe(1);
    expect(result.rules).toContain('cloudflare-variable-segment');
  });

  it('accepts a lowercased path variable and canonicalises it', () => {
    expect(normalizePath('/orders/{VAR1}').pattern).toBe('/orders/{var1}');
  });

  it('numbers a new variable after an existing Cloudflare one', () => {
    const result = normalizePath('/orders/{var1}/items/98af23bd11c4e5f60718293a');
    expect(result.pattern).toBe('/orders/{var1}/items/{var2}');
    expect(result.varCount).toBe(2);
  });

  it('renumbers sequentially so patterns never contain duplicates', () => {
    const result = normalizePath('/a/{var5}/b/{var5}');
    expect(result.pattern).toBe('/a/{var1}/b/{var2}');
  });

  it('does not re-examine a placeholder as a literal segment', () => {
    // `{var1}` must not be tested against the hex or entropy heuristics.
    const result = normalizePath('/{var1}');
    expect(result.pattern).toBe('/{var1}');
    expect(result.rules).not.toContain('high-cardinality-segment');
  });

  it('groups endpoints whose placeholders differ only in case', () => {
    const groups = groupEndpoints([
      makeEp({ host: '{hostVar1}.example.com', path: '/v1/things' }),
      makeEp({ host: '{hostvar1}.example.com', path: '/v1/things' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].normalizedHostPattern).toBe('{hostVar1}.example.com');
  });
});

describe('already-decided operations', () => {
  const agent = new ShieldOptimizerAgent();
  const endpoints = [
    makeEp({ id: 'a', host: 'api.example.com', method: 'GET', path: '/api/v1/undecided' }),
    makeEp({ id: 'b', host: 'api.example.com', method: 'GET', path: '/api/v1/kept', status: 'saved' }),
    makeEp({ id: 'c', host: 'api.example.com', method: 'GET', path: '/api/v1/dropped', status: 'ignored' }),
  ];
  const baseOptions: AgentOptions = {
    connectorConfig: { zoneId: 'a'.repeat(32) },
  };

  const patterns = (bundle: ProposalBundle) =>
    bundle.proposals.map((p) => p.target.canonicalPattern);

  // Saved operations occupy the operation budget, and a saved operation is the
  // only place a `cf-risk-zombie` label can appear.
  it('analyses saved and ignored operations by default', () => {
    const bundle = agent.analyze(endpoints, baseOptions);
    expect(bundle.proposals).toHaveLength(3);
    expect(patterns(bundle).join(' ')).toContain('/api/v1/kept');
    expect(patterns(bundle).join(' ')).toContain('/api/v1/dropped');
  });

  it('still reports the existing-state counts', () => {
    const bundle = agent.analyze(endpoints, baseOptions);
    expect(bundle.alreadyDecided.saved).toBe(1);
    expect(bundle.alreadyDecided.ignored).toBe(1);
  });

  it('omits them when explicitly asked to', () => {
    const bundle = agent.analyze(endpoints, { ...baseOptions, includeDecided: false });
    expect(bundle.proposals).toHaveLength(1);
    expect(patterns(bundle)).toEqual([expect.stringContaining('/api/v1/undecided')]);
    // The counts survive even when the operations are not analysed.
    expect(bundle.alreadyDecided.saved).toBe(1);
  });
});

describe('sensitive endpoints below the api floor', () => {
  // Regression: the `apiFloor` check is a hard short-circuit, so a sensitive
  // endpoint that did not look API-shaped was ignored before sensitivity was
  // ever considered.
  it('escalates a sensitive endpoint instead of ignoring it', () => {
    const ep = makeEp({ host: 'shop.example.com', method: 'POST', path: '/checkout/session/abc' });
    const group = classify(makeGroup({ normalizedPathPattern: '/checkout/session/abc', members: [ep] }));
    expect(group.score.api).toBeLessThan(0.4);
    expect(group.recommendedAction).toBe('manual_review');
    expect(group.flags).toContain('sensitive-not-api-shaped');
  });

  // Sensitivity alone must not be the trigger: a managed `cf-web-page` label is
  // positive evidence the endpoint is not an API, and those score *higher* on
  // sensitivity than the endpoints worth rescuing.
  it('does not escalate a labelled web page carrying risk labels', () => {
    const ep = makeEp({
      host: 'www.example.com',
      method: 'GET',
      path: '/about/company',
      labels: ['cf-web-page', 'cf-risk-sensitive'],
    });
    const group = classify(makeGroup({ normalizedPathPattern: '/about/company', members: [ep] }));
    expect(group.score.sensitivity).toBeGreaterThan(0.5);
    expect(group.recommendedAction).toBe('ignore');
    expect(group.flags).not.toContain('sensitive-not-api-shaped');
  });

  it('still ignores an unremarkable page with no sensitivity signal', () => {
    const ep = makeEp({ host: 'www.example.com', method: 'GET', path: '/pricing' });
    const group = classify(makeGroup({ normalizedPathPattern: '/pricing', members: [ep] }));
    expect(group.recommendedAction).toBe('ignore');
  });

  it('survives sibling propagation', () => {
    const groups = [
      classify(
        makeGroup({
          groupId: 'sensitive',
          normalizedPathPattern: '/checkout/session/abc',
          members: [makeEp({ host: 'shop.example.com', method: 'POST', path: '/checkout/session/abc' })],
        }),
      ),
    ];
    const after = applySiblingPropagation(groups);
    expect(after[0].recommendedAction).toBe('manual_review');
  });

  // Regression: a confident parent can lift the child's api score across
  // `apiFloor`, moving the decision from rule 1 (`sensitive-not-api-shaped`) to
  // rule 8 (`borderline-score`) while the action stays `manual_review` both
  // times. The flag and reasoning must move with it — an operator reading the
  // report must never see the pre-boost floor number attached to a group that
  // has since cleared the floor.
  it('replaces the stale rule-1 flag and reasoning after a sibling boost lifts the score past apiFloor', () => {
    const child = classify(
      makeGroup({
        groupId: 'g-child',
        normalizedPathPattern: '/checkout/session/abc',
        normalizedHostPattern: 'shop.example.com',
        members: [makeEp({ host: 'shop.example.com', method: 'POST', path: '/checkout/session/abc' })],
      }),
    );
    expect(child.score.api).toBeLessThan(0.4);
    expect(child.flags).toContain('sensitive-not-api-shaped');

    const parent = classify(
      makeGroup({
        groupId: 'g-parent',
        normalizedPathPattern: '/checkout/session',
        normalizedHostPattern: 'shop.example.com',
        method: 'POST',
        members: [
          makeEp({ path: '/checkout/session', method: 'POST', host: 'shop.example.com', inSchema: true }),
        ],
      }),
    );
    expect(parent.score.api).toBeGreaterThanOrEqual(0.7);

    const [, promoted] = applySiblingPropagation([parent, child]);

    // The boost must actually have crossed the floor, or this test is not
    // exercising the rule-1-to-rule-8 transition it claims to.
    expect(promoted.score.api).toBeGreaterThanOrEqual(0.4);
    expect(promoted.recommendedAction).toBe('manual_review');

    expect(promoted.flags).not.toContain('sensitive-not-api-shaped');
    expect(promoted.flags).toContain('borderline-score');
    expect(promoted.reasoning[0]).not.toMatch(/below the 0\.4 floor/);
    expect(promoted.reasoning[0]).toMatch(/falls between the ignore and save thresholds/);
  });
});

describe('sibling-based variable inference', () => {
  const pattern = (path: string, corpus: string[]) =>
    normalizePath(path, inferSiblingVariables(corpus).get(path)).pattern;

  // Regression: per-segment heuristics judged each literal alone, so members of
  // one identifier family fell on opposite sides of the entropy cutoff. A
  // VIN-keyed catalogue emitted `/vehicles/{var1}` *plus* a literal group per
  // vehicle for the same logical operation.
  const vins = [
    '1HGBH41JXMN109186',
    '5YJ3E1EA7KF317326',
    'WBA3B5C55DF592328',
    '3FA6P0H73HR251234',
  ];

  it('collapses an identifier family consistently', () => {
    const corpus = vins.map((v) => `/v1/vehicles/${v}`);
    const patterns = new Set(corpus.map((p) => pattern(p, corpus)));
    expect([...patterns]).toEqual(['/v1/vehicles/{var1}']);
  });

  it('propagates a confirmed position to deeper sub-resources', () => {
    // Only two financing paths exist, below the threshold on their own.
    const corpus = [
      ...vins.map((v) => `/v1/vehicles/${v}`),
      `/v1/vehicles/${vins[0]}/financing`,
      `/v1/vehicles/${vins[1]}/financing`,
    ];
    expect(pattern(`/v1/vehicles/${vins[0]}/financing`, corpus)).toBe('/v1/vehicles/{var1}/financing');
  });

  // No format rule can detect these: in isolation they are indistinguishable
  // from static resource names.
  it('collapses word-based identifiers', () => {
    const cats = ['mens-shoes', 'womens-tops', 'electronics', 'home-garden', 'grocery'];
    const corpus = cats.map((c) => `/c/${c}`);
    expect(new Set(corpus.map((p) => pattern(p, corpus))).size).toBe(1);
    expect(pattern('/c/mens-shoes', corpus)).toBe('/c/{var1}');
  });

  // Regression: stage 2 matched on prefix and position alone, so a static page
  // sharing a collection prefix was absorbed into the identifier position. The
  // operation then vanished from the report and its traffic was credited to the
  // `{var1}` group.
  it('leaves static pages beside an identifier family intact', () => {
    const corpus = [
      '/products/8813245',
      '/products/8813246',
      '/products/8813247',
      '/products/8813248',
      '/products/8813249',
      '/products/clearance',
      '/products/gift-guide',
    ];
    expect(pattern('/products/8813245', corpus)).toBe('/products/{var1}');
    expect(pattern('/products/clearance', corpus)).toBe('/products/clearance');
    expect(pattern('/products/gift-guide', corpus)).toBe('/products/gift-guide');
  });

  it('reports the static siblings as their own operations', () => {
    const paths = [
      '/products/8813245',
      '/products/8813246',
      '/products/8813247',
      '/products/8813248',
      '/products/8813249',
      '/products/clearance',
      '/products/gift-guide',
    ];
    const groups = groupEndpoints(paths.map((p) => makeEp({ path: p, host: 'shop.example.com' })));
    const patterns = groups.map((g) => g.normalizedPathPattern).sort();
    expect(patterns).toEqual(['/products/clearance', '/products/gift-guide', '/products/{var1}']);
    expect(groups.find((g) => g.normalizedPathPattern === '/products/{var1}')!.members).toHaveLength(5);
  });

  // A lone static literal must not be swept up by siblings Cloudflare has
  // already marked, so a shape needs two real values of its own.
  it('does not let already-variable siblings absorb a single static literal', () => {
    const corpus = [
      '/items/{var1}',
      '/items/{var1}/a',
      '/items/{var1}/b',
      '/items/{var1}/c',
      '/items/settings',
    ];
    expect(pattern('/items/settings', corpus)).toBe('/items/settings');
  });

  it('does not pool distinct resources that differ downstream', () => {
    const corpus = [
      '/products/list',
      '/orders/list',
      '/customers/list',
      '/invoices/list',
      '/shipments/list',
    ];
    expect(pattern('/products/list', corpus)).toBe('/products/list');
  });

  it('never infers a variable at the root position', () => {
    const corpus = ['/alpha/x', '/bravo/x', '/charlie/x', '/delta/x', '/echo/x', '/foxtrot/x'];
    for (const p of corpus) expect(pattern(p, corpus)).toBe(p);
  });

  it('requires corroboration before collapsing', () => {
    const corpus = ['/v1/things/red', '/v1/things/blue'];
    expect(pattern('/v1/things/red', corpus)).toBe('/v1/things/red');
  });

  it('leaves allowlisted static segments literal', () => {
    const corpus = [
      '/v1/things/profile',
      '/v1/things/abc',
      '/v1/things/def',
      '/v1/things/ghi',
      '/v1/things/jkl',
    ];
    expect(pattern('/v1/things/profile', corpus)).toBe('/v1/things/profile');
  });

  // An action verb sharing a collection's prefix must not be absorbed into the
  // identifier position: `/products/search` is a different operation from
  // `/products/{sku}`, and merging them misattributes the search traffic.
  it.each(['search', 'export', 'validate', 'bulk', 'count'])(
    'does not absorb the action verb %s into an identifier',
    (verb) => {
      const corpus = [
        `/api/v2/products/${verb}`,
        '/api/v2/products/80421133',
        '/api/v2/products/80421134',
        '/api/v2/products/80421135',
        '/api/v2/products/80421136',
      ];
      expect(pattern(`/api/v2/products/${verb}`, corpus)).toBe(`/api/v2/products/${verb}`);
      expect(pattern('/api/v2/products/80421133', corpus)).toBe('/api/v2/products/{var1}');
    },
  );

  it('records the inference in the rule list', () => {
    const corpus = vins.map((v) => `/v1/vehicles/${v}`);
    const { rules } = normalizePath(corpus[0], inferSiblingVariables(corpus).get(corpus[0]));
    expect(rules).toContain('sibling-variable-segment');
  });

  it('groups an identifier family into a single group end to end', () => {
    const eps = vins.map((v) =>
      makeEp({ host: 'api.example.com', method: 'GET', path: `/v1/vehicles/${v}` }),
    );
    const groups = groupEndpoints(eps);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(4);
  });
});

describe('prefixed identifier formats', () => {
  // Same inconsistency, seen within one id family: `ch_3MqLyJ2eZvKYlo2C` was
  // detected while `cus_NffrFeUfNV2Hib` was not, because the rule was gated on
  // the entropy heuristic.
  it.each(['ORD-2042284971', 'INV-0001', 'cus_NffrFeUfNV2Hib', 'ch_3MqLyJ2eZvKYlo2C', 'sub_1MowQVLkdIwHu7ix'])(
    'treats %s as an identifier',
    (segment) => {
      expect(isVariableSegment(segment)).toBe(true);
    },
  );

  it.each([
    'iphone13promax',
    'top10bestlaptops',
    'office365business',
    'html5videoplayer',
    'error404handler',
    'mens-shoes',
    'winter-coat-navy',
    '4k-oled-tv-65in',
    'organic-dog-food-12kg',
    'content_management',
    'user_profile_data',
    'returns-policy',
  ])('keeps %s literal', (segment) => {
    expect(isVariableSegment(segment)).toBe(false);
  });

  // Regression: CUIDs matched unconditionally, unlike every other long-id
  // pattern in this module, so a 25+ char `c`-initial English word — which the
  // entropy gate exists precisely to keep literal — was flagged as a variable
  // anyway.
  it.each(['customerrelationshipmanagement', 'californiaresidentprivacyrights', 'contentmanagementsystemsettings'])(
    'keeps the long c-initial word %s literal despite matching the CUID shape',
    (segment) => {
      expect(isVariableSegment(segment)).toBe(false);
    },
  );

  it.each(['cjld2cyuq0000t3rmniod1foy', 'ckq1qg1qk0000abcd1234efgh'])(
    'still treats a real CUID %s as an identifier',
    (segment) => {
      expect(isVariableSegment(segment)).toBe(true);
    },
  );
});

describe('traffic rate signals', () => {
  const rated = (perHour: number, seconds = 3600) =>
    makeEp({
      path: '/api/v1/things',
      host: 'api.example.com',
      hits: null,
      labels: ['cf-api-endpoint'],
      features: { periodRequests: (perHour * seconds) / 3600, periodSeconds: seconds },
    });

  it('derives requests per hour from the reported period', () => {
    expect(requestsPerHour(rated(10))).toBeCloseTo(10);
  });

  it('normalises a rate reported over a non-hourly window', () => {
    // 120 requests per 60 seconds is 7200 per hour.
    const ep = makeEp({
      path: '/x',
      host: 'api.example.com',
      features: { periodRequests: 120, periodSeconds: 60 },
    });
    expect(requestsPerHour(ep)).toBeCloseTo(7200);
  });

  it.each([
    ['missing features', {}],
    ['missing period', { periodRequests: 10 }],
    ['zero period', { periodRequests: 10, periodSeconds: 0 }],
    ['negative period', { periodRequests: 10, periodSeconds: -1 }],
  ])('returns null for %s', (_label, features) => {
    const ep = makeEp({ path: '/x', host: 'api.example.com', features });
    expect(requestsPerHour(ep)).toBeNull();
  });

  it('sums rates across members', () => {
    expect(totalRequestsPerHour([rated(10), rated(5)])).toBeCloseTo(15);
  });

  it('returns null when no member reports a rate', () => {
    expect(totalRequestsPerHour([makeEp({ path: '/x', host: 'api.example.com' })])).toBeNull();
  });

  // Regression: every live endpoint was flagged `no-traffic-data` because the
  // API never reports an absolute count, only a rate.
  it('does not flag no-traffic-data when a rate is known', () => {
    const group = classify(makeGroup({ normalizedPathPattern: '/api/v1/things', members: [rated(500)] }));
    expect(group.flags).not.toContain('no-traffic-data');
  });

  it('still flags no-traffic-data when neither measure is present', () => {
    const bare = makeEp({ path: '/api/v1/things', host: 'api.example.com', hits: null });
    const group = classify(makeGroup({ normalizedPathPattern: '/api/v1/things', members: [bare] }));
    expect(group.flags).toContain('no-traffic-data');
  });

  it('adds a high-traffic signal from rate alone', () => {
    const group = classify(makeGroup({ normalizedPathPattern: '/api/v1/things', members: [rated(50000)] }));
    expect(group.signals.map((s) => s.id)).toContain('high-traffic-rate');
  });

  it('flags a negligible rate as low traffic', () => {
    const group = classify(makeGroup({ normalizedPathPattern: '/api/v1/things', members: [rated(0.01)] }));
    expect(group.flags).toContain('low-traffic');
  });

  it('raises confidence with traffic rate', () => {
    const busy = classify(makeGroup({ normalizedPathPattern: '/api/v1/things', members: [rated(50000)] }));
    const idle = classify(makeGroup({ normalizedPathPattern: '/api/v1/things', members: [rated(0.01)] }));
    expect(busy.confidence).toBeGreaterThan(idle.confidence);
  });

  it('prefers an absolute hit count when both are available', () => {
    const ep = makeEp({
      path: '/api/v1/things',
      host: 'api.example.com',
      hits: 50000,
      features: { periodRequests: 1, periodSeconds: 3600 },
    });
    const group = classify(makeGroup({ normalizedPathPattern: '/api/v1/things', members: [ep] }));
    expect(group.signals.map((s) => s.id)).toContain('high-traffic');
    expect(group.flags).not.toContain('low-traffic');
  });

  // The core budget question: with a cap, which slots do you spend?
  it('ranks by rate when absolute counts are unavailable', () => {
    const groups = [0.01, 50000, 5, 900].map((rate, i) =>
      classify(
        makeGroup({
          groupId: `g${i}`,
          normalizedPathPattern: `/api/v1/r${i}`,
          members: [{ ...rated(rate), path: `/api/v1/r${i}` }],
        }),
      ),
    );

    const ordered = [...groups].sort((a, b) => rankValue(b) - rankValue(a));
    const rates = ordered.map((g) => totalRequestsPerHour(g.members)!);
    expect(rates).toEqual([...rates].sort((a, b) => b - a));
    expect(rates[0]).toBeCloseTo(50000);
  });

  it('formats rates readably across magnitudes', () => {
    expect(formatRate(5000)).toBe('5,000 req/hour');
    expect(formatRate(0.5)).toBe('12.0 req/day');
    expect(formatRate(0.001)).toBe('0.72 req/month');
  });
});

describe('generateProposal', () => {
  it('produces a well-formed proposal exposing the score breakdown', () => {
    const group = classify(
      makeGroup({
        normalizedPathPattern: '/users/{var1}',
        members: [makeEp({ path: '/users/1', host: 'api.example.com' })],
      }),
    );
    const p = generateProposal(group);
    expect(p.target.membersCount).toBe(1);
    expect(p.score.api).toBeGreaterThan(0);
    expect(p.signals.length).toBeGreaterThan(0);
    expect(p.whyThisGroupingIsSafe.length).toBeGreaterThan(0);
    expect(p.whyThisGroupingIsUseful.length).toBeGreaterThan(0);
    expect(p.whyItMayBeWrong.length).toBeGreaterThan(0);
  });

  it('bounds the number of embedded raw endpoints', () => {
    const members = Array.from({ length: 500 }, (_, i) =>
      makeEp({ id: `e${i}`, path: `/v1/items/${i}`, host: 'api.example.com' }),
    );
    const p = generateProposal(makeGroup({ normalizedPathPattern: '/v1/items/{var1}', members }));
    expect(p.before.rawEndpoints.length).toBeLessThanOrEqual(25);
    expect(p.before.membersOmitted).toBe(500 - p.before.rawEndpoints.length);
    expect(p.target.membersCount).toBe(500);
  });

  it('embeds every member when the cap is disabled', () => {
    const members = Array.from({ length: 120 }, (_, i) =>
      makeEp({ id: `e${i}`, path: `/v1/items/${i}`, host: 'api.example.com' }),
    );
    const group = makeGroup({ normalizedPathPattern: '/v1/items/{var1}', members });
    const p = generateProposal(group, 0);
    expect(p.before.rawEndpoints).toHaveLength(120);
    expect(p.before.membersOmitted).toBe(0);
  });

  it('honours an explicit member cap from the bundle context', () => {
    const members = Array.from({ length: 40 }, (_, i) =>
      makeEp({ id: `e${i}`, path: `/v1/items/${i}`, host: 'api.example.com' }),
    );
    const group = classify(makeGroup({ normalizedPathPattern: '/v1/items/{var1}', members }));
    const bundle = generateBundle([group], { maxEmbeddedMembers: 3 });
    expect(bundle.proposals[0].before.rawEndpoints).toHaveLength(3);
    expect(bundle.proposals[0].before.membersOmitted).toBe(37);
  });
});

describe('generateBundle', () => {
  it('counts actions and reports analysis totals', () => {
    const groups = [
      classify(
        makeGroup({
          groupId: 'g1',
          normalizedPathPattern: '/api/v1/auth/login',
          method: 'POST',
          members: [makeEp({ path: '/api/v1/auth/login', method: 'POST', hits: 40000, host: 'api.example.com' })],
        }),
      ),
      classify(
        makeGroup({
          groupId: 'g2',
          normalizedPathPattern: '/health',
          members: [makeEp({ path: '/health', host: 'api.example.com' })],
        }),
      ),
    ];

    const bundle = generateBundle(groups, {
      zoneId: 'a'.repeat(32),
      analyzedGroupCount: 5,
      analyzedEndpointCount: 20,
    });

    expect(bundle.summary.saveCount).toBe(1);
    expect(bundle.summary.ignoreCount).toBe(1);
    expect(bundle.proposals.length).toBe(2);
    expect(bundle.scope.zoneId).toBe('a'.repeat(32));
    expect(bundle.scope.truncated).toBe(true);
    expect(bundle.scope.analyzedGroupCount).toBe(5);
    expect(bundle.rulesetVersion).toBeTruthy();
  });

  it('excludes unknown traffic from the hit total and counts it separately', () => {
    const group = classify(
      makeGroup({
        normalizedPathPattern: '/api/v1/things',
        members: [
          makeEp({ path: '/api/v1/things', hits: 50, host: 'api.example.com' }),
          makeEp({ path: '/api/v1/things', hits: null, host: 'api.example.com' }),
        ],
      }),
    );
    const bundle = generateBundle([group]);
    expect(bundle.summary.totalHits).toBe(50);
    expect(bundle.summary.endpointsWithoutTrafficData).toBe(1);
  });
});

describe('bundleToCsv', () => {
  const bundleFor = (group: NormalizedGroup) => generateBundle([group], { zoneId: 'a'.repeat(32) });

  const sensitiveGroup = () =>
    classify(
      makeGroup({
        normalizedPathPattern: '/checkout/session/abc',
        members: [makeEp({ host: 'shop.example.com', method: 'POST', path: '/checkout/session/abc' })],
      }),
    );

  const columns = (csv: string) => csv.split('\n')[0].split(',');

  it('exports signals and flags as separate columns', () => {
    const header = columns(bundleToCsv(bundleFor(sensitiveGroup())));
    expect(header).toContain('signals');
    expect(header).toContain('flags');
    expect(header.indexOf('signals')).not.toBe(header.indexOf('flags'));
  });

  // Regression: the column headed `flags` carried signal ids, so triage flags
  // never reached the spreadsheet an operator signs off on.
  it('puts triage flags in the flags column, not signal ids', () => {
    const group = sensitiveGroup();
    expect(group.flags).toContain('sensitive-not-api-shaped');

    const csv = bundleToCsv(bundleFor(group));
    const header = columns(csv);
    const row = csv.split('\n')[1].split(',');

    expect(row[header.indexOf('flags')]).toContain('sensitive-not-api-shaped');
    expect(row[header.indexOf('signals')]).not.toContain('sensitive-not-api-shaped');
  });

  it('keeps a row per proposal', () => {
    const csv = bundleToCsv(bundleFor(sensitiveGroup()));
    expect(csv.trim().split('\n')).toHaveLength(2);
  });
});

describe('scoring configuration overrides', () => {
  // These come from a user-editable file and feed a security decision. A wrong
  // number is more dangerous than a missing one: `apiFloor: -1` makes every path
  // clear the floor, turning a privacy policy into a `save`.
  it.each([
    ['apiFloor below zero', { apiFloor: -1 }],
    ['apiFloor above one', { apiFloor: 4 }],
    ['saveThreshold not a number', { saveThreshold: 'high' as unknown as number }],
    ['NaN threshold', { ignoreThreshold: Number.NaN }],
    ['negative traffic threshold', { highTrafficRatePerHour: -5 }],
    ['ignoreThreshold above saveThreshold', { ignoreThreshold: 0.9, saveThreshold: 0.5 }],
    ['apiFloor above apiCertain', { apiFloor: 0.9, apiCertain: 0.5 }],
    ['low rate above high rate', { lowTrafficRatePerHour: 5000 }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => resolveScoringConfig(overrides)).toThrow(ValidationError);
  });

  it('names the offending key so the operator can fix the file', () => {
    expect(() => resolveScoringConfig({ apiFloor: -1 })).toThrow(/apiFloor/);
  });

  it('accepts a legitimate override', () => {
    const config = resolveScoringConfig({ saveThreshold: 0.7 });
    expect(config.saveThreshold).toBe(0.7);
    expect(config.apiFloor).toBe(DEFAULT_SCORING_CONFIG.apiFloor);
  });

  // `rulesetVersion` is the provenance of a recommendation. `review` warns on a
  // mismatch, so a config file must not be able to claim a published version.
  it('ignores an attempt to set rulesetVersion', () => {
    const config = resolveScoringConfig({ rulesetVersion: '9.9.9' });
    expect(config.rulesetVersion).not.toBe('9.9.9');
  });

  it('marks a customised ruleset so a report cannot pass as the published one', () => {
    expect(resolveScoringConfig({ saveThreshold: 0.7 }).rulesetVersion).toBe(
      `${DEFAULT_SCORING_CONFIG.rulesetVersion}+custom`,
    );
    expect(resolveScoringConfig().rulesetVersion).toBe(DEFAULT_SCORING_CONFIG.rulesetVersion);
  });
});

describe('method set scoping', () => {
  // Regression: the method set was keyed by path alone, so unrelated hosts
  // pooled and `rest-method-set` was awarded to endpoints that serve one method.
  it('does not share a method set across unrelated hosts', () => {
    const groups = groupEndpoints([
      makeEp({ host: 'api.acme.com', method: 'GET', path: '/orders' }),
      makeEp({ host: 'blog.other.com', method: 'POST', path: '/orders' }),
    ]);

    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.methodsOnPath).toEqual([group.method]);
    }
  });

  it('still reports the full method set for one host', () => {
    const groups = groupEndpoints([
      makeEp({ host: 'api.acme.com', method: 'GET', path: '/orders' }),
      makeEp({ host: 'api.acme.com', method: 'POST', path: '/orders' }),
      makeEp({ host: 'api.acme.com', method: 'DELETE', path: '/orders' }),
    ]);

    for (const group of groups) {
      expect(group.methodsOnPath).toEqual(['DELETE', 'GET', 'POST']);
    }
  });

  it('withholds the rest-method-set signal from a single-method host', () => {
    const [apiGroup] = groupEndpoints([
      makeEp({ host: 'api.acme.com', method: 'GET', path: '/v1/orders' }),
      makeEp({ host: 'blog.other.com', method: 'POST', path: '/v1/orders' }),
    ]);
    const signals = classifyGroup(apiGroup).signals.map((s) => s.id);
    expect(signals).not.toContain('rest-method-set');
  });
});

describe('budget and ranking', () => {
  const agent = new ShieldOptimizerAgent();

  // Distinct methods on one path, so each is its own group without tripping
  // sibling inference on the path segments.
  const saveable = (method: string) =>
    makeEp({ host: 'api.example.com', method, path: '/api/v1/payments', id: `s-${method}` });

  // Regression: the budget was counted after `maxGroups` truncation, so a
  // report claimed slots that were already spoken for.
  it('counts every analysed save in the budget, not just the reported ones', () => {
    const endpoints = [saveable('GET'), saveable('POST'), saveable('PUT'), saveable('DELETE')];
    const full = agent.analyze(endpoints, {
      connectorConfig: { zoneId: 'a'.repeat(32) },
      operationBudget: 10,
    });
    const truncated = agent.analyze(endpoints, {
      connectorConfig: { zoneId: 'a'.repeat(32) },
      operationBudget: 10,
      maxGroups: 1,
    });

    expect(truncated.proposals).toHaveLength(1);
    expect(truncated.budget!.proposedSaves).toBe(full.budget!.proposedSaves);
    expect(truncated.budget!.remaining).toBe(full.budget!.remaining);
    expect(truncated.budget!.notes.join(' ')).toMatch(/omitted from this report/);
  });

  // Regression: nobody had verified `overBudget: true` or its note text — the
  // report an operator actually reads when a zone has more save-worthy
  // proposals than available operation slots.
  it('reports overBudget when proposed saves exceed the configured limit', () => {
    const endpoints = [saveable('GET'), saveable('POST'), saveable('PUT'), saveable('DELETE')];
    const bundle = agent.analyze(endpoints, {
      connectorConfig: { zoneId: 'a'.repeat(32) },
      operationBudget: 2,
    });

    expect(bundle.budget!.proposedSaves).toBe(4);
    expect(bundle.budget!.overBudget).toBe(true);
    expect(bundle.budget!.remaining).toBe(-2);
    expect(bundle.budget!.notes.join(' ')).toMatch(
      /Proposals exceed the operation budget by 2\. Proposals are ranked by value, so the first 2 saves are the highest priority\./,
    );
  });

  it('reports remaining slots and no overBudget note when under the limit', () => {
    const endpoints = [saveable('GET'), saveable('POST')];
    const bundle = agent.analyze(endpoints, {
      connectorConfig: { zoneId: 'a'.repeat(32) },
      operationBudget: 10,
    });

    expect(bundle.budget!.overBudget).toBe(false);
    expect(bundle.budget!.remaining).toBe(8);
    expect(bundle.budget!.notes.join(' ')).toMatch(/8 operation slot\(s\) remain/);
  });

  // `alreadySaved` counts against the same limit as new proposals — a zone
  // that is already at capacity must report overBudget even with zero new
  // saves proposed. Uses a zombie (recommendedAction `manual_review`, not
  // `save`) so `alreadySaved` and `proposedSaves` are cleanly separate; an
  // already-saved endpoint that *also* re-qualifies for `save` is counted in
  // both (see the note below `buildBudget` in agent.ts), which would make this
  // assertion depend on that overlap rather than on `alreadySaved` alone.
  it('counts already-saved operations against the same limit', () => {
    const zombie = makeEp({
      host: 'api.example.com',
      method: 'GET',
      path: '/legacy/report',
      id: 'saved-1',
      hits: 0,
      status: 'saved',
      labels: ['cf-api-endpoint', 'cf-risk-zombie'],
    });
    const bundle = agent.analyze([zombie], {
      connectorConfig: { zoneId: 'a'.repeat(32) },
      operationBudget: 1,
    });

    expect(bundle.proposals[0].action).toBe('manual_review');
    expect(bundle.budget!.alreadySaved).toBe(1);
    expect(bundle.budget!.proposedSaves).toBe(0);
    expect(bundle.budget!.remaining).toBe(0);
    expect(bundle.budget!.overBudget).toBe(false);
  });

  // Discovered while adding budget coverage, not previously documented:
  // `proposedSaves` counts every group classified `save` regardless of
  // whether it is already saved, so a group that is both `alreadySaved` and
  // still recommended `save` is subtracted from the limit twice — once via
  // `alreadySaved`, once via `proposedSaves` — even though it occupies only
  // one real slot. A zone sitting exactly at capacity with every saved
  // operation still correctly scoring `save` would report `overBudget: true`
  // when it is not. Documented here as a known quirk rather than silently
  // changed, since the fix changes what the budget numbers mean and this
  // codebase treats that as a deliberate, reviewed decision (see AGENTS.md's
  // other budget caveats under "Open questions and future work").
  it('double-counts a still-qualifying save against an already-saved slot (known quirk)', () => {
    const alreadySavedAndStillQualifies = makeEp({
      host: 'api.example.com',
      method: 'GET',
      path: '/api/v1/payments',
      id: 'saved-1',
      status: 'saved',
      labels: ['cf-api-endpoint'],
    });
    const bundle = agent.analyze([alreadySavedAndStillQualifies], {
      connectorConfig: { zoneId: 'a'.repeat(32) },
      operationBudget: 1,
    });

    expect(bundle.proposals[0].action).toBe('save');
    expect(bundle.budget!.alreadySaved).toBe(1);
    expect(bundle.budget!.proposedSaves).toBe(1);
    // Intuitively this operation occupies exactly one slot at a limit of one,
    // so `remaining` should be 0 and `overBudget` false. It is not, today.
    expect(bundle.budget!.remaining).toBe(-1);
    expect(bundle.budget!.overBudget).toBe(true);
  });

  // Regression: the traffic term spanned more than the action term, so a busy
  // `manual_review` could outrank a `save` and take its budget slot.
  it('never ranks a manual_review above a save', () => {
    const busyReview: NormalizedGroup = makeGroup({
      normalizedPathPattern: '/checkout/session/{var1}',
      method: 'POST',
      recommendedAction: 'manual_review',
      confidence: 0.95,
      score: { api: 1, sensitivity: 1, combined: 1 },
      members: [
        makeEp({
          path: '/checkout/session/{var1}',
          host: 'api.example.com',
          method: 'POST',
          hits: 1_000_000_000,
          features: { periodRequests: 1_000_000_000, periodSeconds: 3600 },
        }),
      ],
    });
    const quietSave: NormalizedGroup = makeGroup({
      normalizedPathPattern: '/api/v1/thing',
      recommendedAction: 'save',
      confidence: 0.05,
      score: { api: 0.8, sensitivity: 0.2, combined: 0.62 },
      members: [makeEp({ path: '/api/v1/thing', host: 'api.example.com', hits: null })],
    });

    expect(rankValue(quietSave)).toBeGreaterThan(rankValue(busyReview));
  });

  it('still orders two saves by traffic', () => {
    const base = {
      recommendedAction: 'save' as const,
      confidence: 0.5,
      score: { api: 0.9, sensitivity: 0.5, combined: 0.74 },
    };
    const busy = makeGroup({
      ...base,
      normalizedPathPattern: '/api/v1/busy',
      members: [
        makeEp({
          path: '/api/v1/busy',
          host: 'api.example.com',
          hits: null,
          features: { periodRequests: 900, periodSeconds: 3600 },
        }),
      ],
    });
    const quiet = makeGroup({
      ...base,
      normalizedPathPattern: '/api/v1/quiet',
      members: [
        makeEp({
          path: '/api/v1/quiet',
          host: 'api.example.com',
          hits: null,
          features: { periodRequests: 5, periodSeconds: 3600 },
        }),
      ],
    });

    expect(rankValue(busy)).toBeGreaterThan(rankValue(quiet));
  });
});

describe('minHits filtering', () => {
  const agent = new ShieldOptimizerAgent();
  const opts = (minHits: number): AgentOptions => ({
    connectorConfig: { zoneId: 'a'.repeat(32) },
    minHits,
  });

  const withRate = (path: string, requests: number) =>
    makeEp({
      host: 'api.example.com',
      path,
      hits: null,
      features: { periodRequests: requests, periodSeconds: 3600 },
    });

  // Regression: the filter inspected `hits` only, which is always null in API
  // mode, so `--min-hits` silently did nothing against a live zone.
  it('applies to the observed request rate when no absolute count exists', () => {
    const bundle = agent.analyze([withRate('/api/v1/busy', 500), withRate('/api/v1/quiet', 2)], opts(100));
    const patterns = bundle.proposals.map((p) => p.target.canonicalPattern).join(' ');
    expect(patterns).toContain('/api/v1/busy');
    expect(patterns).not.toContain('/api/v1/quiet');
  });

  it('retains endpoints whose traffic is unknown', () => {
    const unknown = makeEp({ host: 'api.example.com', path: '/api/v1/managed', hits: null });
    const bundle = agent.analyze([unknown], opts(100));
    expect(bundle.proposals).toHaveLength(1);
  });

  it('still filters on an absolute count when one is reported', () => {
    const bundle = agent.analyze(
      [
        makeEp({ host: 'api.example.com', path: '/api/v1/big', hits: 5000 }),
        makeEp({ host: 'api.example.com', path: '/api/v1/small', hits: 3 }),
      ],
      opts(100),
    );
    const patterns = bundle.proposals.map((p) => p.target.canonicalPattern).join(' ');
    expect(patterns).toContain('/api/v1/big');
    expect(patterns).not.toContain('/api/v1/small');
  });
});

describe('buildApplyPayload', () => {
  const ZONE = 'a'.repeat(32);

  const bundleOf = (groups: NormalizedGroup[]) => generateBundle(groups, { zoneId: ZONE });

  const savedGroup = () =>
    classify(
      makeGroup({
        normalizedPathPattern: '/api/v1/payments',
        method: 'POST',
        normalizedHostPattern: 'api.example.com',
        members: [
          makeEp({ id: 'disc-1', host: 'api.example.com', method: 'POST', path: '/api/v1/payments' }),
        ],
      }),
    );

  const ignoredGroup = () =>
    classify(
      makeGroup({
        normalizedPathPattern: '/about-us',
        normalizedHostPattern: 'www.example.com',
        members: [
          makeEp({ id: 'disc-2', host: 'www.example.com', method: 'GET', path: '/about-us', labels: ['cf-web-page'] }),
        ],
      }),
    );

  it('emits a POST for saves and a PATCH for ignores, and nothing else', () => {
    const payload = buildApplyPayload(bundleOf([savedGroup(), ignoredGroup()]));
    const methods = payload.requests.map((r) => r.method).sort();
    expect(methods).toEqual(['PATCH', 'POST']);
    expect(payload.saveOperations).toEqual([
      { host: 'api.example.com', method: 'POST', endpoint: '/api/v1/payments' },
    ]);
    expect(payload.ignoreOperationStates).toEqual({ 'disc-2': { state: 'ignored' } });
  });

  it('targets the zone from the bundle', () => {
    const payload = buildApplyPayload(bundleOf([savedGroup()]));
    expect(payload.zoneId).toBe(ZONE);
    for (const request of payload.requests) {
      expect(request.url).toContain(`/zones/${ZONE}/api_gateway`);
    }
  });

  // A bundle produced without a zone must not silently build `/zones//...`.
  it('uses a visible placeholder when the bundle carries no zone', () => {
    const payload = buildApplyPayload(generateBundle([savedGroup()], {}));
    expect(payload.zoneId).toBe('{zoneId}');
    expect(payload.requests.every((r) => !r.url.includes('/zones//'))).toBe(true);
  });

  // The tool never transmits anything, so the preview must not carry a token.
  it('never embeds a real token in the curl preview', () => {
    const payload = buildApplyPayload(bundleOf([savedGroup()]));
    for (const request of payload.requests) {
      expect(request.curl).toContain('$CF_API_TOKEN');
      expect(request.headers.Authorization).toBe('Bearer $CF_API_TOKEN');
    }
  });

  it('states that nothing was applied', () => {
    expect(buildApplyPayload(bundleOf([savedGroup()])).warning).toMatch(/never writes to the Cloudflare API/);
  });

  it('excludes manual_review from the payload', () => {
    const review = classify(
      makeGroup({
        normalizedPathPattern: '/checkout/session/{var1}',
        method: 'POST',
        normalizedHostPattern: 'shop.example.com',
        members: [makeEp({ id: 'disc-3', host: 'shop.example.com', method: 'POST', path: '/checkout/session/{var1}' })],
      }),
    );
    expect(review.recommendedAction).toBe('manual_review');

    const payload = buildApplyPayload(bundleOf([review]));
    expect(payload.saveOperations).toHaveLength(0);
    expect(payload.ignoreOperationStates).toEqual({});
  });

  it('lets a decision override the recommendation', () => {
    const group = ignoredGroup();
    const bundle = bundleOf([group]);
    const payload = buildApplyPayload(bundle, {
      decisions: {
        rulesetVersion: DEFAULT_SCORING_CONFIG.rulesetVersion,
        decidedAt: new Date().toISOString(),
        decisions: [
          {
            groupId: group.groupId,
            canonicalPattern: 'www.example.com/about-us',
            method: 'GET',
            decision: 'save',
            recommendedAction: 'ignore',
            decidedAt: new Date().toISOString(),
          },
        ],
      },
    });
    expect(payload.saveOperations).toHaveLength(1);
    expect(payload.ignoreOperationStates).toEqual({});
  });

  it('skips a save it cannot turn into a concrete operation', () => {
    const consolidated = classify(
      makeGroup({
        normalizedPathPattern: '/api/v1/things',
        method: 'POST',
        normalizedHostPattern: '{hostVar1}.example.com',
        members: [makeEp({ id: 'disc-4', host: '', method: 'POST', path: '/api/v1/things' })],
      }),
    );
    expect(consolidated.recommendedAction).toBe('save');
    const payload = buildApplyPayload(bundleOf([consolidated]), { actions: ['save'] });
    expect(payload.saveOperations).toHaveLength(0);
    expect(payload.skipped.map((s) => s.reason).join(' ')).toMatch(/hostname variable/);
  });

  it('counts skipped proposals rather than dropping them silently', () => {
    const payload = buildApplyPayload(bundleOf([savedGroup()]), { minConfidence: 0.99 });
    expect(payload.counts.save).toBe(0);
    expect(payload.counts.skipped).toBe(1);
    expect(payload.skipped[0].reason).toMatch(/below --min-confidence/);
  });
});

describe('formatBundleAsText', () => {
  const bundle = () =>
    generateBundle(
      [
        classify(
          makeGroup({
            normalizedPathPattern: '/api/v1/payments',
            method: 'POST',
            normalizedHostPattern: 'api.example.com',
            members: [makeEp({ host: 'api.example.com', method: 'POST', path: '/api/v1/payments', hits: 4000 })],
          }),
        ),
      ],
      {
        zoneId: 'a'.repeat(32),
        budget: {
          limit: 10,
          alreadySaved: 0,
          proposedSaves: 1,
          remaining: 9,
          overBudget: false,
          notes: ['9 operation slot(s) remain after applying the proposed saves.'],
        },
      },
    );

  it('reports the ruleset that produced it', () => {
    expect(formatBundleAsText(bundle())).toContain(DEFAULT_SCORING_CONFIG.rulesetVersion);
  });

  it('shows the action, pattern and score for each proposal', () => {
    const text = formatBundleAsText(bundle());
    expect(text).toContain('SAVE');
    expect(text).toContain('api.example.com/api/v1/payments');
    expect(text).toMatch(/API:\s+\d\.\d\d/);
  });

  it('summarises counts and the operation budget', () => {
    const text = formatBundleAsText(bundle());
    expect(text).toContain('SUMMARY');
    expect(text).toContain('OPERATION BUDGET');
  });

  // `hits` is null in API mode; a report must not print a measured-looking zero.
  it('does not claim zero traffic when traffic is unknown', () => {
    const unknown = generateBundle(
      [
        classify(
          makeGroup({
            normalizedPathPattern: '/api/v1/managed',
            normalizedHostPattern: 'api.example.com',
            members: [makeEp({ host: 'api.example.com', path: '/api/v1/managed', hits: null })],
          }),
        ),
      ],
      { zoneId: 'a'.repeat(32) },
    );
    expect(formatBundleAsText(unknown)).not.toMatch(/Total Hits:\s+0/);
  });

  it('lists every proposal', () => {
    const text = formatBundleAsText(bundle());
    expect(text).toMatch(/PROPOSAL 1 of 1/);
  });
});

describe('percentile-relative traffic thresholds', () => {
  const config = getDefaultCompiledConfig();

  const groupAtRate = (path: string, ratePerHour: number) =>
    makeGroup({
      normalizedPathPattern: path,
      members: [
        // `hits` is null in API mode, so a rate is the only traffic evidence.
        makeEp({
          host: 'api.example.com',
          path,
          hits: null,
          features: { periodRequests: ratePerHour, periodSeconds: 3600 },
        }),
      ],
    });

  // A busy zone: every endpoint is far above the absolute 1000 req/hour mark, so
  // the absolute thresholds cannot tell the busiest apart from the quietest.
  const busyZone = () =>
    Array.from({ length: 40 }, (_, i) => groupAtRate(`/api/v1/r${i}`, 100_000 + i * 100_000));

  it('derives thresholds from the zone when there are enough samples', () => {
    const thresholds = computeTrafficThresholds(busyZone(), config);
    expect(thresholds.relative).toBe(true);
    expect(thresholds.highRatePerHour).toBeGreaterThan(config.highTrafficRatePerHour);
    expect(thresholds.lowRatePerHour).toBeGreaterThan(config.lowTrafficRatePerHour);
  });

  it('keeps the absolute thresholds when too few endpoints report a rate', () => {
    const thresholds = computeTrafficThresholds([groupAtRate('/api/v1/a', 5000)], config);
    expect(thresholds.relative).toBe(false);
    expect(thresholds.highRatePerHour).toBe(config.highTrafficRatePerHour);
    expect(thresholds.lowRatePerHour).toBe(config.lowTrafficRatePerHour);
  });

  it('keeps the absolute thresholds when every endpoint reports the same rate', () => {
    const flat = Array.from({ length: 40 }, (_, i) => groupAtRate(`/api/v1/r${i}`, 500));
    expect(computeTrafficThresholds(flat, config).relative).toBe(false);
  });

  it('ignores endpoints with unknown traffic when computing percentiles', () => {
    const withUnknown = [
      ...busyZone(),
      ...Array.from({ length: 100 }, (_, i) =>
        makeGroup({
          normalizedPathPattern: `/api/v1/managed${i}`,
          members: [makeEp({ host: 'api.example.com', path: `/api/v1/managed${i}`, hits: null })],
        }),
      ),
    ];
    const thresholds = computeTrafficThresholds(withUnknown, config);
    expect(thresholds).toEqual(computeTrafficThresholds(busyZone(), config));
  });

  // The saturation this replaces: on a busy zone the absolute mark flags
  // everything, so `high-traffic-rate` stops carrying information.
  it('stops flagging every endpoint as high traffic on a busy zone', () => {
    const groups = busyZone();
    const absoluteFlagged = groups.filter((g) =>
      classifyGroup(g, config).signals.some((s) => s.id === 'high-traffic-rate'),
    );
    expect(absoluteFlagged).toHaveLength(groups.length);

    const thresholds = computeTrafficThresholds(groups, config);
    const relativeFlagged = groups.filter((g) =>
      classifyGroup(g, config, thresholds).signals.some((s) => s.id === 'high-traffic-rate'),
    );
    expect(relativeFlagged.length).toBeGreaterThan(0);
    expect(relativeFlagged.length).toBeLessThan(groups.length);
  });

  it('still flags the busiest endpoints, not an arbitrary subset', () => {
    const groups = busyZone();
    const thresholds = computeTrafficThresholds(groups, config);
    const flagged = groups.filter((g) =>
      classifyGroup(g, config, thresholds).signals.some((s) => s.id === 'high-traffic-rate'),
    );
    // The zone is built in ascending rate order, so the flagged set is its tail.
    expect(flagged).toEqual(groups.slice(groups.length - flagged.length));
  });

  it('names the zone in the signal detail when the threshold is relative', () => {
    const groups = busyZone();
    const thresholds = computeTrafficThresholds(groups, config);
    const busiest = classifyGroup(groups[groups.length - 1], config, thresholds);
    const signal = busiest.signals.find((s) => s.id === 'high-traffic-rate');
    expect(signal?.detail).toMatch(/of this zone/);
  });

  it('stops flagging the whole zone as low traffic on a quiet zone', () => {
    const quiet = Array.from({ length: 40 }, (_, i) => groupAtRate(`/api/v1/r${i}`, 0.01 + i * 0.01));
    const absolute = quiet.filter((g) => classifyGroup(g, config).flags.includes('low-traffic'));
    expect(absolute).toHaveLength(quiet.length);

    const thresholds = computeTrafficThresholds(quiet, config);
    const relative = quiet.filter((g) => classifyGroup(g, config, thresholds).flags.includes('low-traffic'));
    expect(relative.length).toBeLessThan(quiet.length);
  });

  it('rejects an inverted percentile pair', () => {
    expect(() =>
      validateScoringOverrides({ lowTrafficPercentile: 0.9, highTrafficPercentile: 0.2 }),
    ).toThrow(/lowTrafficPercentile/);
  });

  it('rejects a percentile outside the unit interval', () => {
    expect(() => validateScoringOverrides({ highTrafficPercentile: 12 })).toThrow(/highTrafficPercentile/);
  });

  // Regression coverage: `apiWeight`/`sensitivityWeight` are each validated to
  // lie in [0, 1] independently, but nothing previously checked they sum to 1.
  // `combined = apiWeight * api + sensitivityWeight * sensitivity` is
  // calibrated against `saveThreshold`/`ignoreThreshold` assuming the weights
  // sum to 1; an override that changes only one silently recalibrates what
  // "save" and "ignore" mean.
  it('rejects weights that do not sum to 1', () => {
    expect(() => validateScoringOverrides({ apiWeight: 0.9 })).toThrow(/apiWeight.*sensitivityWeight.*must sum to 1/);
  });

  it('accepts weights that do sum to 1', () => {
    expect(() => validateScoringOverrides({ apiWeight: 0.7, sensitivityWeight: 0.3 })).not.toThrow();
  });
});

describe('member traffic in the text report', () => {
  const bundleWithRate = () =>
    generateBundle(
      [
        classify(
          makeGroup({
            normalizedPathPattern: '/api/v1/items',
            normalizedHostPattern: 'api.example.com',
            members: [
              makeEp({
                host: 'api.example.com',
                path: '/api/v1/items',
                hits: null,
                features: { periodRequests: 3600, periodSeconds: 3600 },
              }),
            ],
          }),
        ),
      ],
      { zoneId: 'a'.repeat(32) },
    );

  // Regression: the member list inspected `hits` only, so in API mode — where
  // `hits` is always null — every endpoint was printed as unmeasured beside a
  // group summary that reported its rate.
  it('prints the rate for a member whose hits are unknown', () => {
    const text = formatBundleAsText(bundleWithRate());
    const memberLine = text.split('\n').find((l) => l.includes('GET api.example.com/api/v1/items  ('));
    expect(memberLine).toBeDefined();
    expect(memberLine).not.toContain('no traffic data');
    expect(memberLine).toMatch(/req\/hour/);
  });

  it('still says so when neither a count nor a rate is known', () => {
    const bundle = generateBundle(
      [
        classify(
          makeGroup({
            normalizedPathPattern: '/api/v1/managed',
            normalizedHostPattern: 'api.example.com',
            members: [makeEp({ host: 'api.example.com', path: '/api/v1/managed', hits: null })],
          }),
        ),
      ],
      { zoneId: 'a'.repeat(32) },
    );
    const text = formatBundleAsText(bundle);
    const memberLine = text.split('\n').find((l) => l.includes('GET api.example.com/api/v1/managed  ('));
    expect(memberLine).toContain('no traffic data');
  });
});

/**
 * Path vocabulary observed in the wild rather than invented for a test.
 *
 * These segments come from a live retail site's public `robots.txt`. They matter
 * because every other normalization test uses paths chosen by whoever wrote the
 * test, which can only confirm the cases already thought of. Real vocabulary is
 * the only thing that catches an allowlist gap.
 *
 * The literals are real. Where a case needs an identifier family alongside them,
 * the family is representative — the point of each case is that the real literal
 * survives contact with one.
 */
describe('observed real-world path vocabulary', () => {
  // Flattened compound words and camelCase run together look like opaque ids by
  // length alone. They are named endpoints and must stay literal.
  it.each([
    'getspinnerdatalarge',
    'vehiclehistoryreport',
    'carvanalocations',
    'post-sale-dashboard',
    'promotion-rules',
    'advanced-search',
  ])('keeps the observed segment %s literal', (segment) => {
    expect(isVariableSegment(segment)).toBe(false);
    expect(isHighCardinalitySegment(segment)).toBe(false);
  });

  // Regression: `/cars/filters` is a real path. Beside a word-shaped identifier
  // family it shares prefix, depth, continuation and coarse shape, so sibling
  // inference absorbed it into `/cars/{var1}` — hiding an operation and
  // misattributing its traffic to a group that does not exist.
  it.each(['filters', 'browse', 'compare', 'sort'])(
    'does not absorb the action segment %s into a word-shaped identifier family',
    (action) => {
      const paths = [
        '/cars/honda-civic',
        '/cars/toyota-camry',
        '/cars/ford-explorer',
        '/cars/mazda-miata',
        '/cars/subaru-outback',
        `/cars/${action}`,
      ];
      const inferred = inferSiblingVariables(paths);

      // The identifier family still collapses; only the action stays literal.
      expect([...(inferred.get('/cars/honda-civic') ?? [])]).toEqual([1]);
      expect([...(inferred.get(`/cars/${action}`) ?? [])]).toEqual([]);
    },
  );

  // A digit-bearing identifier family is separated by shape alone, with no
  // allowlist entry needed. This is what `segmentShape` buys.
  it('separates an action from a digit-bearing identifier family by shape', () => {
    const paths = [
      '/cars/2019-honda-civic-ex',
      '/cars/2020-toyota-camry-le',
      '/cars/2018-ford-f150-xlt',
      '/cars/2021-mazda-cx5-touring',
      '/cars/2017-bmw-330i-sport',
      '/cars/filters',
    ];
    const inferred = inferSiblingVariables(paths);
    expect([...(inferred.get('/cars/2019-honda-civic-ex') ?? [])]).toEqual([1]);
    expect([...(inferred.get('/cars/filters') ?? [])]).toEqual([]);
  });

  // Two siblings is below MIN_SIBLINGS_FOR_VARIABLE, so these stay split. The
  // case is recorded because both are plausible API endpoints: if a zone exposes
  // four or more of them under one prefix they would collapse, and this is the
  // shape of path where that would cost a real operation.
  it('leaves two same-shape siblings under one prefix alone', () => {
    const paths = ['/search/getspinnerdatalarge', '/search/vehiclehistoryreport'];
    const inferred = inferSiblingVariables(paths);
    for (const path of paths) {
      expect([...(inferred.get(path) ?? [])]).toEqual([]);
    }
  });
});
