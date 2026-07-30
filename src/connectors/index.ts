import type { DataConnector, ConnectorConfig } from '../types.js';
import { CloudflareApiConnector } from './api.js';
import { SnapshotConnector } from './snapshot.js';

/** Builds the connector for a given mode. */
export function createConnector(config: ConnectorConfig): DataConnector {
  switch (config.mode) {
    case 'api':
      return new CloudflareApiConnector();
    case 'snapshot':
      return new SnapshotConnector();
    case 'mcp':
      throw new Error('MCP connector not yet implemented. Use api or snapshot mode.');
    default:
      throw new Error(`Unknown connector mode: ${String(config.mode)}`);
  }
}

export { CloudflareApiConnector, SnapshotConnector };
export { CloudflareApiError } from './api.js';
export type { EndpointFetchStats } from './api.js';
