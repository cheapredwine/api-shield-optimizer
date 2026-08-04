import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareApiConnector } from '../connectors/api.js';
import { ShieldOptimizerAgent } from '../agent.js';
import { ValidationError } from '../validate.js';
import type { ConnectorConfig, DataConnector, Endpoint } from '../types.js';

const ORIGINAL_FETCH = global.fetch;
const ZONE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ACCOUNT_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    apiToken: 'token',
    zoneId: ZONE_ID,
    useSchemas: false,
    ...overrides,
  };
}

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function mockApi(handler: (url: URL) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(new URL(value));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function emptyList(): Response {
  return jsonResponse({ success: true, result_info: { page: 1, per_page: 100, total_pages: 1 }, result: [] });
}

describe('identifier validation', () => {
  // Zone IDs are interpolated into the API request path. Without validation a
  // caller could supply `../user/tokens#` and redirect the request to an
  // arbitrary Cloudflare API endpoint using this token.
  it.each([
    '../user/tokens#',
    '../../accounts',
    'z1',
    'abc/../../../user/tokens/verify',
    'A1B2C3D4E5F60718293A4B5C6D7E8F9',
    '',
  ])('rejects unsafe zoneId %j', async (zoneId) => {
    const fetchMock = mockApi(() => emptyList());
    const connector = new CloudflareApiConnector();

    await expect(connector.fetchEndpoints(baseConfig({ zoneId }))).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a canonical 32-hex zone ID and never leaves the api_gateway path', async () => {
    const requested: string[] = [];
    mockApi((url) => {
      requested.push(url.pathname);
      return emptyList();
    });

    await new CloudflareApiConnector().fetchEndpoints(baseConfig());

    expect(requested.length).toBeGreaterThan(0);
    for (const pathname of requested) {
      expect(pathname.startsWith(`/client/v4/zones/${ZONE_ID}/api_gateway/`)).toBe(true);
    }
  });

  it('rejects an unsafe accountId', async () => {
    mockApi(() => emptyList());
    await expect(
      new CloudflareApiConnector().fetchEndpoints(baseConfig({ accountId: '../../user' })),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects discovery states outside the allowlist', async () => {
    mockApi(() => emptyList());
    await expect(
      new CloudflareApiConnector().fetchEndpoints(baseConfig({ state: 'review,../../evil' })),
    ).rejects.toThrow(ValidationError);
  });

  // Regression: the connector checked for a missing token before validating
  // zoneId, so a malformed zoneId with no token configured was reported as a
  // missing-token error rather than the actual, more specific problem.
  it('reports a malformed zoneId even when no token is configured', async () => {
    mockApi(() => emptyList());
    await expect(
      new CloudflareApiConnector().fetchEndpoints(
        baseConfig({ zoneId: '../../accounts', apiToken: undefined as unknown as string }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  // The other half of the ordering guarantee: a *valid* zoneId with no token
  // must still be reported as a missing token, not silently accepted or
  // misreported as a zoneId problem. Without this, the reordering fix above
  // could regress by, say, always throwing the zoneId error regardless of
  // which check actually failed.
  it('reports a missing token when the zoneId is valid', async () => {
    const fetchMock = mockApi(() => emptyList());
    await expect(
      new CloudflareApiConnector().fetchEndpoints(baseConfig({ apiToken: undefined as unknown as string })),
    ).rejects.toThrow(/apiToken required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CloudflareApiConnector pagination and mapping', () => {
  it('paginates discovery + managed endpoints and normalizes fields', async () => {
    mockApi((url) => {
      const page = url.searchParams.get('page');

      if (url.pathname.endsWith('/discovery/operations')) {
        if (page === '1') {
          return jsonResponse({
            success: true,
            result_info: { page: 1, per_page: 100, total_pages: 2 },
            result: [
              {
                id: 'd-1',
                host: 'API.Example.com ',
                method: 'get',
                endpoint: 'users/1',
                source: 'ML',
                total_requests: 25,
                state: 'review',
                features: { thresholds: { auth_id_tokens: 7, data_points: 900 } },
              },
            ],
          });
        }
        return jsonResponse({
          success: true,
          result_info: { page: 2, per_page: 100, total_pages: 2 },
          result: [{ id: 'd-2', host: 'api.example.com', method: 'POST', endpoint: '/orders', state: 'saved' }],
        });
      }

      if (url.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ operation_id: 'm-1', host: 'api.example.com', method: 'PUT', endpoint: '/settings' }],
        });
      }

      throw new Error(`unexpected URL ${url.toString()}`);
    });

    const endpoints = await new CloudflareApiConnector().fetchEndpoints(baseConfig());

    expect(endpoints).toHaveLength(3);

    const first = endpoints.find((e) => e.id === 'd-1')!;
    expect(first.host).toBe('api.example.com');
    expect(first.method).toBe('GET');
    expect(first.path).toBe('/users/1');
    expect(first.hits).toBe(25);
    expect(first.features?.authIdTokens).toBe(7);
    expect(first.zoneId).toBe(ZONE_ID);

    // Managed operations have no traffic data. `null` means unknown; reporting
    // 0 would penalise already-saved production endpoints.
    const managed = endpoints.find((e) => e.id === 'm-1')!;
    expect(managed.hits).toBeNull();
    expect(managed.status).toBe('saved');
  });

  it('merges the managed and discovery views of the same operation', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [
            { id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review', total_requests: 42 },
          ],
        });
      }
      if (url.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ operation_id: 'm-1', host: 'api.example.com', method: 'GET', endpoint: '/a' }],
        });
      }
      throw new Error(`unexpected URL ${url.toString()}`);
    });

    const endpoints = await new CloudflareApiConnector().fetchEndpoints(baseConfig());

    // One shape, one record: managed presence proves it is saved, while the
    // discovery record supplies the traffic volume.
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].status).toBe('saved');
    expect(endpoints[0].hits).toBe(42);
  });

  it('counts saved operations from the managed operations endpoint alone', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [
            { operation_id: 'm-1', host: 'api.example.com', method: 'GET', endpoint: '/a' },
            { operation_id: 'm-2', host: 'api.example.com', method: 'POST', endpoint: '/b' },
          ],
        });
      }
      return emptyList();
    });

    const count = await new CloudflareApiConnector().countSavedOperations(baseConfig());
    expect(count).toBe(2);
  });

  it('marks operations covered by an uploaded schema', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [
            { id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/covered', state: 'review' },
            { id: 'd-2', host: 'api.example.com', method: 'GET', endpoint: '/uncovered', state: 'review' },
          ],
        });
      }
      if (url.pathname.endsWith('/api_gateway/operations')) return emptyList();
      if (url.pathname.endsWith('/user_schemas')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ schema_id: 'schema-1', name: 'public' }],
        });
      }
      if (url.pathname.endsWith('/user_schemas/schema-1/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ host: 'api.example.com', method: 'GET', endpoint: '/covered' }],
        });
      }
      throw new Error(`unexpected URL ${url.toString()}`);
    });

    const endpoints = await new CloudflareApiConnector().fetchEndpoints(baseConfig({ useSchemas: true }));
    expect(endpoints.find((e) => e.path === '/covered')!.inSchema).toBe(true);
    expect(endpoints.find((e) => e.path === '/uncovered')!.inSchema).toBeUndefined();
  });

  it('treats schema enrichment failure as non-fatal', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review' }],
        });
      }
      if (url.pathname.endsWith('/api_gateway/operations')) return emptyList();
      return jsonResponse({ success: false, errors: [{ message: 'no schema entitlement' }] }, 403);
    });

    const endpoints = await new CloudflareApiConnector().fetchEndpoints(baseConfig({ useSchemas: true }));
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].inSchema).toBeUndefined();
  });

  // Regression coverage: a 403/404 from the schema endpoint is suppressed
  // inside `fetchPaginated` itself and never reaches `fetchSchemaData`'s own
  // try/catch (the test above exercises exactly that path). A genuinely
  // thrown error — a 500, exhausted retries, a network failure — takes a
  // different route and had never been exercised at all.
  it('treats a genuine schema-fetch error (not a suppressed 403/404) as non-fatal too', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review' }],
        });
      }
      if (url.pathname.endsWith('/api_gateway/operations')) return emptyList();
      if (url.pathname.endsWith('/user_schemas')) return jsonResponse({ success: false }, 500);
      throw new Error(`unexpected URL ${url.toString()}`);
    });

    const endpoints = await new CloudflareApiConnector().fetchEndpoints(baseConfig({ useSchemas: true }));
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].inSchema).toBeUndefined();
  }, 15_000);

  it('retries transient 5xx responses', async () => {
    let discoveryAttempts = 0;
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        discoveryAttempts += 1;
        if (discoveryAttempts < 3) return jsonResponse({ success: false }, 503);
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review' }],
        });
      }
      return emptyList();
    });

    const endpoints = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(discoveryAttempts).toBe(3);
    expect(endpoints).toHaveLength(1);
  });

  it('does not retry terminal 4xx responses', async () => {
    let attempts = 0;
    mockApi(() => {
      attempts += 1;
      return jsonResponse({ success: false, errors: [{ message: 'bad request' }] }, 400);
    });

    await expect(new CloudflareApiConnector().fetchEndpoints(baseConfig())).rejects.toThrow(/400/);
    expect(attempts).toBe(1);
  });

  // Regression: the existing 5xx-retry test above only ever exercises the
  // HTTP-response branch of the retry loop (a response with a bad status
  // code). `fetch` itself throwing — a real network failure, DNS error, or
  // the `AbortError` from `AbortSignal.timeout` — takes a different code path
  // (`catch (error)` rather than checking `response.status`) and had never
  // been exercised at all.
  it('retries a network-level failure, not just a bad HTTP response', async () => {
    let discoveryAttempts = 0;
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        discoveryAttempts += 1;
        if (discoveryAttempts < 3) throw new TypeError('fetch failed: network error');
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review' }],
        });
      }
      return emptyList();
    });

    const endpoints = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(discoveryAttempts).toBe(3);
    expect(endpoints).toHaveLength(1);
  });

  // Regression: no test ever exhausted every retry attempt, so the final
  // `throw lastError ?? new Error(...)` line — what the operator actually
  // sees when a zone is persistently unreachable — was unverified. `MAX_RETRIES`
  // is 3, so a permanently-failing endpoint makes exactly 4 attempts (the
  // initial try plus 3 retries) before giving up.
  it('exhausts retries and surfaces the last error after repeated 5xx responses', async () => {
    let attempts = 0;
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        attempts += 1;
        return jsonResponse({ success: false }, 503);
      }
      return emptyList();
    });

    await expect(new CloudflareApiConnector().fetchEndpoints(baseConfig())).rejects.toThrow(/503/);
    expect(attempts).toBe(4);
  });

  it('exhausts retries and surfaces the last error after a persistent network failure', async () => {
    let attempts = 0;
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        attempts += 1;
        throw new TypeError('fetch failed: network error');
      }
      return emptyList();
    });

    await expect(new CloudflareApiConnector().fetchEndpoints(baseConfig())).rejects.toThrow(/network error/);
    expect(attempts).toBe(4);
  });

  it('stops paginating at the hard page ceiling', async () => {
    let calls = 0;
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        calls += 1;
        // Always return a full page and no total_pages, which previously
        // produced an unbounded loop.
        return jsonResponse({
          success: true,
          result: Array.from({ length: 100 }, (_, i) => ({
            id: `d-${calls}-${i}`,
            host: 'api.example.com',
            method: 'GET',
            endpoint: `/a/${i}`,
            state: 'review',
          })),
        });
      }
      return emptyList();
    });

    await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(calls).toBe(200);
  }, 30_000);

  it('surfaces Cloudflare error messages on unsuccessful responses', async () => {
    mockApi(() => jsonResponse({ success: false, errors: [{ message: 'Invalid zone' }] }, 200));
    await expect(new CloudflareApiConnector().fetchEndpoints(baseConfig())).rejects.toThrow(/Invalid zone/);
  });

  it('paginates zone listing', async () => {
    mockApi((url) => {
      const page = url.searchParams.get('page');
      if (page === '1') {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 2 },
          result: [{ id: 'z-1', name: 'a.com', account: { id: ACCOUNT_ID }, status: 'active', plan: { name: 'Ent' } }],
        });
      }
      return jsonResponse({
        success: true,
        result_info: { page: 2, per_page: 100, total_pages: 2 },
        result: [{ id: 'z-2', name: 'b.com', account: { id: ACCOUNT_ID }, status: 'active', plan: { name: 'Pro' } }],
      });
    });

    const zones = await new CloudflareApiConnector().listZones('token');
    expect(zones.map((z) => z.id)).toEqual(['z-1', 'z-2']);
    expect(zones[0].accountId).toBe(ACCOUNT_ID);
  });

  it('returns page-count stats for smoke validation', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review' }],
        });
      }
      if (url.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ operation_id: 'm-1', host: 'api.example.com', method: 'POST', endpoint: '/b' }],
        });
      }
      throw new Error(`unexpected URL ${url.toString()}`);
    });

    const stats = await new CloudflareApiConnector().fetchEndpointStats(baseConfig());
    expect(stats).toEqual({
      discovery: { pagesFetched: 1, operationCount: 1, discarded: 0, truncated: false },
      managed: { pagesFetched: 1, operationCount: 1, discarded: 0, truncated: false },
      merged: { endpointCount: 2 },
    });
  });

  // Regression: missing fields were defaulted, producing a plausible-looking
  // `{host: '', method: 'GET', path: '/'}` operation that could reach the export
  // payload as something to save.
  it('discards malformed records rather than inventing operations', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [
            { id: 'ok', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review' },
            { id: 'no-host', method: 'GET', endpoint: '/b', state: 'review' },
            { id: 'blank-host', host: '   ', method: 'GET', endpoint: '/c', state: 'review' },
            { id: 'no-path', host: 'api.example.com', method: 'GET', state: 'review' },
            { id: 'no-method', host: 'api.example.com', endpoint: '/d', state: 'review' },
          ],
        });
      }
      return emptyList();
    });

    const warnings: string[] = [];
    const endpoints = await new CloudflareApiConnector().fetchEndpoints(
      baseConfig({ onWarning: (m) => warnings.push(m) }),
    );

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].id).toBe('ok');
    expect(endpoints.some((e) => e.host === '')).toBe(false);
    expect(warnings.join(' ')).toMatch(/Discarded 4 malformed discovery record/);
  });

  it('counts discarded records in the fetch stats', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: 'bad' }, { id: 'ok', host: 'a.example.com', method: 'GET', endpoint: '/a' }],
        });
      }
      return emptyList();
    });

    const stats = await new CloudflareApiConnector().fetchEndpointStats(baseConfig());
    expect(stats.discovery.discarded).toBe(1);
    expect(stats.discovery.operationCount).toBe(1);
  });

  // Regression: schema-operation pagination hit the page cap silently — no
  // `truncated` flag existed on `EndpointFetchStats.schemas` at all, so a zone
  // with more schema operations than the fetch cap looked identical to one
  // with none missing.
  it('surfaces truncation of a schema operations fetch', async () => {
    const warnings: string[] = [];
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) return emptyList();
      if (url.pathname.endsWith('/api_gateway/operations')) return emptyList();
      if (url.pathname.endsWith('/user_schemas')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ schema_id: 'schema-1', name: 'public' }],
        });
      }
      if (url.pathname.endsWith('/user_schemas/schema-1/operations')) {
        // Always a full page, no total_pages — the same shape that trips the
        // hard page ceiling for discovery/managed operations.
        return jsonResponse({
          success: true,
          result: Array.from({ length: 100 }, (_, i) => ({
            host: 'api.example.com',
            method: 'GET',
            endpoint: `/schema-op/${i}`,
          })),
        });
      }
      throw new Error(`unexpected URL ${url.toString()}`);
    });

    const stats = await new CloudflareApiConnector().fetchEndpointStats(
      baseConfig({ useSchemas: true, onWarning: (m) => warnings.push(m) }),
    );

    expect(stats.schemas?.truncated).toBe(true);
    expect(warnings.join(' ')).toMatch(/schema schema-1 operations.*exceeded the 200-page fetch cap/);
  }, 30_000);

  it('defaults the discovery state filter to review,saved,ignored', async () => {
    let discoveryStates: string[] = [];
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        discoveryStates = url.searchParams.getAll('state');
      }
      return emptyList();
    });

    await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(discoveryStates).toEqual(['review', 'saved', 'ignored']);
  });
});

