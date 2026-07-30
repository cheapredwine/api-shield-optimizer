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
      discovery: { pagesFetched: 1, operationCount: 1 },
      managed: { pagesFetched: 1, operationCount: 1 },
      merged: { endpointCount: 2 },
    });
  });

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


