import type { Endpoint, NormalizedGroup } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const NUMERIC_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{10,13}$/;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]{20,}={0,2}$/;
const MONGO_OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const CUID_RE = /^c[a-z0-9]{24,}$/i;
const CUID2_RE = /^[a-z][a-z0-9]{23,}$/i;
const KSUID_RE = /^[0-9A-Za-z]{27}$/;
const TENANT_RE = /^(?=.*[a-z])(?=.*\d)[a-z0-9]{12,32}$/i;

const STATIC_SEGMENT_ALLOWLIST = new Set([
  'account',
  'accounts',
  'admin',
  'api',
  'apps',
  'billing',
  'checkout',
  'customer',
  'customers',
  'dashboard',
  'health',
  'invoices',
  'login',
  'orders',
  'payments',
  'products',
  'profile',
  'reports',
  'settings',
  'users',
]);

function isHighCardinalitySegment(segment: string): boolean {
  if (segment.length <= 24) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;

  const hasLower = /[a-z]/.test(segment);
  const hasUpper = /[A-Z]/.test(segment);
  const hasDigit = /\d/.test(segment);
  const hasSeparator = /[_-]/.test(segment);
  const variety = [hasLower, hasUpper, hasDigit, hasSeparator].filter(Boolean).length;

  return variety >= 2 && !/^[A-Za-z]+$/.test(segment);
}

export function isVariableSegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  if (STATIC_SEGMENT_ALLOWLIST.has(normalized)) return false;

  if (NUMERIC_RE.test(segment)) return true;
  if (UUID_RE.test(segment)) return true;
  if (ULID_RE.test(segment)) return true;
  if (MONGO_OBJECT_ID_RE.test(segment)) return true;
  if (CUID_RE.test(segment)) return true;
  if (CUID2_RE.test(segment)) return true;
  if (KSUID_RE.test(segment)) return true;
  if (DATE_RE.test(segment)) return true;
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
    if (isHighCardinalitySegment(seg)) {
      varCount++;
      if (!rules.includes('high-cardinality-segment')) {
        rules.push('high-cardinality-segment');
      }
      return `{var${varCount}}`;
    }
    return seg;
  });

  const pattern = '/' + normalized.join('/');
  return { pattern, varCount, rules };
}

export function normalizeHost(hosts: string[]): { pattern: string; rules: string[]; canCollapse: boolean } {
  if (hosts.length === 0) return { pattern: '', rules: [], canCollapse: false };
  const normalizedHosts = hosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0);
  if (normalizedHosts.length === 0) return { pattern: '', rules: [], canCollapse: false };
  if (normalizedHosts.length === 1) return { pattern: normalizedHosts[0], rules: [], canCollapse: true };

  const split = normalizedHosts.map((h) => h.split('.'));
  const lengths = split.map((s) => s.length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);

  // Require same depth for safe hostname variable collapse.
  // Variable-depth subdomains cannot be covered by a single complete-label variable.
  if (minLen !== maxLen) {
    return { pattern: normalizedHosts[0], rules: [], canCollapse: false };
  }

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
    return { pattern: template, rules: ['hostname-variable'], canCollapse: true };
  }

  // If multiple labels differ, cannot safely use a single host variable
  return { pattern: normalizedHosts[0], rules: [], canCollapse: false };
}

export function groupEndpoints(endpoints: Endpoint[]): NormalizedGroup[] {
  // First pass: group by method + raw host + normalized path
  const map = new Map<string, Endpoint[]>();

  for (const ep of endpoints) {
    const { pattern: pathPattern } = normalizePath(ep.path);
    const key = `${ep.method}||${ep.host}||${pathPattern}`;
    const existing = map.get(key);
    if (existing) {
      existing.push(ep);
    } else {
      map.set(key, [ep]);
    }
  }

  // Second pass: try to merge groups that differ only by host.
  // Only merge when normalizeHost says the collapse is safe.
  const mergedGroups: { hostPattern: string; pathPattern: string; method: string; members: Endpoint[] }[] = [];

  for (const [key, members] of map) {
    const [method, host, pathPattern] = key.split('||');

    let found = false;
    for (const group of mergedGroups) {
      if (group.method === method && group.pathPattern === pathPattern) {
        const combined = [...group.members, ...members];
        const distinctHosts = [...new Set(combined.map((m) => m.host))];
        const hostNorm = normalizeHost(distinctHosts);
        if (hostNorm.canCollapse) {
          group.members = combined;
          group.hostPattern = hostNorm.pattern;
          found = true;
          break;
        }
      }
    }

    if (!found) {
      mergedGroups.push({ hostPattern: host, pathPattern, method, members });
    }
  }

  // Finalize groups
  let groupId = 1;
  return mergedGroups.map((g) => {
    const distinctHosts = [...new Set(g.members.map((m) => m.host))];
    const hostNorm = normalizeHost(distinctHosts);

    return {
      groupId: `group-${String(groupId++).padStart(4, '0')}`,
      normalizedHostPattern: hostNorm.pattern || g.hostPattern,
      normalizedPathPattern: g.pathPattern,
      method: g.method,
      members: g.members,
      recommendedAction: 'manual_review',
      confidence: 0.5,
      reasoning: [],
      flags: [],
    };
  });
}
