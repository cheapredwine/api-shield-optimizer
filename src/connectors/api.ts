import type { ConnectorConfig, DataConnector, Endpoint, Zone } from '../types.js';

export class CloudflareApiConnector implements DataConnector {
  async fetchEndpoints(config: ConnectorConfig): Promise<Endpoint[]> {
    if (!config.apiToken) {
      throw new Error('apiToken required for API mode');
    }
    if (!config.zoneId) {
      throw new Error('zoneId required for API mode');
    }

    const discovery = await this.fetchDiscoveryOperations(config);
    const managed = await this.fetchManagedOperations(config);

    // Merge and deduplicate by id
    const seen = new Set<string>();
    const merged: Endpoint[] = [];
    for (const ep of [...discovery, ...managed]) {
      if (!seen.has(ep.id)) {
        seen.add(ep.id);
        merged.push(ep);
      }
    }
    return merged;
  }

  private async fetchDiscoveryOperations(config: ConnectorConfig): Promise<Endpoint[]> {
    let url = `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/api_gateway/discovery/operations`;
    if (config.state) {
      url += `?state=${encodeURIComponent(config.state)}`;
    }
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      throw new Error(`Cloudflare API error: ${resp.status} ${resp.statusText}`);
    }

    const json = (await resp.json()) as {
      success: boolean;
      result?: Array<{
        id?: string;
        host?: string;
        method?: string;
        endpoint?: string;
        source?: string;
        total_requests?: number;
        last_seen?: string;
        features?: Record<string, unknown>;
      }>;
    };

    if (!json.success || !json.result) {
      return [];
    }

    return json.result.map((op, idx) => ({
      id: op.id ?? `generated-${idx}`,
      accountId: config.accountId ?? '',
      zoneId: config.zoneId ?? '',
      host: op.host ?? '',
      method: op.method ?? 'GET',
      path: op.endpoint ?? '/',
      source: (op.source as Endpoint['source']) ?? 'machinelearning',
      hits: op.total_requests ?? 0,
      lastSeenAt: op.last_seen ?? new Date().toISOString(),
      rawReference: op,
    }));
  }

  private async fetchManagedOperations(config: ConnectorConfig): Promise<Endpoint[]> {
    const url = `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/api_gateway/operations`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      // Managed operations endpoint may not be available on all plans
      if (resp.status === 404 || resp.status === 403) {
        return [];
      }
      throw new Error(`Cloudflare API error: ${resp.status} ${resp.statusText}`);
    }

    const json = (await resp.json()) as {
      success: boolean;
      result?: Array<{
        operation_id?: string;
        host?: string;
        method?: string;
        endpoint?: string;
        last_updated?: string;
        created_at?: string;
      }>;
    };

    if (!json.success || !json.result) {
      return [];
    }

    return json.result.map((op, idx) => ({
      id: op.operation_id ?? `managed-${idx}`,
      accountId: config.accountId ?? '',
      zoneId: config.zoneId ?? '',
      host: op.host ?? '',
      method: op.method ?? 'GET',
      path: op.endpoint ?? '/',
      source: 'manual' as Endpoint['source'],
      hits: 0,
      lastSeenAt: op.last_updated ?? new Date().toISOString(),
      rawReference: op,
    }));
  }

  async listZones(apiToken: string): Promise<Zone[]> {
    const url = 'https://api.cloudflare.com/client/v4/zones?per_page=50';
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      throw new Error(`Cloudflare API error: ${resp.status} ${resp.statusText}`);
    }

    const json = (await resp.json()) as {
      success: boolean;
      result?: Array<{
        id?: string;
        name?: string;
        account?: { id?: string };
        status?: string;
        plan?: { name?: string };
      }>;
    };

    if (!json.success || !json.result) {
      throw new Error('Cloudflare API returned unsuccessful response');
    }

    return json.result.map((z) => ({
      id: z.id ?? '',
      name: z.name ?? '',
      accountId: z.account?.id ?? '',
      status: z.status ?? '',
      plan: z.plan?.name ?? '',
    }));
  }
}
