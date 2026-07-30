/**
 * Input validation for values that reach the Cloudflare API URL.
 *
 * Cloudflare zone and account identifiers are 32 lowercase hex characters.
 * These values are interpolated into API request paths, so they MUST be
 * validated before use: `new URL()` resolves `..` segments, which would
 * otherwise let a caller redirect the request to an arbitrary Cloudflare API
 * path using the tool's credentials.
 */

const CLOUDFLARE_ID_RE = /^[0-9a-f]{32}$/;

export const ALLOWED_DISCOVERY_STATES = ['review', 'saved', 'ignored'] as const;
export type DiscoveryState = (typeof ALLOWED_DISCOVERY_STATES)[number];

export class ValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function isCloudflareId(value: unknown): value is string {
  return typeof value === 'string' && CLOUDFLARE_ID_RE.test(value);
}

/** Validates a zone/account identifier, throwing `ValidationError` when unsafe. */
export function assertCloudflareId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${label} is required`);
  }
  const normalized = value.trim().toLowerCase();
  if (!CLOUDFLARE_ID_RE.test(normalized)) {
    throw new ValidationError(`${label} must be a 32-character hexadecimal Cloudflare identifier`);
  }
  return normalized;
}

export function assertOptionalCloudflareId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return undefined;
  }
  return assertCloudflareId(value, label);
}

function isDiscoveryState(value: string): value is DiscoveryState {
  return (ALLOWED_DISCOVERY_STATES as readonly string[]).includes(value);
}

/**
 * Parses a comma-separated discovery state filter against a strict allowlist.
 * Unknown values are rejected rather than forwarded to the Cloudflare API.
 */
export function parseDiscoveryStates(raw: string | null | undefined): DiscoveryState[] {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return [...ALLOWED_DISCOVERY_STATES];
  }

  const requested = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  if (requested.length === 0) {
    return [...ALLOWED_DISCOVERY_STATES];
  }

  const invalid = requested.filter((item) => !isDiscoveryState(item));
  if (invalid.length > 0) {
    throw new ValidationError(
      `Unsupported discovery state(s): ${invalid.join(', ')}. Allowed: ${ALLOWED_DISCOVERY_STATES.join(', ')}`,
    );
  }

  return [...new Set(requested as DiscoveryState[])];
}

/** Parses a bounded positive integer, throwing on out-of-range input. */
export function parseBoundedInt(
  raw: string | number | null | undefined,
  label: string,
  opts: { min: number; max: number },
): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ValidationError(`${label} must be an integer`);
  }
  if (parsed < opts.min || parsed > opts.max) {
    throw new ValidationError(`${label} must be between ${opts.min} and ${opts.max}`);
  }
  return parsed;
}