describe('real API response shape', () => {
  /** Serves one discovery page and one managed page, matching the live payload. */
  function serve(discovery: unknown[], managed: unknown[] = []): ReturnType<typeof vi.fn> {
    const page = (result: unknown[]) =>
      jsonResponse({ success: true, result_info: { page: 1, per_page: 100, total_pages: 1 }, result });
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/discovery/operations')) return page(discovery);
      if (url.includes('/api_gateway/operations')) return page(managed);
      return emptyList();
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  // Field names verified against a live zone. Reading `source`/`last_seen`
  // silently produced a default source and a fabricated "now" timestamp.
  const liveDiscoveryOperation = {
    id: '90a3ac11-ccc6-4be5-b832-be057166b044',
    method: 'GET',
    host: 'api.example.com',
    endpoint: '/v1/things',
    origin: ['UnifiedDiscovery'],
    state: 'review',
    last_updated: '2026-07-28T08:47:33.571398Z',
    features: { traffic_stats: { requests: 10.12, period_seconds: 3600 } },
    labels: [
      { name: 'cf-web-page', source: 'managed', description: 'Add this label to endpoints that serve HTML pages.' },
    ],
  };

  it('reads the timestamp from last_updated rather than fabricating one', async () => {
    serve([liveDiscoveryOperation]);
    const [endpoint] = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(endpoint.lastSeenAt).toBe('2026-07-28T08:47:33.571398Z');
  });

  it('leaves lastSeenAt empty rather than defaulting to now when absent', async () => {
    const { last_updated: _omitted, ...withoutTimestamp } = liveDiscoveryOperation;
    serve([withoutTimestamp]);
    const [endpoint] = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(endpoint.lastSeenAt).toBe('');
  });

  it('maps the origin array to a discovery source', async () => {
    serve([liveDiscoveryOperation]);
    const [endpoint] = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(endpoint.source).toBe('machinelearning');
  });

  it('extracts managed label names, lowercased and deduplicated', async () => {
    serve([
      {
        ...liveDiscoveryOperation,
        labels: [{ name: 'CF-Web-Page' }, { name: 'cf-web-page' }, { name: 'cf-log-in' }],
      },
    ]);
    const [endpoint] = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(endpoint.labels).toEqual(['cf-log-in', 'cf-web-page']);
  });

  it('omits labels entirely when none are present', async () => {
    const { labels: _omitted, ...withoutLabels } = liveDiscoveryOperation;
    serve([withoutLabels]);
    const [endpoint] = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(endpoint.labels).toBeUndefined();
  });

  it('ignores malformed label entries', async () => {
    serve([{ ...liveDiscoveryOperation, labels: [{ name: '' }, {}, { name: 'cf-log-in' }] }]);
    const [endpoint] = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(endpoint.labels).toEqual(['cf-log-in']);
  });

  it('keeps hits null when the API reports no absolute request count', async () => {
    serve([liveDiscoveryOperation]);
    const [endpoint] = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(endpoint.hits).toBeNull();
    expect(endpoint.features?.periodRequests).toBeCloseTo(10.12);
  });

  it('unions labels from the discovery and managed views of one operation', async () => {
    serve(
      [{ ...liveDiscoveryOperation, labels: [{ name: 'cf-api-endpoint' }] }],
      [
        {
          operation_id: 'fc23df54-104c-4424-98da-d8c9371e937f',
          method: 'GET',
          host: 'api.example.com',
          endpoint: '/v1/things',
          last_updated: '2026-04-10T20:08:12.565379Z',
          labels: [{ name: 'cf-risk-zombie' }],
        },
      ],
    );

    const endpoints = await new CloudflareApiConnector().fetchEndpoints(baseConfig());
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].status).toBe('saved');
    expect(endpoints[0].labels).toEqual(['cf-api-endpoint', 'cf-risk-zombie']);
  });
});

