import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../worker.js';

interface WorkerEnv {
  CF_API_TOKEN?: string;
  WORKER_AUTH_TOKEN?: string;
  REQUIRE_CF_ACCESS?: string;
  ACCESS_AUD?: string;
  ACCESS_JWKS_URL?: string;
  ACCESS_ISSUER?: string;
  RBAC_RULES_JSON?: string;
}

interface AccessJwk {
  kty?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ORIGINAL_FETCH = global.fetch;
const ACCESS_AUD = 'test-aud';
const ACCESS_ISSUER = 'https://team.cloudflareaccess.com';
const ACCESS_JWKS_URL = 'https://team.cloudflareaccess.com/cdn-cgi/access/certs';

let accessPublicJwk: AccessJwk;
let accessPrivateKeyPem = '';

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  accessPublicJwk = {
    ...(publicKey.export({ format: 'jwk' }) as AccessJwk),
    kid: 'test-kid',
    alg: 'RS256',
    use: 'sig',
  };
  accessPrivateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function makeAccessJwt(
  overrides?: Partial<{ aud: string; iss: string; email: string; exp: number; groups: string[] }>,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: overrides?.aud ?? ACCESS_AUD,
    iss: overrides?.iss ?? ACCESS_ISSUER,
    email: overrides?.email ?? 'user@example.com',
    groups: overrides?.groups ?? ['api-shield-users'],
    iat: now - 5,
    nbf: now - 5,
    exp: overrides?.exp ?? now + 300,
  };

  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-kid' };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf-8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(accessPrivateKeyPem).toString('base64url');

  return `${signingInput}.${signature}`;
}

function accessHeaders(jwt?: string): Record<string, string> {
  return {
    'cf-access-authenticated-user-email': 'user@example.com',
    'cf-access-jwt-assertion': jwt ?? makeAccessJwt(),
  };
}

function withAccessEnv(overrides?: Partial<WorkerEnv>): WorkerEnv {
  return {
    ACCESS_AUD,
    ACCESS_ISSUER,
    ACCESS_JWKS_URL,
    RBAC_RULES_JSON: JSON.stringify({
      defaultDeny: true,
      users: {
        'user@example.com': {
          permissions: ['smoke', 'propose'],
          zoneIds: ['z1'],
        },
      },
    }),
    ...overrides,
  };
}

function mockFetchWithJwks(apiHandler?: (url: URL) => Response): void {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const urlValue = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(urlValue);

    if (parsed.toString() === ACCESS_JWKS_URL) {
      return jsonResponse({ keys: [accessPublicJwk] });
    }

    if (apiHandler) {
      return apiHandler(parsed);
    }

    throw new Error(`unexpected URL ${urlValue}`);
  });

  global.fetch = fetchMock as typeof fetch;
}

describe('worker routing and access verification', () => {
  it('serves health route with valid Access JWT', async () => {
    mockFetchWithJwks();

    const response = await worker.fetch(
      new Request('https://example.test/health', { headers: accessHeaders() }),
      withAccessEnv(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('enforces Access headers by default', async () => {
    const response = await worker.fetch(new Request('https://example.test/health'), withAccessEnv());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'access authentication required' });
  });

  it('rejects wrong access aud claim', async () => {
    mockFetchWithJwks();
    const response = await worker.fetch(
      new Request('https://example.test/health', { headers: accessHeaders(makeAccessJwt({ aud: 'wrong-aud' })) }),
      withAccessEnv(),
    );
    expect(response.status).toBe(401);
  });

  it('rejects invalid signature', async () => {
    mockFetchWithJwks();
    const parts = makeAccessJwt().split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        aud: ACCESS_AUD,
        iss: ACCESS_ISSUER,
        email: 'attacker@example.com',
        iat: Math.floor(Date.now() / 1000) - 5,
        nbf: Math.floor(Date.now() / 1000) - 5,
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
      'utf-8',
    ).toString('base64url');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const response = await worker.fetch(
      new Request('https://example.test/health', { headers: accessHeaders(tampered) }),
      withAccessEnv(),
    );
    expect(response.status).toBe(401);
  });

  it('rejects expired token', async () => {
    mockFetchWithJwks();
    const expired = makeAccessJwt({ exp: Math.floor(Date.now() / 1000) - 10 });
    const response = await worker.fetch(
      new Request('https://example.test/health', { headers: accessHeaders(expired) }),
      withAccessEnv(),
    );
    expect(response.status).toBe(401);
  });

  it('can disable access guard explicitly for local dev', async () => {
    const env = withAccessEnv({ REQUIRE_CF_ACCESS: '0' });
    const response = await worker.fetch(new Request('https://example.test/health'), env);
    expect(response.status).toBe(200);
  });

  it('requires ACCESS_ISSUER when access guard enabled', async () => {
    mockFetchWithJwks();
    const env = withAccessEnv({ ACCESS_ISSUER: '' });
    const response = await worker.fetch(
      new Request('https://example.test/health', { headers: accessHeaders() }),
      env,
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Access configuration missing: ACCESS_AUD, ACCESS_JWKS_URL, and ACCESS_ISSUER are required',
    });
  });
});

