import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DISCOVERY_STATES,
  ValidationError,
  assertCloudflareId,
  assertOptionalCloudflareId,
  isCloudflareId,
  parseBoundedInt,
  parseDiscoveryStates,
} from '../validate.js';

const ZONE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

// `isCloudflareId` is exported via `index.ts` for library consumers but never
// called internally — nothing in this codebase's own control flow exercised
// it before this file.
describe('isCloudflareId', () => {
  it('accepts a canonical 32-character lowercase hex id', () => {
    expect(isCloudflareId(ZONE_ID)).toBe(true);
  });

  it('rejects uppercase hex', () => {
    expect(isCloudflareId(ZONE_ID.toUpperCase())).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(isCloudflareId(ZONE_ID.slice(0, -1))).toBe(false);
    expect(isCloudflareId(`${ZONE_ID}0`)).toBe(false);
  });

  it('rejects a path-traversal attempt', () => {
    expect(isCloudflareId('../../user/tokens')).toBe(false);
  });

  it('rejects non-string values without throwing', () => {
    expect(isCloudflareId(undefined)).toBe(false);
    expect(isCloudflareId(null)).toBe(false);
    expect(isCloudflareId(12345)).toBe(false);
    expect(isCloudflareId({})).toBe(false);
  });
});

describe('assertCloudflareId', () => {
  it('normalizes to lowercase', () => {
    expect(assertCloudflareId(ZONE_ID.toUpperCase(), 'zoneId')).toBe(ZONE_ID);
  });

  it('throws ValidationError, not a generic Error, for an unsafe value', () => {
    expect(() => assertCloudflareId('../../accounts', 'zoneId')).toThrow(ValidationError);
  });

  it('names the field in the error message', () => {
    expect(() => assertCloudflareId('', 'accountId')).toThrow(/accountId is required/);
  });
});

describe('assertOptionalCloudflareId', () => {
  it('passes through undefined, null and empty string as undefined', () => {
    expect(assertOptionalCloudflareId(undefined, 'accountId')).toBeUndefined();
    expect(assertOptionalCloudflareId(null, 'accountId')).toBeUndefined();
    expect(assertOptionalCloudflareId('   ', 'accountId')).toBeUndefined();
  });

  it('still validates a supplied value', () => {
    expect(() => assertOptionalCloudflareId('not-an-id', 'accountId')).toThrow(ValidationError);
  });
});

describe('parseDiscoveryStates', () => {
  it('defaults to every allowed state when unset', () => {
    expect(parseDiscoveryStates(undefined)).toEqual([...ALLOWED_DISCOVERY_STATES]);
    expect(parseDiscoveryStates(null)).toEqual([...ALLOWED_DISCOVERY_STATES]);
    expect(parseDiscoveryStates('')).toEqual([...ALLOWED_DISCOVERY_STATES]);
  });

  // Regression coverage: a string that is non-empty but reduces to zero
  // tokens after trimming and filtering (e.g. stray commas) took the same
  // "default to everything" path as an absent filter, but through a
  // different branch that had never been exercised.
  it('defaults to every allowed state when only separators are given', () => {
    expect(parseDiscoveryStates(',, ,')).toEqual([...ALLOWED_DISCOVERY_STATES]);
  });

  it('parses a valid subset', () => {
    expect(parseDiscoveryStates('review,saved')).toEqual(['review', 'saved']);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(parseDiscoveryStates(' REVIEW , Saved ')).toEqual(['review', 'saved']);
  });

  it('deduplicates repeated states', () => {
    expect(parseDiscoveryStates('review,review,saved')).toEqual(['review', 'saved']);
  });

  it('rejects a state outside the allowlist', () => {
    expect(() => parseDiscoveryStates('review,../../evil')).toThrow(ValidationError);
  });
});

describe('parseBoundedInt', () => {
  it('returns undefined for undefined, null and empty string', () => {
    expect(parseBoundedInt(undefined, 'minHits', { min: 0, max: 10 })).toBeUndefined();
    expect(parseBoundedInt(null, 'minHits', { min: 0, max: 10 })).toBeUndefined();
    expect(parseBoundedInt('', 'minHits', { min: 0, max: 10 })).toBeUndefined();
  });

  it('accepts a numeric string within range', () => {
    expect(parseBoundedInt('5', 'minHits', { min: 0, max: 10 })).toBe(5);
  });

  it('accepts a number directly, not just a string', () => {
    expect(parseBoundedInt(5, 'minHits', { min: 0, max: 10 })).toBe(5);
  });

  it('accepts the boundary values themselves', () => {
    expect(parseBoundedInt(0, 'minHits', { min: 0, max: 10 })).toBe(0);
    expect(parseBoundedInt(10, 'minHits', { min: 0, max: 10 })).toBe(10);
  });

  it('rejects a value below the minimum', () => {
    expect(() => parseBoundedInt(-1, 'minHits', { min: 0, max: 10 })).toThrow(ValidationError);
    expect(() => parseBoundedInt(-1, 'minHits', { min: 0, max: 10 })).toThrow(/minHits must be between 0 and 10/);
  });

  it('rejects a value above the maximum', () => {
    expect(() => parseBoundedInt(11, 'maxGroups', { min: 0, max: 10 })).toThrow(ValidationError);
  });

  it('rejects a non-integer number', () => {
    expect(() => parseBoundedInt(1.5, 'minHits', { min: 0, max: 10 })).toThrow(ValidationError);
    expect(() => parseBoundedInt('1.5', 'minHits', { min: 0, max: 10 })).toThrow(ValidationError);
  });

  it('rejects a non-numeric string', () => {
    expect(() => parseBoundedInt('abc', 'minHits', { min: 0, max: 10 })).toThrow(/minHits must be an integer/);
  });

  // Regression: `Number.parseInt` stops at the first non-digit character
  // rather than rejecting the rest of the string, so a garbage-suffixed value
  // silently truncated to its leading digits instead of failing loudly.
  it('rejects a numeric string with trailing garbage, rather than truncating it', () => {
    expect(() => parseBoundedInt('5abc', 'minHits', { min: 0, max: 10 })).toThrow(ValidationError);
    expect(() => parseBoundedInt('5e10', 'maxGroups', { min: 0, max: 100 })).toThrow(ValidationError);
  });

  it('rejects Infinity and NaN', () => {
    expect(() => parseBoundedInt(Infinity, 'minHits', { min: 0, max: 10 })).toThrow(ValidationError);
    expect(() => parseBoundedInt(Number.NaN, 'minHits', { min: 0, max: 10 })).toThrow(ValidationError);
  });

  it('names the field in every error message', () => {
    expect(() => parseBoundedInt('abc', 'operationBudget', { min: 1, max: 100 })).toThrow(/operationBudget/);
  });
});
