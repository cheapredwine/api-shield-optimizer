import type { ConnectorConfig, DataConnector, Endpoint } from '../types.js';

export class SnapshotConnector implements DataConnector {
  async fetchEndpoints(config: ConnectorConfig): Promise<Endpoint[]> {
    if (!config.snapshotPath) {
      throw new Error('snapshotPath required for snapshot mode');
    }
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(config.snapshotPath, 'utf-8');
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data)) {
      return data as Endpoint[];
    }
    if (data && typeof data === 'object' && 'endpoints' in data) {
      return (data as { endpoints: Endpoint[] }).endpoints;
    }
    throw new Error('Snapshot must be an array of endpoints or { endpoints: [...] }');
  }
}