describe('worker smoke and propose routes', () => {
  it('requires CF_API_TOKEN secret for smoke route', async () => {
    mockFetchWithJwks();
    const response = await worker.fetch(
      new Request('https://example.test/smoke-fetch?zoneId=z1', { headers: accessHeaders() }),
      withAccessEnv(),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Worker secret CF_API_TOKEN is required' });
  });

  it('returns smoke-fetch pagination stats', async () => {
    mockFetchWithJwks((parsed) => {
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

      throw new Error(`unexpected URL ${parsed.toString()}`);
    });

    const env = withAccessEnv({ CF_API_TOKEN: 'token' });
    const response = await worker.fetch(
      new Request('https://example.test/smoke-fetch?zoneId=z1&state=review,saved', { headers: accessHeaders() }),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      discovery: { pagesFetched: 2, operationCount: 2 },
      managed: { pagesFetched: 1, operationCount: 1 },
      merged: { endpointCount: 3 },
    });
  });

  it('returns proposal bundle json', async () => {
    mockFetchWithJwks((parsed) => {
      if (parsed.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [
            {
              id: 'd-1',
              host: 'api.example.com',
              method: 'POST',
              endpoint: '/auth/login',
              source: 'ML',
              total_requests: 25000,
              last_seen: new Date().toISOString(),
              state: 'review',
            },
          ],
        });
      }

      if (parsed.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [],
        });
      }

      throw new Error(`unexpected URL ${parsed.toString()}`);
    });

    const env = withAccessEnv({ CF_API_TOKEN: 'token' });
    const response = await worker.fetch(
      new Request('https://example.test/propose?zoneId=z1&minHits=10', { headers: accessHeaders() }),
      env,
    );
    expect(response.status).toBe(200);

    const bundle = (await response.json()) as {
      summary: { saveCount: number };
      scope: { groupCount: number };
    };
    expect(bundle.summary.saveCount).toBe(1);
    expect(bundle.scope.groupCount).toBe(1);
  });

  it('denies propose without permission', async () => {
    mockFetchWithJwks((parsed) => {
      if (parsed.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({ success: true, result_info: { page: 1, per_page: 100, total_pages: 1 }, result: [] });
      }
      if (parsed.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({ success: true, result_info: { page: 1, per_page: 100, total_pages: 1 }, result: [] });
      }
      throw new Error(`unexpected URL ${parsed.toString()}`);
    });

    const env = withAccessEnv({
      CF_API_TOKEN: 'token',
      RBAC_RULES_JSON: JSON.stringify({
        defaultDeny: true,
        users: {
          'user@example.com': { permissions: ['smoke'], zoneIds: ['z1'] },
        },
      }),
    });

    const response = await worker.fetch(
      new Request('https://example.test/propose?zoneId=z1', { headers: accessHeaders() }),
      env,
    );
    expect(response.status).toBe(403);
  });

  it('denies request outside allowed zone', async () => {
    mockFetchWithJwks((parsed) => {
      if (parsed.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({ success: true, result_info: { page: 1, per_page: 100, total_pages: 1 }, result: [] });
      }
      if (parsed.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({ success: true, result_info: { page: 1, per_page: 100, total_pages: 1 }, result: [] });
      }
      throw new Error(`unexpected URL ${parsed.toString()}`);
    });

    const env = withAccessEnv({ CF_API_TOKEN: 'token' });
    const response = await worker.fetch(
      new Request('https://example.test/smoke-fetch?zoneId=z999', { headers: accessHeaders() }),
      env,
    );
    expect(response.status).toBe(403);
  });

  it('allows request through group rule', async () => {
    mockFetchWithJwks((parsed) => {
      if (parsed.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review' }],
        });
      }
      if (parsed.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({ success: true, result_info: { page: 1, per_page: 100, total_pages: 1 }, result: [] });
      }
      throw new Error(`unexpected URL ${parsed.toString()}`);
    });

    const env = withAccessEnv({
      CF_API_TOKEN: 'token',
      RBAC_RULES_JSON: JSON.stringify({
        defaultDeny: true,
        groups: {
          'api-shield-users': { permissions: ['smoke'], zoneIds: ['z-group'] },
        },
      }),
    });

    const response = await worker.fetch(
      new Request('https://example.test/smoke-fetch?zoneId=z-group', {
        headers: accessHeaders(makeAccessJwt({ groups: ['api-shield-users'] })),
      }),
      env,
    );
    expect(response.status).toBe(200);
  });
});
