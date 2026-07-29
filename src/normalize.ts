import type { Endpoint, NormalizedGroup } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const NUMERIC_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_SLASH_RE = /^\d{4}\/\d{2}\/\d{2}$/;
const TIMESTAMP_RE = /^\d{10,13}$/;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]{20,}={0,2}$/;
const TENANT_RE = /^[a-z0-9]{8,32}$/i;

export function isVariableSegment(segment: string): boolean {
  if (NUMERIC_RE.test(segment)) return true;
  if (UUID_RE.test(segment)) return true;
  if (ULID_RE.test(segment)) return true;
  if (DATE_RE.test(segment)) return true;
  if (DATE_SLASH_RE.test(segment)) return true;
  if (TIMESTAMP_RE.test(segment)) return true;
  if (HEX_RE.test(segment)) return true;
  if (BASE64_RE.test(segment)) return true;
  if (TENANT_RE.test(segment)) return true;
  return false;
}

export function normalizePath(path: string): { pattern: string; varCount: number; rules: string[] } {
  const segments = path.split('/').filter(Boolean);
  const rules: string[] = [];
  let varCount = 0;

  const normalized = segments.map((seg, idx) => {
    if (isVariableSegment(seg)) {
      varCount++;
      if (!rules.includes('variable-segment')) {
        rules.push('variable-segment');
      }
      return `{var${varCount}}`;
    }
    // Treat any segment that looks like a file extension pattern as variable if long and random
    if (seg.length > 24 && /[a-z0-9]{20,}/i.test(seg)) {
      varCount++;
      rules.push('high-cardinality-segment');
      return `{var${varCount}}`;
    }
    return seg;
  });

  const pattern = '/' + normalized.join('/');
  return { pattern, varCount, rules };
}

export function normalizeHost(hosts: string[]): { pattern: string; rules: string[] } {
  if (hosts.length === 0) return { pattern: '', rules: [] };
  if (hosts.length === 1) return { pattern: hosts[0], rules: [] };

  const split = hosts.map((h) => h.split('.'));
  const minLen = Math.min(...split.map((s) => s.length));

  // Find which label varies across hosts
  const differingLabels: number[] = [];
  for (let i = 0; i < minLen; i++) {
    const vals = new Set(split.map((s) => s[i]));
    if (vals.size > 1) {
      differingLabels.push(i);
    }
  }

  // Only collapse if exactly one label differs and it is a complete label
  if (differingLabels.length === 1) {
    const idx = differingLabels[0];
    const template = split[0].map((label, i) => (i === idx ? '{hostVar1}' : label)).join('.');
    return { pattern: template, rules: ['hostname-variable'] };
  }

  // If multiple labels differ, cannot safely use a single host variable
  return { pattern: hosts[0], rules: [] };
}

export function groupEndpoints(endpoints: Endpoint[]): NormalizedGroup[] {
  const map = new Map<string, Endpoint[]>();

  for (const ep of endpoints) {
    const { pattern: pathPattern, varCount: pathVars } = normalizePath(ep.path);
    const key = `${ep.method}||${ep.host}||${pathPattern}`;
    const existing = map.get(key);
    if (existing) {
      existing.push(ep);
    } else {
      map.set(key, [ep]);
    }
  }

  // Second pass: try to merge groups that differ only by host when host can be variable-ized
  const hostGroups = new Map<string, { hostPattern: string; pathPattern: string; method: string; members: Endpoint[] }>();

  for (const [key, members] of map) {
    const [method, host, pathPattern] = key.split('||');
    const pathKey = `${method}||${pathPattern}`;
    const existing = hostGroups.get(pathKey);
    if (existing) {
      existing.members.push(...members);
    } else {
      hostGroups.set(pathKey, { hostPattern: host, pathPattern, method, members });
    }
  }

  // Apply host normalization to groups with multiple distinct hosts
  const groups: NormalizedGroup[] = [];
  let groupId = 1;

  for (const { hostPattern, pathPattern, method, members } of hostGroups.values()) {
    const distinctHosts = [...new Set(members.map((m) => m.host))];
    const hostNorm = normalizeHost(distinctHosts);

    groups.push({
      groupId: `group-${String(groupId++).padStart(4, '0')}`,
      normalizedHostPattern: hostNorm.pattern || hostPattern,
      normalizedPathPattern: pathPattern,
      method,
      members,
      recommendedAction: 'manual_review',
      confidence: 0.5,
      reasoning: [],
      flags: [],
    });
  }

  return groups;
}
