import type { ConnectorConfig, DataConnector, Endpoint, EndpointFeatures } from '../types.js';
import { canonicalizeHost } from '../normalize.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDiscoverySource(value: unknown): value is Endpoint['source'] {
  return value === 'machinelearning' || value === 'sessionidentifier' || value === 'manual' || value === 'imported';
}

function isEndpointStatus(value: unknown): value is Endpoint['status'] {
  return value === undefined || value === 'candidate' || value === 'saved' || value === 'ignored';
}

/** `hits` may be a number, or null/absent to mean "traffic volume unknown". */
function isHits(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'number';
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalFeatures(value: unknown): value is EndpointFeatures | undefined {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  return Object.values(value).every((v) => v === undefined || typeof v === 'number');
}

function isOptionalNumberMap(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  return Object.values(value).every((v) => typeof v === 'number');
}

/**
 * Field-by-field validation. Only `host`, `method` and `path` are genuinely
 * required — everything else is either optional enrichment or can be defaulted,
 * so a hand-authored snapshot stays short. Returns the list of problems for a
 * single entry so the error message can name the offending field.
 */
function endpointProblems(value: unknown): string[] {
  if (!isObject(value)) return ['entry is not an object'];

  const c = value as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof c.host !== 'string' || c.host.length === 0) problems.push('host must be a non-empty string');
  if (typeof c.method !== 'string' || c.method.length === 0) problems.push('method must be a non-empty string');
  if (typeof c.path !== 'string' || !c.path.startsWith('/')) problems.push('path must be a string starting with "/"');

  if (!isOptionalString(c.id)) problems.push('id must be a string');
  if (!isOptionalString(c.accountId)) problems.push('accountId must be a string');
  if (!isOptionalString(c.zoneId)) problems.push('zoneId must be a string');
  if (!isOptionalString(c.lastSeenAt)) problems.push('lastSeenAt must be a string');
  if (c.source !== undefined && !isDiscoverySource(c.source)) {
    problems.push('source must be machinelearning, sessionidentifier, manual, or imported');
  }
  if (!isHits(c.hits)) problems.push('hits must be a number or null');
  if (!isEndpointStatus(c.status)) problems.push('status must be candidate, saved, or ignored');
  if (!isOptionalStringArray(c.labels)) problems.push('labels must be an array of strings');
  if (!isOptionalStringArray(c.contentTypes)) problems.push('contentTypes must be an array of strings');
  if (!isOptionalBoolean(c.inSchema)) problems.push('inSchema must be a boolean');
  if (!isOptionalBoolean(c.inSitemap)) problems.push('inSitemap must be a boolean');
  if (!isOptionalNumber(c.cacheHitRatio)) problems.push('cacheHitRatio must be a number');
  if (!isOptionalFeatures(c.features)) problems.push('features must be an object of numbers');
  if (!isOptionalNumberMap(c.statusCodes)) problems.push('statusCodes must be an object of numbers');

  return problems;
}

/** Fills in the fields the rest of the pipeline expects. */
function normalizeEndpoint(value: Record<string, unknown>, index: number): Endpoint {
  const host = canonicalizeHost(value.host as string);
  const method = (value.method as string).toUpperCase();
  const path = value.path as string;

  return {
    id: typeof value.id === 'string' ? value.id : `snapshot-${index}`,
    accountId: typeof value.accountId === 'string' ? value.accountId : '',
    zoneId: typeof value.zoneId === 'string' ? value.zoneId : '',
    host,
    method,
    path,
    source: isDiscoverySource(value.source) ? value.source : 'imported',
    hits: typeof value.hits === 'number' ? value.hits : null,
    lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : '',
    labels: value.labels as string[] | undefined,
    status: isEndpointStatus(value.status) ? value.status : undefined,
    inSchema: value.inSchema as boolean | undefined,
    features: value.features as EndpointFeatures | undefined,
    contentTypes: (value.contentTypes as string[] | undefined)?.map((t) => t.toLowerCase()),
    statusCodes: value.statusCodes as Record<string, number> | undefined,
    cacheHitRatio: value.cacheHitRatio as number | undefined,
    inSitemap: value.inSitemap as boolean | undefined,
    rawReference: 'rawReference' in value ? value.rawReference : value,
  };
}

function parseList(entries: unknown[], label: string): Endpoint[] {
  const errors: string[] = [];

  entries.forEach((entry, index) => {
    const problems = endpointProblems(entry);
    if (problems.length > 0) {
      errors.push(`  [${index}]: ${problems.join('; ')}`);
    }
  });

  if (errors.length > 0) {
    // Cap the report so a badly-formed file does not bury the terminal.
    const shown = errors.slice(0, 10);
    const suffix = errors.length > shown.length ? `\n  ...and ${errors.length - shown.length} more` : '';
    throw new Error(`${label} contains ${errors.length} invalid entr${errors.length === 1 ? 'y' : 'ies'}:\n${shown.join('\n')}${suffix}`);
  }

  return entries.map((entry, index) => normalizeEndpoint(entry as Record<string, unknown>, index));
}

function parseSnapshotEndpoints(data: unknown): Endpoint[] {
  if (Array.isArray(data)) {
    return parseList(data, 'Snapshot endpoint array');
  }

  if (isObject(data) && Array.isArray(data.endpoints)) {
    return parseList(data.endpoints, 'Snapshot endpoints field');
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

    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Snapshot at ${config.snapshotPath} is not valid JSON`);
    }

    return parseSnapshotEndpoints(data);
  }
}
