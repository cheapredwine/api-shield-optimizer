import { describe, it, expect } from 'vitest';
import { isVariableSegment, normalizePath, normalizeHost, groupEndpoints } from '../normalize.js';
import { classifyGroup } from '../classify.js';
import { generateProposal, generateBundle } from '../proposal.js';
import type { Endpoint, NormalizedGroup } from '../types.js';

function makeEp(partial: Partial<Endpoint> & { path: string; host: string }): Endpoint {
  return {
    id: 'x',
    accountId: 'a',
    zoneId: 'z',
    method: 'GET',
    source: 'machinelearning',
    hits: 100,
    lastSeenAt: '2026-07-28T00:00:00Z',
    rawReference: {},
    ...partial,
  } as Endpoint;
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
  it('rejects plain words', () => {
    expect(isVariableSegment('users')).toBe(false);
  });
});

describe('normalizePath', () => {
  it('collapses numeric IDs', () => {
    const r = normalizePath('/api/v1/users/123');
    expect(r.pattern).toBe('/api/v1/users/{var1}');
    expect(r.varCount).toBe(1);
  });
  it('collapses UUIDs', () => {
    const r = normalizePath('/orders/ab12cd34-ef56-7890-ab12-cd34ef567890');
    expect(r.pattern).toBe('/orders/{var1}');
  });
  it('preserves static paths', () => {
    const r = normalizePath('/health');
    expect(r.pattern).toBe('/health');
    expect(r.varCount).toBe(0);
  });
});

describe('normalizeHost', () => {
  it('returns single host unchanged', () => {
    const r = normalizeHost(['api.example.com']);
    expect(r.pattern).toBe('api.example.com');
    expect(r.canCollapse).toBe(true);
  });
  it('collapses single differing label', () => {
    const r = normalizeHost(['us-api.example.com', 'de-api.example.com', 'fr-api.example.com']);
    expect(r.pattern).toBe('{hostVar1}.example.com');
    expect(r.canCollapse).toBe(true);
  });
  it('refuses multi-label differences', () => {
    const r = normalizeHost(['a.b.example.com', 'c.d.example.com']);
    expect(r.pattern).toBe('a.b.example.com');
    expect(r.canCollapse).toBe(false);
  });
  it('refuses variable-depth subdomains', () => {
    const r = normalizeHost(['api.example.com', 'foo.bar.example.com']);
    expect(r.pattern).toBe('api.example.com');
    expect(r.canCollapse).toBe(false);
  });
});

describe('groupEndpoints', () => {
  it('groups identical paths', () => {
    const eps = [
      makeEp({ id: '1', path: '/users/123', host: 'api.example.com' }),
      makeEp({ id: '2', path: '/users/456', host: 'api.example.com' }),
    ];
    const groups = groupEndpoints(eps);
    expect(groups.length).toBe(1);
    expect(groups[0].members.length).toBe(2);
    expect(groups[0].normalizedPathPattern).toBe('/users/{var1}');
  });

  it('separates different methods', () => {
    const eps = [
      makeEp({ id: '1', path: '/users', method: 'GET', host: 'api.example.com' }),
      makeEp({ id: '2', path: '/users', method: 'POST', host: 'api.example.com' }),
    ];
    const groups = groupEndpoints(eps);
    expect(groups.length).toBe(2);
  });
});

describe('classifyGroup', () => {
  it('recommends save for auth paths', () => {
    const group: NormalizedGroup = {
      groupId: 'g1',
      normalizedHostPattern: 'api.example.com',
      normalizedPathPattern: '/auth/login',
      method: 'POST',
      members: [makeEp({ path: '/auth/login', hits: 10000, host: 'api.example.com' })],
      recommendedAction: 'manual_review',
      confidence: 0.5,
      reasoning: [],
      flags: [],
    };
    const c = classifyGroup(group);
    expect(c.action).toBe('save');
    expect(c.confidence).toBeGreaterThan(0.7);
  });

  it('recommends ignore for health paths', () => {
    const group: NormalizedGroup = {
      groupId: 'g2',
      normalizedHostPattern: 'api.example.com',
      normalizedPathPattern: '/health',
      method: 'GET',
      members: [makeEp({ path: '/health', hits: 5, host: 'api.example.com' })],
      recommendedAction: 'manual_review',
      confidence: 0.5,
      reasoning: [],
      flags: [],
    };
    const c = classifyGroup(group);
    expect(c.action).toBe('ignore');
  });
});

describe('generateProposal', () => {
  it('produces a well-formed proposal', () => {
    const group: NormalizedGroup = {
      groupId: 'g1',
      normalizedHostPattern: 'api.example.com',
      normalizedPathPattern: '/users/{var1}',
      method: 'GET',
      members: [makeEp({ path: '/users/1', host: 'api.example.com' })],
      recommendedAction: 'save',
      confidence: 0.85,
      reasoning: ['high traffic'],
      flags: [],
    };
    const p = generateProposal(group);
    expect(p.action).toBe('save');
    expect(p.target.membersCount).toBe(1);
    expect(p.whyThisGroupingIsSafe.length).toBeGreaterThan(0);
    expect(p.whyThisGroupingIsUseful.length).toBeGreaterThan(0);
    expect(p.whyItMayBeWrong.length).toBeGreaterThan(0);
  });
});

describe('generateBundle', () => {
  it('counts actions correctly', () => {
    const groups: NormalizedGroup[] = [
      {
        groupId: 'g1',
        normalizedHostPattern: 'api.example.com',
        normalizedPathPattern: '/auth',
        method: 'POST',
        members: [makeEp({ path: '/auth', host: 'api.example.com' })],
        recommendedAction: 'save',
        confidence: 0.9,
        reasoning: [],
        flags: [],
      },
      {
        groupId: 'g2',
        normalizedHostPattern: 'api.example.com',
        normalizedPathPattern: '/health',
        method: 'GET',
        members: [makeEp({ path: '/health', host: 'api.example.com' })],
        recommendedAction: 'ignore',
        confidence: 0.8,
        reasoning: [],
        flags: [],
      },
    ];
    const bundle = generateBundle(groups);
    expect(bundle.summary.saveCount).toBe(1);
    expect(bundle.summary.ignoreCount).toBe(1);
    expect(bundle.summary.manualReviewCount).toBe(0);
    expect(bundle.proposals.length).toBe(2);
  });
});
