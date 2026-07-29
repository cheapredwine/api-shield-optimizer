import type { ConnectorConfig, DataConnector, Endpoint, Zone } from '../types.js';

export class CloudflareApiConnector implements DataConnector {
  async fetchEndpoints(config: ConnectorConfig): Promise<Endpoint[]> {
    if (!config.apiToken) {
      throw new Error('apiToken required for API mode');
    }
    if (!config.zoneId) {
      throw new Error('zoneId required for API mode');
    }

    const url = `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/api_gateway/discovery/operations`;
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
      throw new Error('Cloudflare API returned unsuccessful response');
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
