import { ShieldOptimizerAgent } from './agent.js';
import { CloudflareApiConnector } from './connectors/api.js';
import type { ConnectorConfig } from './types.js';

interface WorkerEnv {
  CF_API_TOKEN?: string;
  WORKER_AUTH_TOKEN?: string;
  REQUIRE_CF_ACCESS?: string;
  ACCESS_AUD?: string;
  ACCESS_JWKS_URL?: string;
  ACCESS_ISSUER?: string;
  RBAC_RULES_JSON?: string;
}

interface ErrorPayload {
  error: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function textError(message: string, status: number): Response {
  return json({ error: message } satisfies ErrorPayload, status);
}

function parsePositiveInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseCommaList(value: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized.join(',') : undefined;
}

function isAuthorized(request: Request, env: WorkerEnv): boolean {
  if (!env.WORKER_AUTH_TOKEN) return true;
  const auth = request.headers.get('authorization');
  if (!auth) return false;
  const expected = `Bearer ${env.WORKER_AUTH_TOKEN}`;
  return auth === expected;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface AccessJwtPayload {
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  email?: string;
  groups?: string[];
}

type WorkerAction = 'smoke' | 'propose';

interface RuleSpec {
  accountIds?: string[];
  zoneIds?: string[];
  permissions?: string[];
}

interface RbacRules {
  defaultDeny?: boolean;
  users?: Record<string, RuleSpec>;
  groups?: Record<string, RuleSpec>;
}

interface NormalizedRule {
  accountIds: Set<string>;
  zoneIds: Set<string>;
  permissions: Set<string>;
}

interface ParsedRbac {
  defaultDeny: boolean;
  users: Map<string, NormalizedRule>;
  groups: Map<string, NormalizedRule>;
}

interface AccessPrincipal {
  email: string;
  groups: string[];
}

interface JwksDocument {
  keys?: AccessJwk[];
}

interface AccessJwk {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

type JsonWebKey = Record<string, unknown>;

const ACCESS_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const jwksCache = new Map<string, { expiresAt: number; keys: AccessJwk[] }>();
let rbacCache: { raw: string; parsed: ParsedRbac } | null = null;

function requiresCfAccess(env: WorkerEnv): boolean {
  if (!env.REQUIRE_CF_ACCESS) return true;
  const raw = env.REQUIRE_CF_ACCESS.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

function decodeBase64Url(input: string): Uint8Array | null {
  try {
    const padded = `${input}${'='.repeat((4 - (input.length % 4)) % 4)}`;
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(base64);
    return Uint8Array.from(decoded, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeBase64UrlJson<T>(input: string): T | null {
  const bytes = decodeBase64Url(input);
  if (!bytes) return null;
  try {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function parseJwt(token: string): {
  header: JwtHeader;
  payload: AccessJwtPayload;
  signingInput: Uint8Array;
  signature: Uint8Array;
} | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const header = decodeBase64UrlJson<JwtHeader>(parts[0]);
  const payload = decodeBase64UrlJson<AccessJwtPayload>(parts[1]);
  const signature = decodeBase64Url(parts[2]);

  if (!header || !payload || !signature) return null;

  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return { header, payload, signingInput, signature };
}

function hasValidTimeClaims(payload: AccessJwtPayload): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) return false;
  if (typeof payload.nbf === 'number' && now < payload.nbf) return false;
  if (typeof payload.iat === 'number' && payload.iat > now + 60) return false;
  return true;
}

function audMatches(payload: AccessJwtPayload, expectedAud: string): boolean {
  if (typeof payload.aud === 'string') return payload.aud === expectedAud;
  if (Array.isArray(payload.aud)) return payload.aud.includes(expectedAud);
  return false;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeRuleSpec(value: unknown): NormalizedRule | null {
  if (!value || typeof value !== 'object') return null;
  const spec = value as RuleSpec;
  return {
    accountIds: new Set(parseStringArray(spec.accountIds).map(normalizeId)),
    zoneIds: new Set(parseStringArray(spec.zoneIds).map(normalizeId)),
    permissions: new Set(parseStringArray(spec.permissions).map(normalizeId)),
  };
}

function parseRbacRules(raw: string): ParsedRbac {
  const parsedUnknown = JSON.parse(raw) as unknown;
  if (!parsedUnknown || typeof parsedUnknown !== 'object') {
    throw new Error('RBAC_RULES_JSON must be a JSON object');
  }

  const parsed = parsedUnknown as RbacRules;
  const users = new Map<string, NormalizedRule>();
  const groups = new Map<string, NormalizedRule>();

  const userEntries = parsed.users ?? {};
  for (const [email, ruleRaw] of Object.entries(userEntries)) {
    const normalized = normalizeRuleSpec(ruleRaw);
    if (normalized) {
      users.set(normalizeId(email), normalized);
    }
  }

  const groupEntries = parsed.groups ?? {};
  for (const [group, ruleRaw] of Object.entries(groupEntries)) {
    const normalized = normalizeRuleSpec(ruleRaw);
    if (normalized) {
      groups.set(normalizeId(group), normalized);
    }
  }

  return {
    defaultDeny: parsed.defaultDeny !== false,
    users,
    groups,
  };
}

function getParsedRbac(env: WorkerEnv): ParsedRbac {
  const raw = env.RBAC_RULES_JSON?.trim();
  if (!raw) {
    throw new Error('RBAC_RULES_JSON is required');
  }

  if (rbacCache && rbacCache.raw === raw) {
    return rbacCache.parsed;
  }

  const parsed = parseRbacRules(raw);
  rbacCache = { raw, parsed };
  return parsed;
}

function matchScope(allowed: Set<string>, requested: string | null): boolean {
  if (allowed.size === 0) return true;
  if (allowed.has('*')) return true;
  if (!requested) return false;
  return allowed.has(normalizeId(requested));
}

function allowsPermission(rule: NormalizedRule, action: WorkerAction): boolean {
  if (rule.permissions.size === 0) return false;
  return rule.permissions.has('*') || rule.permissions.has(action);
}

function evaluateRule(rule: NormalizedRule, action: WorkerAction, url: URL): boolean {
  if (!allowsPermission(rule, action)) return false;
  if (!matchScope(rule.zoneIds, url.searchParams.get('zoneId'))) return false;
  if (!matchScope(rule.accountIds, url.searchParams.get('accountId'))) return false;
  return true;
}

function isActionAllowed(principal: AccessPrincipal, action: WorkerAction, url: URL, env: WorkerEnv): boolean {
  const rbac = getParsedRbac(env);
  const candidateRules: NormalizedRule[] = [];

  const userRule = rbac.users.get(normalizeId(principal.email));
  if (userRule) candidateRules.push(userRule);

  for (const group of principal.groups) {
    const groupRule = rbac.groups.get(normalizeId(group));
    if (groupRule) candidateRules.push(groupRule);
  }

  for (const rule of candidateRules) {
    if (evaluateRule(rule, action, url)) return true;
  }

  return rbac.defaultDeny ? false : candidateRules.length > 0;
}

async function getJwks(jwksUrl: string): Promise<AccessJwk[]> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const resp = await fetch(jwksUrl, {
    headers: { 'cache-control': 'no-cache' },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch access certs: ${resp.status}`);
  }

  const doc = (await resp.json()) as JwksDocument;
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) {
    throw new Error('No signing keys returned from Access certs endpoint');
  }

  jwksCache.set(jwksUrl, {
    keys: doc.keys,
    expiresAt: Date.now() + ACCESS_JWKS_CACHE_TTL_MS,
  });

  return doc.keys;
}

async function verifyJwtSignature(token: string, jwksUrl: string): Promise<AccessJwtPayload | null> {
  const parsed = parseJwt(token);
  if (!parsed) return null;

  if (parsed.header.alg !== 'RS256') {
    return null;
  }

  const jwks = await getJwks(jwksUrl);
  const candidates = jwks.filter((jwk) => {
    if (!jwk.kty || jwk.kty !== 'RSA') return false;
    if (parsed.header.kid && jwk.kid && parsed.header.kid !== jwk.kid) return false;
    if (jwk.use && jwk.use !== 'sig') return false;
    return true;
  });

  for (const jwk of candidates) {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk as unknown as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      parsed.signature,
      parsed.signingInput,
    );

    if (ok) {
      return parsed.payload;
    }
  }

  return null;
}

async function authenticateAccess(request: Request, env: WorkerEnv): Promise<AccessPrincipal | null> {
  if (!requiresCfAccess(env)) return { email: 'local-dev', groups: [] };

  const email = request.headers.get('cf-access-authenticated-user-email')?.trim();
  const jwt = request.headers.get('cf-access-jwt-assertion')?.trim();
  if (!email || !email.includes('@') || !jwt) return null;

  const accessAud = env.ACCESS_AUD?.trim();
  const jwksUrl = env.ACCESS_JWKS_URL?.trim();
  const issuer = env.ACCESS_ISSUER?.trim();
  if (!accessAud || !jwksUrl || !issuer) {
    throw new Error('Access configuration missing: ACCESS_AUD, ACCESS_JWKS_URL, and ACCESS_ISSUER are required');
  }

  const payload = await verifyJwtSignature(jwt, jwksUrl);
  if (!payload) return null;
  if (!hasValidTimeClaims(payload)) return null;
  if (!audMatches(payload, accessAud)) return null;

  if (payload.iss !== issuer) return null;

  if (typeof payload.email === 'string' && payload.email.trim() !== '') {
    if (payload.email.trim().toLowerCase() !== email.toLowerCase()) return null;
    return {
      email: payload.email.trim().toLowerCase(),
      groups: parseStringArray(payload.groups).map(normalizeId),
    };
  }

  return {
    email: email.toLowerCase(),
    groups: parseStringArray(payload.groups).map(normalizeId),
  };
}

function getConfigFromRequest(url: URL, env: WorkerEnv): ConnectorConfig | Response {
  const apiToken = env.CF_API_TOKEN;
  if (!apiToken) {
    return textError('Worker secret CF_API_TOKEN is required', 500);
  }

  const zoneId = url.searchParams.get('zoneId')?.trim();
  if (!zoneId) {
    return textError('zoneId query parameter is required', 400);
  }

  return {
    mode: 'api',
    apiToken,
    zoneId,
    accountId: url.searchParams.get('accountId')?.trim() || undefined,
    state: parseCommaList(url.searchParams.get('state')),
  };
}

async function handlePropose(url: URL, env: WorkerEnv): Promise<Response> {
  const connectorConfig = getConfigFromRequest(url, env);
  if (connectorConfig instanceof Response) return connectorConfig;

  const agent = new ShieldOptimizerAgent();
  const bundle = await agent.run({
    connectorConfig,
    minHits: parsePositiveInt(url.searchParams.get('minHits')),
    maxGroups: parsePositiveInt(url.searchParams.get('maxGroups')),
  });

  return json(bundle);
}

async function handleSmokeFetch(url: URL, env: WorkerEnv): Promise<Response> {
  const connectorConfig = getConfigFromRequest(url, env);
  if (connectorConfig instanceof Response) return connectorConfig;

  const connector = new CloudflareApiConnector();
  const stats = await connector.fetchEndpointStats(connectorConfig);
  return json(stats);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      const principal = await authenticateAccess(request, env);
      if (!principal) {
        return textError('access authentication required', 401);
      }

      if (!isAuthorized(request, env)) {
        return textError('unauthorized', 401);
      }

      const url = new URL(request.url);
      if (request.method !== 'GET') {
        return textError('method not allowed', 405);
      }

      if (url.pathname === '/health') {
        return json({ ok: true });
      }

      if (url.pathname === '/smoke-fetch') {
        if (!isActionAllowed(principal, 'smoke', url, env)) {
          return textError('forbidden', 403);
        }
        return handleSmokeFetch(url, env);
      }

      if (url.pathname === '/propose') {
        if (!isActionAllowed(principal, 'propose', url, env)) {
          return textError('forbidden', 403);
        }
        return handlePropose(url, env);
      }

      return textError('not found', 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      return textError(message, 500);
    }
  },
};
