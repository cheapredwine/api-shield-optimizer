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
} from '../classify.js';
import { rankValue, ShieldOptimizerAgent } from '../agent.js';
import { generateProposal, generateBundle } from '../proposal.js';
import { bundleToCsv } from '../export.js';
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
  const host = partial.normalizedHostPattern ?? 'api.example.com';
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

  it('uses content type to reject a rendered page on an API-looking path', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/api/docs',
        members: [
          makeEp({ path: '/api/docs', hits: 5000, host: 'www.example.com', contentTypes: ['text/html'] }),
        ],
      }),
    );
    expect(c.signals.map((s) => s.id)).toContain('page-content-type');
    expect(c.action).not.toBe('save');
  });

  it('uses sitemap membership to reject a web page', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/products/widgets',
        members: [makeEp({ path: '/products/widgets', hits: 8000, host: 'www.example.com', inSitemap: true })],
      }),
    );
    expect(c.signals.map((s) => s.id)).toContain('in-sitemap');
    expect(c.action).not.toBe('save');
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

  it('raises sensitivity for endpoints returning authorization failures', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/v1/records',
        members: [
          makeEp({ path: '/v1/records', hits: 1000, host: 'api.example.com', statusCodes: { '200': 800, '403': 200 } }),
        ],
      }),
    );
    expect(c.signals.map((s) => s.id)).toContain('access-controlled');
  });

  it('treats mostly-404 traffic as scanner noise', () => {
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/v1/unknown',
        members: [makeEp({ path: '/v1/unknown', hits: 1000, host: 'api.example.com', statusCodes: { '404': 990, '200': 10 } })],
      }),
    );
    expect(c.signals.map((s) => s.id)).toContain('mostly-not-found');
  });

  it('rewards REST method sets on the same path', () => {
    const single = classifyGroup(makeGroup({ normalizedPathPattern: '/v1/items', methodsOnPath: ['GET'] }));
    const multi = classifyGroup(
      makeGroup({ normalizedPathPattern: '/v1/items', methodsOnPath: ['GET', 'POST', 'DELETE'] }),
    );
    expect(multi.score.api).toBeGreaterThan(single.score.api);
  });

  it('never lets a single keyword hit alone force a save', () => {
    // Sensitive keyword on a path with no API evidence and an HTML response.
    const c = classifyGroup(
      makeGroup({
        normalizedPathPattern: '/admin',
        members: [makeEp({ path: '/admin', hits: 4, host: 'www.example.com', contentTypes: ['text/html'] })],
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
            contentTypes: ['application/json'],
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
    connectorConfig: { mode: 'snapshot', zoneId: 'a'.repeat(32) },
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
