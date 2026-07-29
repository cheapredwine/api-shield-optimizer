import type { ConnectorConfig, DataConnector, Endpoint } from '../types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDiscoverySource(value: unknown): value is Endpoint['source'] {
  return value === 'machinelearning' || value === 'sessionidentifier' || value === 'manual' || value === 'imported';
}

function isEndpointStatus(value: unknown): value is Endpoint['status'] {
  return value === undefined || value === 'candidate' || value === 'saved' || value === 'ignored';
}

function isEndpoint(value: unknown): value is Endpoint {
  if (!isObject(value)) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.accountId === 'string' &&
    typeof candidate.zoneId === 'string' &&
    typeof candidate.host === 'string' &&
    typeof candidate.method === 'string' &&
    typeof candidate.path === 'string' &&
    isDiscoverySource(candidate.source) &&
    typeof candidate.hits === 'number' &&
    typeof candidate.lastSeenAt === 'string' &&
    'rawReference' in candidate &&
    isEndpointStatus(candidate.status)
  );
}

function parseSnapshotEndpoints(data: unknown): Endpoint[] {
  if (Array.isArray(data)) {
    if (!data.every(isEndpoint)) {
      throw new Error('Snapshot endpoint array contains invalid entries');
    }
    return data;
  }

  if (isObject(data) && Array.isArray(data.endpoints)) {
    if (!data.endpoints.every(isEndpoint)) {
      throw new Error('Snapshot endpoints field contains invalid entries');
    }
    return data.endpoints;
  }

  throw new Error('Snapshot must be an array of endpoints or { endpoints: [...] }');
}

export class SnapshotConnector implements DataConnector {
  async fetchEndpoints(config: ConnectorConfig): Promise<Endpoint[]> {
    if (!config.snapshotPath) {
      throw new Error('snapshotPath required for snapshot mode');
    }
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(config.snapshotPath, 'utf-8');
    const data = JSON.parse(raw) as unknown;
    return parseSnapshotEndpoints(data);
  }
}
