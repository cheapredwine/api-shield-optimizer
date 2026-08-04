import type { ConnectorConfig, DataConnector, Endpoint, EndpointFeatures, Zone } from '../types.js';
import { assertCloudflareId, assertOptionalCloudflareId, parseDiscoveryStates } from '../validate.js';
import { canonicalizeHost } from '../normalize.js';

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** Hard ceiling on pagination so a misbehaving upstream cannot loop forever. */
const MAX_PAGES = 200;
const PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 250;

interface CloudflareListResponse<T> {
  success: boolean;
  result?: T[];
  errors?: { code?: number; message?: string }[];
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    count?: number;
  };
}

interface DiscoveryFeatures {
  thresholds?: {
    auth_id_tokens?: number;
    data_points?: number;
    suggested_threshold?: number;
    p50?: number;
    p90?: number;
    p99?: number;
    requests?: number;
    period_seconds?: number;
  };
  traffic_stats?: {
    requests?: number;
    period_seconds?: number;
  };
}

/** A managed or user label attached to an operation. */
interface OperationLabel {
  name?: string;
  source?: string;
}

interface DiscoveryOperation {
  id?: string;
  host?: string;
  method?: string;
  endpoint?: string;
  /**
   * Discovery provenance. The API returns `origin` as an array (e.g.
   * `["UnifiedDiscovery"]`); `source` is accepted as a legacy/snapshot form.
   */
  origin?: string[] | string;
  source?: string;
  /**
   * Legacy/optional field. The live discovery API reports traffic only as a
   * rate (`features.traffic_stats.requests` over `period_seconds`), never as
   * an absolute total — see "Response metadata is not available" and
   * "Traffic data" in AGENTS.md — so this is expected to be absent on every
   * real response and `hits` falls back to `null`. Accepted defensively in
   * case an older or non-standard response shape supplies it; do not depend
   * on it being populated.
   */
  total_requests?: number;
  /** The API returns `last_updated`; `last_seen` is accepted as a legacy form. */
  last_updated?: string;
  last_seen?: string;
  state?: string;
  features?: DiscoveryFeatures;
  labels?: OperationLabel[];
}

interface ManagedOperation {
  operation_id?: string;
  host?: string;
  method?: string;
  endpoint?: string;
  last_updated?: string;
  created_at?: string;
  features?: DiscoveryFeatures;
  labels?: OperationLabel[];
}

interface UserSchema {
  schema_id?: string;
  name?: string;
  validation_enabled?: boolean;
}

interface SchemaOperation {
  host?: string;
  method?: string;
  endpoint?: string;
}

interface CloudflareZone {
  id?: string;
  name?: string;
  account?: { id?: string };
  status?: string;
  plan?: { name?: string };
}

interface PaginatedResult<T> {
  items: T[];
  pagesFetched: number;
  truncated: boolean;
}

export interface EndpointFetchStats {
  discovery: { pagesFetched: number; operationCount: number; discarded: number; truncated: boolean };
  managed: { pagesFetched: number; operationCount: number; discarded: number; truncated: boolean };
  merged: { endpointCount: number };
  schemas?: { schemaCount: number; operationCount: number; truncated: boolean };
}

/** Validated credentials and identifiers for one run of requests. */
interface RequestScope {
  apiToken: string;
  zoneId: string;
  accountId?: string;
  states: string[];
  onWarning?: (message: string) => void;
}