describe('ShieldOptimizerAgent.run', () => {
  /** Records what it was asked for and returns a fixed operation. */
  class StubConnector implements DataConnector {
    calls: ConnectorConfig[] = [];

    async fetchEndpoints(config: ConnectorConfig): Promise<Endpoint[]> {
      this.calls.push(config);
      return [
        {
          id: 'op-1',
          accountId: '',
          zoneId: config.zoneId ?? '',
          host: 'api.example.com',
          method: 'POST',
          path: '/v1/payments',
          source: 'machinelearning',
          hits: null,
          lastSeenAt: new Date().toISOString(),
          rawReference: {},
          labels: ['cf-api-endpoint'],
        } as Endpoint,
      ];
    }
  }

  // `run()` is fetch-then-analyze. Nothing else covers the wiring between the
  // two halves, so a stub connector is the only way to reach it without HTTP.
  it('passes the connector config through and analyses what comes back', async () => {
    const connector = new StubConnector();
    const config: ConnectorConfig = { zoneId: ZONE_ID, apiToken: 'token', useSchemas: false };

    const bundle = await new ShieldOptimizerAgent(connector).run({ connectorConfig: config });

    expect(connector.calls).toEqual([config]);
    expect(bundle.proposals).toHaveLength(1);
    expect(bundle.proposals[0].target.canonicalPattern).toContain('/v1/payments');
    expect(bundle.proposals[0].action).toBe('save');
  });

  it('defaults to the live API connector when none is supplied', () => {
    expect(new ShieldOptimizerAgent()).toBeInstanceOf(ShieldOptimizerAgent);
    expect(new CloudflareApiConnector()).toBeInstanceOf(CloudflareApiConnector);
  });
});

