import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareApiConnector } from '../connectors/api.js';
import { SnapshotConnector } from '../connectors/snapshot.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('CloudflareApiConnector pagination and mapping', () => {
  it('paginates discovery + managed endpoints and normalizes fields', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      const page = parsed.searchParams.get('page');

      if (parsed.pathname.endsWith('/discovery/operations')) {
        if (page === '1') {
          expect(parsed.searchParams.getAll('state')).toEqual(['review', 'saved']);
          return jsonResponse({
            success: true,
            result_info: { page: 1, per_page: 100, total_pages: 2 },
            result: [
              {
                id: 'd-1',
                host: 'API.EXAMPLE.COM',
                method: 'get',
                endpoint: 'users/123',
                source: 'machinelearning',
                total_requests: 99,
                last_seen: '2026-07-20T00:00:00Z',
                state: 'review',
              },
            ],
          });
        }

        return jsonResponse({
          success: true,
          result_info: { page: 2, per_page: 100, total_pages: 2 },
          result: [
            {
              id: 'd-2',
              host: 'api.example.com',
              method: 'POST',
              endpoint: '/auth/login',
              source: 'sessionidentifier',
              total_requests: 200,
              last_seen: '2026-07-20T00:00:00Z',
              state: 'saved',
            },
          ],
        });
      }

      if (parsed.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [
            {
              operation_id: 'm-1',
              host: 'api.example.com',
              method: 'POST',
              endpoint: '/auth/login',
              last_updated: '2026-07-25T00:00:00Z',
            },
          ],
        });
      }

      throw new Error(`Unexpected URL in fetch mock: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const connector = new CloudflareApiConnector();
    const endpoints = await connector.fetchEndpoints({
      mode: 'api',
      apiToken: 'token',
      zoneId: 'zone',
      accountId: 'acct',
      state: 'review,saved',
    });

    // d-2 and m-1 share canonical shape; dedupe keeps first seen.
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0].host).toBe('api.example.com');
    expect(endpoints[0].method).toBe('GET');
    expect(endpoints[0].path).toBe('/users/123');
    expect(endpoints[0].status).toBe('candidate');
    expect(endpoints[1].status).toBe('saved');
  });

  it('paginates zone listing', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      const page = parsed.searchParams.get('page');

      if (page === '1') {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 2 },
          result: [{ id: 'z1', name: 'one.com', account: { id: 'a1' }, status: 'active', plan: { name: 'pro' } }],
        });
      }

      return jsonResponse({
        success: true,
        result_info: { page: 2, per_page: 100, total_pages: 2 },
        result: [{ id: 'z2', name: 'two.com', account: { id: 'a1' }, status: 'active', plan: { name: 'biz' } }],
      });
    });

    global.fetch = fetchMock as typeof fetch;

    const connector = new CloudflareApiConnector();
    const zones = await connector.listZones('token');
    expect(zones).toHaveLength(2);
    expect(zones[1].id).toBe('z2');
  });

  it('returns page-count stats for smoke validation', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      const page = parsed.searchParams.get('page');

      if (parsed.pathname.endsWith('/discovery/operations')) {
        if (page === '1') {
          return jsonResponse({
            success: true,
            result_info: { page: 1, per_page: 100, total_pages: 2 },
            result: [{ id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review' }],
          });
        }
        return jsonResponse({
          success: true,
          result_info: { page: 2, per_page: 100, total_pages: 2 },
          result: [{ id: 'd-2', host: 'api.example.com', method: 'GET', endpoint: '/b', state: 'saved' }],
        });
      }

      if (parsed.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ operation_id: 'm-1', host: 'api.example.com', method: 'POST', endpoint: '/c' }],
        });
      }

      throw new Error(`Unexpected URL in fetch mock: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const connector = new CloudflareApiConnector();
    const stats = await connector.fetchEndpointStats({
      mode: 'api',
      apiToken: 'token',
      zoneId: 'zone',
    });

    expect(stats.discovery.pagesFetched).toBe(2);
    expect(stats.discovery.operationCount).toBe(2);
    expect(stats.managed.pagesFetched).toBe(1);
    expect(stats.managed.operationCount).toBe(1);
    expect(stats.merged.endpointCount).toBe(3);
  });

  it('defaults discovery state filter to review,saved,ignored', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);

      if (parsed.pathname.endsWith('/discovery/operations')) {
        expect(parsed.searchParams.getAll('state')).toEqual(['review', 'saved', 'ignored']);
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [],
        });
      }

      if (parsed.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [],
        });
      }

      throw new Error(`Unexpected URL in fetch mock: ${url}`);
    });

    global.fetch = fetchMock as typeof fetch;

    const connector = new CloudflareApiConnector();
    await connector.fetchEndpoints({
      mode: 'api',
      apiToken: 'token',
      zoneId: 'zone',
      accountId: 'acct',
    });
  });
});

describe('SnapshotConnector validation', () => {
  it('rejects invalid endpoint payloads', async () => {
    const connector = new SnapshotConnector();
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');

    const filePath = path.join(os.tmpdir(), `bad-snapshot-${Date.now()}.json`);
    await fs.writeFile(filePath, JSON.stringify([{ not: 'endpoint' }]), 'utf-8');

    await expect(
      connector.fetchEndpoints({
        mode: 'snapshot',
        snapshotPath: filePath,
      }),
    ).rejects.toThrow(/invalid entries/i);
  });
});