/** One page-limited fetch plus the metadata the operator needs about it. */
interface OperationFetch {
  endpoints: Endpoint[];
  pagesFetched: number;
  discarded: number;
  truncated: boolean;
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

function normalizeMethod(method: string | undefined): string {
  return (method ?? 'GET').trim().toUpperCase();
}

/**
 * Hostnames are case-insensitive, but Cloudflare's `{hostVar1}` placeholders are
 * tokens. Lowercasing them produced `{hostvar1}` in every report.
 */
function normalizeHost(host: string | undefined): string {
  return canonicalizeHost(host ?? '');
}

function normalizePath(path: string | undefined): string {
  const p = (path ?? '/').trim();
  if (p.length === 0) return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * An operation is identified by host, method and path. A record missing any of
 * them is not a usable operation, and defaulting the gaps invents one:
 * `{host: '', method: 'GET', path: '/'}` looks plausible, groups with real
 * traffic, and can reach the export payload as an operation to save.
 */
function isUsableOperation(op: { host?: string; method?: string; endpoint?: string }): boolean {
  return (
    typeof op.host === 'string' &&
    canonicalizeHost(op.host).length > 0 &&
    typeof op.method === 'string' &&
    op.method.trim().length > 0 &&
    typeof op.endpoint === 'string' &&
    op.endpoint.trim().length > 0
  );
}

/**
 * A zone past the pagination cap is analysed on partial data, which is exactly
 * the situation where a missing endpoint matters most.
 */
function warnIfTruncated(
  result: { truncated: boolean; pagesFetched: number },
  label: string,
  onWarning?: (message: string) => void,
): void {
  if (!result.truncated) return;
  onWarning?.(
    `The ${label} operation list exceeded the ${MAX_PAGES}-page fetch cap ` +
      `(${MAX_PAGES * PER_PAGE} operations). Results are incomplete and any endpoint ` +
      'beyond the cap is missing from this analysis.',
  );
}

/** Drops unusable records, reporting how many rather than failing silently. */
function usableOperations<T extends { host?: string; method?: string; endpoint?: string }>(
  operations: T[],
  label: string,
  onWarning?: (message: string) => void,
): T[] {
  const usable = operations.filter(isUsableOperation);
  const discarded = operations.length - usable.length;
  if (discarded > 0) {
    onWarning?.(
      `Discarded ${discarded} malformed ${label} record(s) missing a host, method or path. ` +
        'They are not analysed and cannot appear in the export payload.',
    );
  }
  return usable;
}

function mapEndpointStatus(state: string | undefined): Endpoint['status'] {
  const normalized = (state ?? '').trim().toLowerCase();
  if (normalized === 'saved') return 'saved';
  if (normalized === 'ignored') return 'ignored';
  if (normalized === 'review' || normalized === 'candidate') return 'candidate';
  return undefined;
}

function mapDiscoverySource(source: string | undefined): Endpoint['source'] {
  const normalized = (source ?? '').trim().toLowerCase();
  if (normalized === 'machinelearning' || normalized === 'unifieddiscovery') return 'machinelearning';
  if (normalized === 'sessionidentifier') return 'sessionidentifier';
  if (normalized === 'manual') return 'manual';
  if (normalized === 'imported') return 'imported';
  return 'machinelearning';
}

/** The API returns `origin` as an array; older/snapshot shapes use `source`. */
function firstOrigin(op: { origin?: string[] | string; source?: string }): string | undefined {
  if (Array.isArray(op.origin)) return op.origin[0];
  if (typeof op.origin === 'string') return op.origin;
  return op.source;
}

/**
 * Extracts label names. Cloudflare's managed labels (`cf-web-page`,
 * `cf-api-endpoint`, `cf-log-in`, the `cf-risk-*` family) are the highest-value
 * signal available in API mode, so dropping them loses real information.
 */
function mapLabels(labels: OperationLabel[] | undefined): string[] | undefined {
  if (!Array.isArray(labels)) return undefined;
  const names = labels
    .map((l) => (typeof l?.name === 'string' ? l.name.trim().toLowerCase() : ''))
    .filter((n) => n.length > 0);
  return names.length > 0 ? [...new Set(names)].sort() : undefined;
}

function mapFeatures(features: DiscoveryFeatures | undefined): EndpointFeatures | undefined {
  if (!features) return undefined;
  const thresholds = features.thresholds;
  const traffic = features.traffic_stats;
  if (!thresholds && !traffic) return undefined;

  const mapped: EndpointFeatures = {
    authIdTokens: thresholds?.auth_id_tokens,
    dataPoints: thresholds?.data_points,
    suggestedThreshold: thresholds?.suggested_threshold,
    p50: thresholds?.p50,
    p90: thresholds?.p90,
    p99: thresholds?.p99,
    periodRequests: traffic?.requests ?? thresholds?.requests,
    periodSeconds: traffic?.period_seconds ?? thresholds?.period_seconds,
  };

  const hasAnyValue = Object.values(mapped).some((v) => v !== undefined);
  return hasAnyValue ? mapped : undefined;
}

/** Union of two label sets, preserving determinism. */
function mergeLabels(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  const merged = [...new Set([...(a ?? []), ...(b ?? [])])].sort();
  return merged.length > 0 ? merged : undefined;
}

/**
 * Adds two hit counts, preserving `null` for unknown.
 *
 * `null` means "not reported", not "zero". The discovery API never reports an
 * absolute count, so coercing to `0` here would stamp a measured-looking zero
 * onto every deduplicated operation and make `hasTrafficData` lie.
 */
function sumKnownHits(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Canonical key for matching the same operation across API surfaces. */
function shapeKey(host: string, method: string, path: string): string {
  return JSON.stringify([method.toUpperCase(), host.toLowerCase(), path]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CloudflareApiConnector implements DataConnector {
  async fetchEndpoints(config: ConnectorConfig): Promise<Endpoint[]> {
    const scope = this.resolveScope(config);

    const discovery = await this.fetchDiscoveryOperations(scope);
    const managed = await this.fetchManagedOperations(scope);
    const merged = this.mergeEndpoints(discovery.endpoints, managed.endpoints);

    if (config.useSchemas === false) return merged;

    const schemaShapes = await this.fetchSchemaShapes(scope);
    if (schemaShapes.size === 0) return merged;

    return merged.map((ep) =>
      schemaShapes.has(shapeKey(ep.host, ep.method, ep.path)) ? { ...ep, inSchema: true } : ep,
    );
  }

  async fetchEndpointStats(config: ConnectorConfig): Promise<EndpointFetchStats> {
    const scope = this.resolveScope(config);

    const discovery = await this.fetchDiscoveryOperations(scope);
    const managed = await this.fetchManagedOperations(scope);
    const merged = this.mergeEndpoints(discovery.endpoints, managed.endpoints);

    const stats: EndpointFetchStats = {
      discovery: {
        pagesFetched: discovery.pagesFetched,
        operationCount: discovery.endpoints.length,
        discarded: discovery.discarded,
        truncated: discovery.truncated,
      },
      managed: {
        pagesFetched: managed.pagesFetched,
        operationCount: managed.endpoints.length,
        discarded: managed.discarded,
        truncated: managed.truncated,
      },
      merged: {
        endpointCount: merged.length,
      },
    };

    if (config.useSchemas !== false) {
      stats.schemas = await this.fetchSchemaInfo(scope);
    }

    return stats;
  }

  /**
   * Validates and normalises credentials plus identifiers.
   *
   * Zone and account IDs are interpolated into API request paths, so they must
   * be validated here: `new URL()` resolves `..` segments, which would let an
   * unvalidated identifier redirect the request to an arbitrary Cloudflare API
   * endpoint using this token.
   *
   * The zone ID is validated before the token is checked, so a malformed zone
   * ID is reported as such rather than as a missing token — matching the CLI's
   * own resolution order (see `optionsAreSelfSufficient` in `cli.ts`), which a
   * direct library caller bypassing the CLI must still get right.
   */
  private resolveScope(config: ConnectorConfig): RequestScope {
    const zoneId = assertCloudflareId(config.zoneId, 'zoneId');
    if (!config.apiToken) {
      throw new Error('apiToken required for API mode');
    }
    return {
      apiToken: config.apiToken,
      zoneId,
      accountId: assertOptionalCloudflareId(config.accountId, 'accountId'),
      states: parseDiscoveryStates(config.state),
      onWarning: config.onWarning,
    };
  }

  /**
   * Merges discovery and managed views of the same operation instead of
   * dropping one. The managed record is authoritative for `saved` status; the
   * discovery record is authoritative for traffic volume.
   */
  private mergeEndpoints(discovery: Endpoint[], managed: Endpoint[]): Endpoint[] {
    const byShape = new Map<string, Endpoint>();

    for (const ep of discovery) {
      const key = shapeKey(ep.host, ep.method, ep.path);
      const existing = byShape.get(key);
      if (!existing) {
        byShape.set(key, ep);
        continue;
      }
      byShape.set(key, {
        ...existing,
        hits: sumKnownHits(existing.hits, ep.hits),
        features: existing.features ?? ep.features,
        status: existing.status ?? ep.status,
        labels: mergeLabels(existing.labels, ep.labels),
      });
    }

    for (const ep of managed) {
      const key = shapeKey(ep.host, ep.method, ep.path);
      const existing = byShape.get(key);
      if (!existing) {
        byShape.set(key, ep);
        continue;
      }
      // Managed presence proves the operation is saved, regardless of what the
      // discovery feed reports.
      byShape.set(key, {
        ...existing,
        id: existing.id,
        status: 'saved',
        source: existing.source === 'machinelearning' ? 'manual' : existing.source,
        features: existing.features ?? ep.features,
        labels: mergeLabels(existing.labels, ep.labels),
        rawReference: { discovery: existing.rawReference, managed: ep.rawReference },
      });
    }

    return [...byShape.values()];
  }

  private async fetchDiscoveryOperations(scope: RequestScope): Promise<OperationFetch> {
    const url = new URL(`${API_BASE}/zones/${scope.zoneId}/api_gateway/discovery/operations`);
    for (const state of scope.states) {
      url.searchParams.append('state', state);
    }

    const operations = await this.fetchPaginated<DiscoveryOperation>(url, scope.apiToken, true);
    warnIfTruncated(operations, 'discovery', scope.onWarning);
    const items = usableOperations(operations.items, 'discovery', scope.onWarning);

    return {
      pagesFetched: operations.pagesFetched,
      discarded: operations.items.length - items.length,
      truncated: operations.truncated,
      endpoints: items.map((op, idx) => ({
        id: op.id ?? `generated-${idx}`,
        accountId: scope.accountId ?? '',
        zoneId: scope.zoneId,
        host: normalizeHost(op.host),
        method: normalizeMethod(op.method),
        path: normalizePath(op.endpoint),
        source: mapDiscoverySource(firstOrigin(op)),
        hits: typeof op.total_requests === 'number' ? op.total_requests : null,
        // `last_updated` is the field the API actually returns. Falling back to
        // "now" made every endpoint look maximally fresh, which silently
        // inverted the staleness signal.
        lastSeenAt: op.last_updated ?? op.last_seen ?? '',
        status: mapEndpointStatus(op.state),
        features: mapFeatures(op.features),
        labels: mapLabels(op.labels),
        rawReference: op,
      })),
    };
  }

  private async fetchManagedOperations(scope: RequestScope): Promise<OperationFetch> {
    const url = new URL(`${API_BASE}/zones/${scope.zoneId}/api_gateway/operations`);
    const operations = await this.fetchPaginated<ManagedOperation>(url, scope.apiToken, false);
    warnIfTruncated(operations, 'managed', scope.onWarning);
    const items = usableOperations(operations.items, 'managed', scope.onWarning);

    return {
      pagesFetched: operations.pagesFetched,
      discarded: operations.items.length - items.length,
      truncated: operations.truncated,
      endpoints: items.map((op, idx) => ({
        id: op.operation_id ?? `managed-${idx}`,
        accountId: scope.accountId ?? '',
        zoneId: scope.zoneId,
        host: normalizeHost(op.host),
        method: normalizeMethod(op.method),
        path: normalizePath(op.endpoint),
        source: 'manual' as const,
        // Managed operations carry no traffic data. `null` means unknown;
        // reporting `0` would penalise already-saved production endpoints.
        hits: null,
        lastSeenAt: op.last_updated ?? op.created_at ?? '',
        status: 'saved' as const,
        features: mapFeatures(op.features),
        labels: mapLabels(op.labels),
        rawReference: op,
      })),
    };
  }

  /**
   * Fetches every uploaded schema and the operations it covers. Schema
   * membership is the highest-precision "this is a real API" signal available.
   * Failures are non-fatal: the signal is enrichment, not a requirement.
   *
   * Shared by `fetchSchemaShapes` and `fetchSchemaInfo` so both report the same
   * truncation state and neither re-fetches the schema list the other already
   * fetched.
   */
  private async fetchSchemaData(scope: {
    apiToken: string;
    zoneId: string;
    onWarning?: (message: string) => void;
  }): Promise<{ shapes: Set<string>; schemaCount: number; truncated: boolean }> {
    const shapes = new Set<string>();
    let schemaCount = 0;
    let truncated = false;

    try {
      const schemas = await this.fetchPaginated<UserSchema>(
        new URL(`${API_BASE}/zones/${scope.zoneId}/api_gateway/user_schemas`),
        scope.apiToken,
        true,
      );
      warnIfTruncated(schemas, 'schema', scope.onWarning);
      truncated = truncated || schemas.truncated;
      schemaCount = schemas.items.length;

      for (const schema of schemas.items) {
        if (!schema.schema_id) continue;
        const encoded = encodeURIComponent(schema.schema_id);
        const operations = await this.fetchPaginated<SchemaOperation>(
          new URL(`${API_BASE}/zones/${scope.zoneId}/api_gateway/user_schemas/${encoded}/operations`),
          scope.apiToken,
          true,
        );
        warnIfTruncated(operations, `schema ${schema.schema_id} operations`, scope.onWarning);
        truncated = truncated || operations.truncated;
        for (const op of operations.items) {
          shapes.add(shapeKey(normalizeHost(op.host), normalizeMethod(op.method), normalizePath(op.endpoint)));
        }
      }
    } catch {
      // Schema enrichment is optional; absence simply removes a signal.
      return { shapes, schemaCount, truncated };
    }
    return { shapes, schemaCount, truncated };
  }

  /** Returns the set of operation shapes covered by uploaded API schemas. */
  private async fetchSchemaShapes(scope: {
    apiToken: string;
    zoneId: string;
    onWarning?: (message: string) => void;
  }): Promise<Set<string>> {
    const { shapes } = await this.fetchSchemaData(scope);
    return shapes;
  }

  private async fetchSchemaInfo(scope: {
    apiToken: string;
    zoneId: string;
    onWarning?: (message: string) => void;
  }): Promise<{ schemaCount: number; operationCount: number; truncated: boolean }> {
    // No try/catch here: `fetchSchemaData` already swallows its own failures
    // and resolves normally (schema enrichment is optional), so it never
    // rejects. A wrapping catch here would be unreachable dead code.
    const { shapes, schemaCount, truncated } = await this.fetchSchemaData(scope);
    return { schemaCount, operationCount: shapes.size, truncated };
  }

  /** Counts operations already saved in the zone, for budget reporting. */
  async countSavedOperations(config: ConnectorConfig): Promise<number> {
    const scope = this.resolveScope(config);
    const managed = await this.fetchManagedOperations(scope);
    return managed.endpoints.length;
  }

  private async request(url: string, apiToken: string): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter.
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
        await sleep(delay);
      }

      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        // Retry transient failures only. 4xx other than 429 are terminal.
        if (response.status === 429 || response.status >= 500) {
          lastError = new CloudflareApiError(
            `Cloudflare API error: ${response.status} ${response.statusText}`,
            response.status,
          );
          continue;
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error('Cloudflare API request failed');
  }

  private async fetchPaginated<T>(
    baseUrl: URL,
    apiToken: string,
    suppress403404: boolean,
  ): Promise<PaginatedResult<T>> {
    const all: T[] = [];
    let page = 1;
    let pagesFetched = 0;
    let truncated = false;

    while (page <= MAX_PAGES) {
      const pageUrl = new URL(baseUrl.toString());
      pageUrl.searchParams.set('per_page', String(PER_PAGE));
      pageUrl.searchParams.set('page', String(page));

      const resp = await this.request(pageUrl.toString(), apiToken);

      if (!resp.ok) {
        if (suppress403404 && (resp.status === 403 || resp.status === 404)) {
          return { items: [], pagesFetched, truncated: false };
        }
        throw new CloudflareApiError(`Cloudflare API error: ${resp.status} ${resp.statusText}`, resp.status);
      }

      pagesFetched += 1;

      const json = (await resp.json()) as CloudflareListResponse<T>;
      if (!json.success) {
        const detail = json.errors?.map((e) => e.message).filter(Boolean).join('; ');
        throw new CloudflareApiError(
          detail ? `Cloudflare API returned unsuccessful response: ${detail}` : 'Cloudflare API returned unsuccessful response',
          resp.status,
        );
      }

      const pageResult = json.result ?? [];
      all.push(...pageResult);

      const totalPages = json.result_info?.total_pages;
      if (typeof totalPages === 'number' && totalPages > 0) {
        if (page >= totalPages) break;
        page += 1;
        continue;
      }

      if (pageResult.length < PER_PAGE) break;
      page += 1;
    }

    if (page > MAX_PAGES) {
      truncated = true;
    }

    return { items: all, pagesFetched, truncated };
  }

  async listZones(apiToken: string): Promise<Zone[]> {
    const url = new URL(`${API_BASE}/zones`);
    const zones = await this.fetchPaginated<CloudflareZone>(url, apiToken, false);

    return zones.items.map((z) => ({
      id: z.id ?? '',
      name: z.name ?? '',
      accountId: z.account?.id ?? '',
      status: z.status ?? '',
      plan: z.plan?.name ?? '',
    }));
  }
}
