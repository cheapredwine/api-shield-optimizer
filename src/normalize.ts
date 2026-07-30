import type { Endpoint, NormalizedGroup } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const NUMERIC_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{10,13}$/;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]{20,}={0,2}$/;
const MONGO_OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Opaque id carrying a short human-readable prefix, e.g. `ORD-2042284971`,
 * `INV-0001` or Stripe's `cus_NffrFeUfNV2Hib`.
 *
 * The separator is what makes this safe. Word-like segments that embed digits
 * (`iphone13promax`, `office365business`, `error404handler`) run the digits
 * together with the words, and human-authored slugs that do use separators
 * (`mens-shoes`, `winter-coat-navy`) have no trailing digit run.
 *
 * Both rules are unconditional apart from requiring a digit, which keeps them
 * deterministic across every member of an id family while still excluding words
 * like `content_management`.
 */
const PREFIXED_NUMERIC_ID_RE = /^[A-Za-z]{1,8}[-_]\d{4,}$/;
const PREFIXED_OPAQUE_ID_RE = /^[A-Za-z]{2,8}_[A-Za-z0-9]{8,}$/;

/** Prefixed ids always carry digits; words essentially never do. */
function digitCount(segment: string): number {
  let n = 0;
  for (const ch of segment) if (ch >= '0' && ch <= '9') n++;
  return n;
}

/**
 * Cloudflare's own variable placeholders. API Shield discovery already returns
 * normalized shapes such as `{hostVar1}.example.com` and `/orders/{var1}`, so
 * these must be preserved rather than lowercased into `{hostvar1}` or, worse,
 * re-examined as though they were literal path segments.
 *
 * We emit the same convention for variables we introduce ourselves.
 */
const PATH_VAR_RE = /^\{var(\d+)\}$/i;
const HOST_VAR_RE = /^\{hostVar(\d+)\}$/i;

