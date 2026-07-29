import type { ConnectorConfig, DataConnector, Endpoint, Zone } from '../types.js';

interface CloudflareListResponse<T> {
  success: boolean;
  result?: T[];
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    count?: number;
  };
}

interface DiscoveryOperation {
  id?: string;
  host?: string;
  method?: string;
  endpoint?: string;
  source?: string;
  total_requests?: number;
  last_seen?: string;
  state?: string;
  features?: Record<string, unknown>;
}

interface ManagedOperation {
  operation_id?: string;
  host?: string;
  method?: string;
  endpoint?: string;
  last_updated?: string;
  created_at?: string;
}

interface CloudflareZone {
  id?: string;
  name?: string;
  account?: { id?: string };
  status?: string;
  plan?: { name?: string };
}

const DEFAULT_DISCOVERY_STATES = ['review', 'saved', 'ignored'] as const;

interface PaginatedResult<T> {
  items: T[];
  pagesFetched: number;
}

export interface EndpointFetchStats {
  discovery: { pagesFetched: number; operationCount: number };
  managed: { pagesFetched: number; operationCount: number };
  merged: { endpointCount: number };
}

function normalizeMethod(method: string | undefined): string {
  return (method ?? 'GET').trim().toUpperCase();
}

function normalizeHost(host: string | undefined): string {
  return (host ?? '').trim().toLowerCase();
}

function normalizePath(path: string | undefined): string {
  const p = (path ?? '/').trim();
  if (p.length === 0) return '/';
  return p.startsWith('/') ? p : `/${p}`;
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
  if (normalized === 'machinelearning') return 'machinelearning';
  if (normalized === 'sessionidentifier') return 'sessionidentifier';
  if (normalized === 'manual') return 'manual';
  if (normalized === 'imported') return 'imported';
  return 'machinelearning';
}

export class CloudflareApiConnector implements DataConnector {
  async fetchEndpoints(config: ConnectorConfig): Promise<Endpoint[]> {
    if (!config.apiToken) {
      throw new Error('apiToken required for API mode');
    }
    if (!config.zoneId) {
      throw new Error('zoneId required for API mode');
    }

    const apiToken = config.apiToken;

    const discovery = await this.fetchDiscoveryOperations(config, apiToken);
    const managed = await this.fetchManagedOperations(config, apiToken);

    // Merge and deduplicate by id and canonical shape.
    return this.mergeEndpoints(discovery.endpoints, managed.endpoints);
  }

  async fetchEndpointStats(config: ConnectorConfig): Promise<EndpointFetchStats> {
    if (!config.apiToken) {
      throw new Error('apiToken required for API mode');
    }
    if (!config.zoneId) {
      throw new Error('zoneId required for API mode');
    }

    const discovery = await this.fetchDiscoveryOperations(config, config.apiToken);
    const managed = await this.fetchManagedOperations(config, config.apiToken);
    const merged = this.mergeEndpoints(discovery.endpoints, managed.endpoints);

    return {
      discovery: {
        pagesFetched: discovery.pagesFetched,
        operationCount: discovery.endpoints.length,
      },
      managed: {
        pagesFetched: managed.pagesFetched,
        operationCount: managed.endpoints.length,
      },
      merged: {
        endpointCount: merged.length,
      },
    };
  }

  private mergeEndpoints(discovery: Endpoint[], managed: Endpoint[]): Endpoint[] {
    const seen = new Set<string>();
    const seenShape = new Set<string>();
    const merged: Endpoint[] = [];
    for (const ep of [...discovery, ...managed]) {
      const shape = `${ep.method}||${ep.host}||${ep.path}`;
      if (!seen.has(ep.id) && !seenShape.has(shape)) {
        seen.add(ep.id);
        seenShape.add(shape);
        merged.push(ep);
      }
    }
    return merged;
  }

  private async fetchDiscoveryOperations(
    config: ConnectorConfig,
    apiToken: string,
  ): Promise<{ endpoints: Endpoint[]; pagesFetched: number }> {
    const url = new URL(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/api_gateway/discovery/operations`);
    const states = config.state && config.state.trim() !== ''
      ? config.state
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [...DEFAULT_DISCOVERY_STATES];

    for (const state of states) {
      url.searchParams.append('state', state);
    }

    const operations = await this.fetchPaginated<DiscoveryOperation>(url, apiToken, true);

    return {
      pagesFetched: operations.pagesFetched,
      endpoints: operations.items.map((op, idx) => ({
      id: op.id ?? `generated-${idx}`,
      accountId: config.accountId ?? '',
      zoneId: config.zoneId ?? '',
      host: normalizeHost(op.host),
      method: normalizeMethod(op.method),
      path: normalizePath(op.endpoint),
      source: mapDiscoverySource(op.source),
      hits: op.total_requests ?? 0,
      lastSeenAt: op.last_seen ?? new Date().toISOString(),
      status: mapEndpointStatus(op.state),
      rawReference: op,
      })),
    };
  }

  private async fetchManagedOperations(
    config: ConnectorConfig,
    apiToken: string,
  ): Promise<{ endpoints: Endpoint[]; pagesFetched: number }> {
    const url = new URL(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/api_gateway/operations`);

    const operations = await this.fetchPaginated<ManagedOperation>(url, apiToken, false);

    return {
      pagesFetched: operations.pagesFetched,
      endpoints: operations.items.map((op, idx) => ({
      id: op.operation_id ?? `managed-${idx}`,
      accountId: config.accountId ?? '',
      zoneId: config.zoneId ?? '',
      host: normalizeHost(op.host),
      method: normalizeMethod(op.method),
      path: normalizePath(op.endpoint),
      source: 'manual',
      hits: 0,
      lastSeenAt: op.last_updated ?? op.created_at ?? new Date().toISOString(),
      status: 'saved',
      rawReference: op,
      })),
    };
  }

  private async fetchPaginated<T>(
    baseUrl: URL,
    apiToken: string,
    suppress403404: boolean,
  ): Promise<PaginatedResult<T>> {
    const all: T[] = [];
    const perPage = 100;
    let page = 1;
    let pagesFetched = 0;

    while (true) {
      const pageUrl = new URL(baseUrl.toString());
      pageUrl.searchParams.set('per_page', String(perPage));
      pageUrl.searchParams.set('page', String(page));

      const resp = await fetch(pageUrl.toString(), {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!resp.ok) {
        if (suppress403404 && (resp.status === 403 || resp.status === 404)) {
          return { items: [], pagesFetched };
        }
        throw new Error(`Cloudflare API error: ${resp.status} ${resp.statusText}`);
      }

      pagesFetched += 1;

      const json = (await resp.json()) as CloudflareListResponse<T>;
      if (!json.success) {
        throw new Error('Cloudflare API returned unsuccessful response');
      }

      const pageResult = json.result ?? [];
      all.push(...pageResult);

      const totalPages = json.result_info?.total_pages;
      if (typeof totalPages === 'number' && totalPages > 0) {
        if (page >= totalPages) break;
        page += 1;
        continue;
      }

      if (pageResult.length < perPage) break;
      page += 1;
    }

    return { items: all, pagesFetched };
  }

  async listZones(apiToken: string): Promise<Zone[]> {
    const url = new URL('https://api.cloudflare.com/client/v4/zones');
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
