/**
 * Config file persistence.
 *
 * This is the only place the tool modifies a file the operator wrote by hand,
 * so it is deliberately narrow: one field, never destructive on failure, and
 * separated from `cli.ts` so it can be tested.
 */

export type SaveZoneResult = 'saved' | 'unreadable' | 'unwritable' | 'unchanged';

/**
 * Rewrites only the `zoneId` field, preserving every other key and the file's
 * existing permissions. Returns a status rather than throwing so a failure to
 * remember a preference never aborts the run that produced it.
 */
export async function saveZoneIdToConfig(configPath: string, zoneId: string): Promise<SaveZoneResult> {
  const fs = await import('node:fs/promises');

  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch {
    return 'unreadable';
  }

  let current: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unreadable';
    current = parsed as Record<string, unknown>;
  } catch {
    return 'unreadable';
  }

  if (current.zoneId === zoneId) return 'unchanged';

  try {
    // Overwriting in place keeps the existing mode. The config holds no secret,
    // but silently widening permissions on a user's file is still wrong.
    await fs.writeFile(configPath, `${JSON.stringify({ ...current, zoneId }, null, 2)}\n`, 'utf-8');
    return 'saved';
  } catch {
    return 'unwritable';
  }
}