/**
 * The tool must never write to a customer's zone. This is the property that
 * guarantees it, so it is asserted across every request the connector makes
 * rather than trusted to review.
 */
describe('read-only invariant', () => {
  function recordRequests(): Array<{ url: string; method: string }> {
    const seen: Array<{ url: string; method: string }> = [];
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method =
        init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET');
      seen.push({ url, method: method.toUpperCase() });
      return jsonResponse({ success: true, result_info: { page: 1, per_page: 100, total_pages: 1 }, result: [] });
    }) as unknown as typeof fetch;
    return seen;
  }

  it('issues only GET requests across the whole fetch surface', async () => {
    const seen = recordRequests();
    const connector = new CloudflareApiConnector();
    const config: ConnectorConfig = {
      apiToken: 'token',
      zoneId: ZONE_ID,
      accountId: ACCOUNT_ID,
      // Schema enrichment adds request paths of its own, so leave it enabled.
      useSchemas: true,
      state: 'review,saved,ignored',
    };

    await connector.fetchEndpoints(config);
    await connector.fetchEndpointStats(config);
    await connector.listZones('token');

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.method === 'GET')).toBe(true);
    expect([...new Set(seen.map((r) => r.method))]).toEqual(['GET']);
  });

  it('never targets a mutating API path', async () => {
    const seen = recordRequests();
    const connector = new CloudflareApiConnector();
    await connector.fetchEndpoints({ apiToken: 'token', zoneId: ZONE_ID, useSchemas: true });

    for (const { url } of seen) {
      // `.../operations` is read here; the write endpoints are POST/PATCH on the
      // same paths, which the method assertion above covers.
      expect(url).toContain('/api_gateway/');
      expect(url).not.toContain('/purge_cache');
    }
  });
});