export function pathVarIndex(segment: string): number | null {
  const match = PATH_VAR_RE.exec(segment);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function hostVarIndex(label: string): number | null {
  const match = HOST_VAR_RE.exec(label);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Lowercases a hostname while leaving Cloudflare placeholders in canonical
 * form. Hostnames are case-insensitive, but `{hostVar1}` is a token, not a name.
 */
export function canonicalizeHost(host: string): string {
  return host
    .trim()
    .split('.')
    .map((label) => {
      const idx = hostVarIndex(label);
      return idx === null ? label.toLowerCase() : `{hostVar${idx}}`;
    })
    .join('.');
}
const CUID_RE = /^c[a-z0-9]{24,}$/i;
const KSUID_RE = /^[0-9A-Za-z]{27}$/;

/**
 * Segments that must never be read as identifiers.
 *
 * Two kinds live here. Resource nouns keep collection names literal. Action
 * verbs matter for sibling inference: an action shares its collection's prefix,
 * so `/products/search` sits in the same bucket as `/products/{sku}` and would
 * otherwise be absorbed into the identifier position, merging a distinct
 * operation into the detail group and misattributing its traffic.
 *
 * Erring toward literal is the safe direction. A missing entry merges two
 * operations and hides one; a spurious entry only splits a group that should
 * have collapsed.
 */
const STATIC_SEGMENT_ALLOWLIST = new Set([
  // Resource nouns
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
  'guide',
  'health',
  'inventory',
  'invoices',
  'login',
  'orders',
  'payments',
  'products',
  'profile',
  'reports',
  'settings',
  'users',
  // Action verbs and collection-level sub-resources
  'all',
  'batch',
  'browse',
  'bulk',
  'callback',
  'cancel',
  'compare',
  'confirm',
  'count',
  'current',
  'default',
  'download',
  'export',
  'filter',
  'filters',
  'history',
  'import',
  'latest',
  'logout',
  'me',
  'metadata',
  'new',
  'preview',
  'purchase',
  'refresh',
  'register',
  'reset',
  'revoke',
  'schema',
  'search',
  'self',
  'sort',
  'status',
  'submit',
  'suggest',
  'summary',
  'upload',
  'validate',
  'verify',
]);

/**
 * Multi-label public suffixes that must never be collapsed into a variable.
 * Collapsing any label of the registrable domain would merge unrelated
 * organisations (`api.acme.com` + `api.evilcorp.com`) into one pattern.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'or.jp',
  'ne.jp',
  'co.nz',
  'co.za',
  'com.au',
  'net.au',
  'org.au',
  'com.br',
  'com.cn',
  'com.mx',
  'com.sg',
  'com.tr',
  'co.in',
  'co.kr',
  'co.il',
  'com.hk',
  'com.tw',
  'pages.dev',
  'workers.dev',
  'github.io',
]);

/**
 * Number of trailing labels that form the registrable domain (eTLD+1).
 * Uses a bundled multi-label suffix set; unknown suffixes fall back to 2,
 * which is the conservative choice because it protects more labels.
 */
export function registrableDomainLabelCount(labels: string[]): number {
  if (labels.length <= 2) return labels.length;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return Math.min(labels.length, 3);
  }
  return 2;
}

/**
 * Shannon entropy per character. Random identifiers score high; human-readable
 * slugs such as `iphone13promax` score low.
 */
function normalizedEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Counts transitions between character classes, e.g. `a1b2` has 3. */
function classTransitions(value: string): number {
  const classOf = (ch: string): string => {
    if (/[a-z]/.test(ch)) return 'l';
    if (/[A-Z]/.test(ch)) return 'u';
    if (/\d/.test(ch)) return 'd';
    return 's';
  };
  let transitions = 0;
  for (let i = 1; i < value.length; i++) {
    if (classOf(value[i]) !== classOf(value[i - 1])) transitions++;
  }
  return transitions;
}

/** Digit fraction, used to separate opaque IDs from word-like slugs. */
function digitRatio(value: string): number {
  const digits = value.replace(/\D/g, '').length;
  return value.length === 0 ? 0 : digits / value.length;
}

/**
 * Coarse shape class of a path segment, used to decide whether a literal
 * resembles its siblings.
 *
 * Members of one identifier family share a shape; a static sub-page sitting in
 * the same collection usually does not. `/products/8813245` and
 * `/products/clearance` occupy the same position under the same prefix with the
 * same continuation, so only the shape of the value separates them.
 *
 * Deliberately ignores length. Numeric ids are frequently variable-length
 * (`/orders/7` alongside `/orders/183024`), and splitting on length would break
 * exactly the families this is meant to collapse.
 *
 * Classes are coarse for the same reason. `electronics` and `home-garden` are
 * both human-readable text and belong to one `/c/{category}` family, so
 * separating hyphenated from unhyphenated words would leave that family split.
 */
function segmentShape(segment: string): string {
  if (/^\d+$/.test(segment)) return 'numeric';
  if (/^[0-9a-f]{8,}$/i.test(segment) && /\d/.test(segment)) return 'hex';
  // Words, optionally separated — a readable slug either way.
  if (/^[A-Za-z]+(?:[-_.][A-Za-z]+)*$/.test(segment)) return 'text';
  if (/^[A-Za-z0-9]+$/.test(segment)) return 'alphanumeric';
  return 'other';
}

/**
 * Detects opaque high-cardinality segments without swallowing readable slugs.
 *
 * The previous heuristic matched any 24+ char alphanumeric string with two
 * character classes, which incorrectly flagged product slugs like
 * `iphone13promax` and `top10bestlaptops` as variables.
 */
export function isHighCardinalitySegment(segment: string): boolean {
  if (segment.length < 16) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  if (/^[A-Za-z]+$/.test(segment)) return false;

  // Hyphen/underscore separated words are almost always human-authored slugs.
  const words = segment.split(/[-_]/);
  if (words.length > 2 && words.every((w) => /^[a-z]+$/i.test(w))) return false;

  const entropy = normalizedEntropy(segment);
  const transitions = classTransitions(segment);
  const digits = digitRatio(segment);

  // High entropy alone is a strong indicator for long segments.
  if (entropy >= 3.9 && segment.length >= 20) return true;

  // Mixed-class churn plus meaningful digit content indicates an opaque ID.
  const transitionRate = transitions / segment.length;
  if (entropy >= 3.4 && transitionRate >= 0.3 && digits >= 0.15) return true;

  // Long mostly-numeric identifiers with separators, e.g. `20240115-8837261`.
  if (digits >= 0.6 && segment.length >= 16) return true;

  return false;
}

export function isVariableSegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  if (STATIC_SEGMENT_ALLOWLIST.has(normalized)) return false;

  if (NUMERIC_RE.test(segment)) return true;
  if (PREFIXED_NUMERIC_ID_RE.test(segment)) return true;
  if (PREFIXED_OPAQUE_ID_RE.test(segment) && digitCount(segment) >= 1) return true;
  if (UUID_RE.test(segment)) return true;
  if (ULID_RE.test(segment)) return true;
  if (MONGO_OBJECT_ID_RE.test(segment)) return true;
  if (CUID_RE.test(segment)) return true;
  if (KSUID_RE.test(segment) && isHighCardinalitySegment(segment)) return true;
  if (DATE_RE.test(segment)) return true;
  if (TIMESTAMP_RE.test(segment)) return true;
  if (HEX_RE.test(segment)) return true;
  if (BASE64_RE.test(segment) && isHighCardinalitySegment(segment)) return true;
  return false;
}

