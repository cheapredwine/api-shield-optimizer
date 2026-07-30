import { describe, expect, it } from 'vitest';
import { saveZoneIdToConfig } from '../config.js';

const ZONE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** Writes `contents` to a temp file, runs `fn`, then removes it. */
async function withFile<T>(contents: string, fn: (file: string) => Promise<T>): Promise<T> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const file = path.join(os.tmpdir(), `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(file, contents, { encoding: 'utf-8', mode: 0o600 });
  try {
    return await fn(file);
  } finally {
    await fs.rm(file, { force: true });
  }
}

async function read(file: string): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  return JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
}

describe('saveZoneIdToConfig', () => {
  it('sets zoneId and preserves every other key', async () => {
    const original = {
      mode: 'api',
      tokenFile: '/home/me/.cf_token',
      zoneId: '',
      accountId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      minHits: 0,
      scoring: { rulesetVersion: 'custom' },
    };

    await withFile(JSON.stringify(original, null, 2), async (file) => {
      expect(await saveZoneIdToConfig(file, ZONE_ID)).toBe('saved');

      const updated = await read(file);
      expect(updated.zoneId).toBe(ZONE_ID);
      expect(updated.tokenFile).toBe('/home/me/.cf_token');
      expect(updated.accountId).toBe(original.accountId);
      expect(updated.minHits).toBe(0);
      expect(updated.scoring).toEqual({ rulesetVersion: 'custom' });
    });
  });

  it('never widens file permissions', async () => {
    const fs = await import('node:fs/promises');

    await withFile(JSON.stringify({ tokenFile: '/home/me/.cf_token', zoneId: '' }), async (file) => {
      const before = (await fs.stat(file)).mode & 0o777;
      await saveZoneIdToConfig(file, ZONE_ID);
      const after = (await fs.stat(file)).mode & 0o777;

      expect(after).toBe(before);
      expect(after & 0o077).toBe(0);
    });
  });

  it('reports unchanged when the zone already matches', async () => {
    await withFile(JSON.stringify({ zoneId: ZONE_ID }), async (file) => {
      expect(await saveZoneIdToConfig(file, ZONE_ID)).toBe('unchanged');
    });
  });

  it('overwrites a previously stored zone', async () => {
    const previous = '11111111111111111111111111111111';
    await withFile(JSON.stringify({ zoneId: previous }), async (file) => {
      expect(await saveZoneIdToConfig(file, ZONE_ID)).toBe('saved');
      expect((await read(file)).zoneId).toBe(ZONE_ID);
    });
  });

  it('leaves malformed JSON untouched', async () => {
    const fs = await import('node:fs/promises');
    const broken = '{ this is not json';

    await withFile(broken, async (file) => {
      expect(await saveZoneIdToConfig(file, ZONE_ID)).toBe('unreadable');
      expect(await fs.readFile(file, 'utf-8')).toBe(broken);
    });
  });

  it('refuses a JSON array', async () => {
    await withFile('[1,2,3]', async (file) => {
      expect(await saveZoneIdToConfig(file, ZONE_ID)).toBe('unreadable');
    });
  });

  it('refuses JSON null', async () => {
    await withFile('null', async (file) => {
      expect(await saveZoneIdToConfig(file, ZONE_ID)).toBe('unreadable');
    });
  });

  it('reports unreadable for a missing file rather than creating one', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');

    const missing = path.join(os.tmpdir(), `cfg-absent-${Date.now()}.json`);
    expect(await saveZoneIdToConfig(missing, ZONE_ID)).toBe('unreadable');

    await expect(fs.access(missing)).rejects.toThrow();
  });

  it('writes valid JSON with a trailing newline', async () => {
    const fs = await import('node:fs/promises');
    await withFile(JSON.stringify({ zoneId: '' }), async (file) => {
      await saveZoneIdToConfig(file, ZONE_ID);
      const raw = await fs.readFile(file, 'utf-8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });
});