export function normalizePath(
  path: string,
  /**
   * Positions that corpus-level sibling analysis has already determined to be
   * variable. See `inferSiblingVariables`.
   */
  forcedVariablePositions?: ReadonlySet<number>,
): { pattern: string; varCount: number; rules: string[] } {
  const segments = path.split('/').filter(Boolean);
  const rules: string[] = [];
  let varCount = 0;

  const normalized = segments.map((seg, position) => {
    if (forcedVariablePositions?.has(position) && pathVarIndex(seg) === null) {
      varCount++;
      if (!rules.includes('sibling-variable-segment')) {
        rules.push('sibling-variable-segment');
      }
      return `{var${varCount}}`;
    }
    // Cloudflare already marked this segment as a variable. Keep it, and count
    // it so any variable we add afterwards continues the numbering.
    if (pathVarIndex(seg) !== null) {
      varCount++;
      if (!rules.includes('cloudflare-variable-segment')) {
        rules.push('cloudflare-variable-segment');
      }
      return `{var${varCount}}`;
    }
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
  const normalizedHosts = [...new Set(hosts.map(canonicalizeHost).filter((h) => h.length > 0))].sort();
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

  // Find which label varies across hosts.
  const differingLabels: number[] = [];
  for (let i = 0; i < minLen; i++) {
    const vals = new Set(split.map((s) => s[i]));
    if (vals.size > 1) {
      differingLabels.push(i);
    }
  }

  if (differingLabels.length !== 1) {
    // Zero differing labels is impossible here (hosts are deduped), and more
    // than one cannot be covered by a single variable.
    return { pattern: normalizedHosts[0], rules: [], canCollapse: false };
  }

  const idx = differingLabels[0];

  // Never variabilise any label of the registrable domain. Collapsing the
  // apex or the public suffix would merge unrelated organisations.
  const protectedFrom = minLen - registrableDomainLabelCount(split[0]);
  if (idx >= protectedFrom) {
    return { pattern: normalizedHosts[0], rules: [], canCollapse: false };
  }

  // Continue Cloudflare's numbering rather than colliding with it: a host that
  // already contains `{hostVar1}` gets `{hostVar2}` for the label we collapse.
  const existingIndices = split[0]
    .map((label) => hostVarIndex(label))
    .filter((n): n is number => n !== null);
  const nextIndex = existingIndices.length > 0 ? Math.max(...existingIndices) + 1 : 1;

  const template = split[0].map((label, i) => (i === idx ? `{hostVar${nextIndex}}` : label)).join('.');
  return { pattern: template, rules: ['hostname-variable'], canCollapse: true };
}

interface HostGroup {
  hostPattern: string;
  hosts: string[];
  members: Endpoint[];
}

function emptyScore(): NormalizedGroup['score'] {
  return { api: 0, sensitivity: 0, combined: 0 };
}

/**
 * Groups endpoints by method + normalized path, then splits each bucket into
 * the smallest number of host clusters that can be safely represented by a
 * single hostname pattern.
 *
 * Grouping is deterministic: input is sorted before clustering, so results do
 * not depend on API page ordering.
 */
/**
 * Distinct sibling values required before a path position is treated as a
 * variable. Four is deliberately small enough to catch low-cardinality
 * enumerations (a handful of payment providers) but large enough that a couple
 * of genuine sibling resources cannot trigger it.
 */
export const MIN_SIBLINGS_FOR_VARIABLE = 4;

/**
 * Infer variable path positions from sibling evidence across the whole corpus.
 *
 * Per-segment format rules judge each literal in isolation, which makes them
 * inconsistent across members of a single identifier family. Any fixed-length
 * alphanumeric id whose digit ratio straddles the `isHighCardinalitySegment`
 * cutoff is detected for some values and not others, so one logical operation
 * is reported as a `{var1}` group plus a long tail of single-member groups.
 * Prefixed opaque ids split the same way.
 *
 * Sibling analysis is immune to that because it never inspects the literal. If
 * many observed paths share a prefix, a depth *and* an identical continuation,
 * differing only at one position, that position is a variable whatever its
 * values look like. That also covers word-based identifiers — `/c/{category}`,
 * `/p/{slug}`, `/help/{article}` — which no format rule can ever detect, since
 * in isolation they are indistinguishable from static resource names.
 *
 * Requiring an identical continuation is what keeps distinct resources apart:
 * `/products/{id}` and `/orders/{id}` differ downstream, so they never pool.
 *
 * @returns per-path set of positions to treat as variable.
 */
export function inferSiblingVariables(
  paths: readonly string[],
  minSiblings: number = MIN_SIBLINGS_FOR_VARIABLE,
): Map<string, Set<number>> {
  const unique = [...new Set(paths)];
  const rawSegments = new Map<string, string[]>();
  const contextSegments = new Map<string, string[]>();
  for (const path of unique) {
    rawSegments.set(path, path.split('/').filter(Boolean));
    contextSegments.set(path, normalizePath(path).pattern.split('/').filter(Boolean));
  }

  // Literals are tracked per shape so a static sub-page cannot be absorbed by an
  // identifier family that merely shares its position.
  const buckets = new Map<string, { byShape: Map<string, Set<string>>; alreadyVariable: number }>();
  for (const path of unique) {
    const segments = rawSegments.get(path)!;
    const context = contextSegments.get(path)!;
    // Position 0 is never inferred: at the root every distinct resource would
    // pool into one bucket and collapse the entire surface to `/{var1}`.
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];
      // Never let an action or a well-known collection name become an id.
      if (STATIC_SEGMENT_ALLOWLIST.has(segment.toLowerCase())) continue;

      const prefix = context.slice(0, i).join('/');
      const suffix = context.slice(i + 1).join('/');
      const key = `${segments.length}\u0000${i}\u0000${prefix}\u0000${suffix}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { byShape: new Map<string, Set<string>>(), alreadyVariable: 0 };
        buckets.set(key, bucket);
      }

      // A sibling a format rule already flagged counts as evidence that this
      // position holds identifiers, and is the strongest hint available.
      // Half-recognised families depend on it: without these the remaining
      // literals can sit below the threshold on their own.
      if (pathVarIndex(segment) !== null) {
        bucket.alreadyVariable++;
        continue;
      }

      const shape = segmentShape(segment);
      let literals = bucket.byShape.get(shape);
      if (!literals) {
        literals = new Set<string>();
        bucket.byShape.set(shape, literals);
      }
      literals.add(segment);
    }
  }

  // Stage 1: a position is variable for a given shape where enough distinct
  // values of that shape share an identical prefix and continuation.
  const confirmed = new Set<string>();
  for (const [key, bucket] of buckets) {
    const [, position, prefix] = key.split('\u0000');
    for (const [shape, literals] of bucket.byShape) {
      // Already-variable siblings top up the count, but cannot carry a shape on
      // their own: a lone static literal beside four recognised ids would
      // otherwise be absorbed. Two real values of the same shape are the
      // minimum that establishes a family.
      const enough =
        literals.size >= minSiblings ||
        (literals.size >= 2 && literals.size + bucket.alreadyVariable >= minSiblings);
      if (enough) confirmed.add(`${prefix}\u0000${position}\u0000${shape}`);
    }
  }

  // Stage 2: propagate to deeper continuations under the same prefix. Requiring
  // an identical continuation in stage 1 is what stops distinct resources from
  // pooling, but once a position is known to hold identifiers of a given shape,
  // every route below it inherits that: `/items/{id}` and `/items/{id}/detail`
  // carry the same identifier. Sub-resources rely on this, since they are often
  // observed with far fewer values than the collection itself. The shape still
  // has to match, so a static sibling is not swept up on prefix alone.
  const inferred = new Map<string, Set<number>>();
  for (const path of unique) {
    const segments = rawSegments.get(path)!;
    const context = contextSegments.get(path)!;
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];
      if (STATIC_SEGMENT_ALLOWLIST.has(segment.toLowerCase())) continue;
      const prefix = context.slice(0, i).join('/');
      if (!confirmed.has(`${prefix}\u0000${i}\u0000${segmentShape(segment)}`)) continue;
      let positions = inferred.get(path);
      if (!positions) {
        positions = new Set<number>();
        inferred.set(path, positions);
      }
      positions.add(i);
    }
  }
  return inferred;
}

export function groupEndpoints(endpoints: Endpoint[]): NormalizedGroup[] {
  // Bucket by method + normalized path. A nested map avoids the previous
  // delimiter-joined key, which corrupted paths containing the delimiter.
  const byMethod = new Map<string, Map<string, Endpoint[]>>();

  // Corpus-level pre-pass. Sibling evidence spans the whole zone, so it has to
  // be computed before any path is normalized individually.
  const siblingVariables = inferSiblingVariables(endpoints.map((ep) => ep.path));

  for (const ep of endpoints) {
    const { pattern: pathPattern } = normalizePath(ep.path, siblingVariables.get(ep.path));
    const method = ep.method.toUpperCase();
    let byPath = byMethod.get(method);
    if (!byPath) {
      byPath = new Map<string, Endpoint[]>();
      byMethod.set(method, byPath);
    }
    const existing = byPath.get(pathPattern);
    if (existing) {
      existing.push(ep);
    } else {
      byPath.set(pathPattern, [ep]);
    }
  }

  // Cluster first, because the method set has to be scoped to a single host.
  // Keying it by path alone pools unrelated hosts, so `GET api.acme.com/orders`
  // and `POST blog.other.com/orders` would each be credited with a REST method
  // set neither of them has.
  const pending: Array<{ method: string; pathPattern: string; hostPattern: string; members: Endpoint[] }> = [];
  const methodsByShape = new Map<string, Set<string>>();

  const methods = [...byMethod.keys()].sort();
  for (const method of methods) {
    const byPath = byMethod.get(method)!;
    const paths = [...byPath.keys()].sort();

    for (const pathPattern of paths) {
      for (const cluster of clusterByHost(byPath.get(pathPattern)!)) {
        pending.push({ method, pathPattern, hostPattern: cluster.hostPattern, members: cluster.members });

        const shape = `${cluster.hostPattern}\u0000${pathPattern}`;
        const set = methodsByShape.get(shape) ?? new Set<string>();
        set.add(method);
        methodsByShape.set(shape, set);
      }
    }
  }

  const results: NormalizedGroup[] = pending.map(({ method, pathPattern, hostPattern, members }) => ({
    groupId: '',
    normalizedHostPattern: hostPattern,
    normalizedPathPattern: pathPattern,
    method,
    methodsOnPath: [
      ...(methodsByShape.get(`${hostPattern}\u0000${pathPattern}`) ?? new Set([method])),
    ].sort(),
    members,
    recommendedAction: 'manual_review' as const,
    confidence: 0.5,
    score: emptyScore(),
    signals: [],
    reasoning: [],
    flags: [],
  }));

  // Stable IDs assigned after deterministic ordering.
  return results.map((group, idx) => ({
    ...group,
    groupId: `group-${String(idx + 1).padStart(4, '0')}`,
  }));
}

/**
 * Greedily clusters endpoints so each cluster collapses to one safe hostname
 * pattern. Hosts are sorted first so clustering is order-independent.
 */
function clusterByHost(members: Endpoint[]): HostGroup[] {
  const byHost = new Map<string, Endpoint[]>();
  for (const member of members) {
    const host = canonicalizeHost(member.host);
    const existing = byHost.get(host);
    if (existing) existing.push(member);
    else byHost.set(host, [member]);
  }

  const hosts = [...byHost.keys()].sort();
  const clusters: HostGroup[] = [];

  for (const host of hosts) {
    const hostMembers = byHost.get(host)!;
    let placed = false;

    for (const cluster of clusters) {
      const candidateHosts = [...cluster.hosts, host];
      const norm = normalizeHost(candidateHosts);
      if (norm.canCollapse) {
        cluster.hosts = candidateHosts;
        cluster.hostPattern = norm.pattern;
        cluster.members.push(...hostMembers);
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push({
        hostPattern: normalizeHost([host]).pattern,
        hosts: [host],
        members: [...hostMembers],
      });
    }
  }

  return clusters;
}
