import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LineReader } from '../prompt.js';
import {
  buildConnectorConfig,
  fail,
  filterBundle,
  loadConfigOrScaffold,
  loadJson,
  offerToRememberZone,
  optionsAreSelfSufficient,
  parseActionList,
  parseConfidence,
  resolveConfigPath,
  resolveToken,
  selectZoneInteractively,
  timestamp,
  writeFileEnsuringDir,
} from '../cli.js';
import { ValidationError } from '../validate.js';
import { generateBundle } from '../proposal.js';
import { classifyGroup } from '../classify.js';
import { getDefaultCompiledConfig } from '../scoring-config.js';
import type { Endpoint, NormalizedGroup, ProposalBundle } from '../types.js';

const ORIGINAL_FETCH = global.fetch;
const ZONE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

class ProcessExitError extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function emptyList(): Response {
  return jsonResponse({ success: true, result_info: { page: 1, per_page: 100, total_pages: 1 }, result: [] });
}

/** Mocks `global.fetch`. Unmapped paths default to an empty successful page. */
function mockApi(handler?: (url: URL) => Response | undefined): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(value);
    return handler?.(url) ?? emptyList();
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let logSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let errorSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any;
let tmpDir: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aso-cli-'));
  delete process.env.CF_API_TOKEN;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  await fsp.rm(tmpDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loggedLines(spy: any): string {
  return spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

function writtenStdout(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
}

async function writeToken(contents = 'test-token', mode = 0o600): Promise<string> {
  const file = path.join(tmpDir, 'token');
  await fsp.writeFile(file, contents, { encoding: 'utf-8', mode });
  return file;
}

// ------------------------------------------------------------ pure helpers

describe('optionsAreSelfSufficient', () => {
  it('is true with a zoneId and a tokenFile', () => {
    expect(optionsAreSelfSufficient({ zoneId: ZONE_ID, tokenFile: '/x' })).toBe(true);
  });

  it('is true with a zoneId and CF_API_TOKEN, no tokenFile', () => {
    process.env.CF_API_TOKEN = 'tok';
    expect(optionsAreSelfSufficient({ zoneId: ZONE_ID })).toBe(true);
  });

  it('is false without a zoneId', () => {
    process.env.CF_API_TOKEN = 'tok';
    expect(optionsAreSelfSufficient({})).toBe(false);
  });

  it('is false without a token anywhere', () => {
    expect(optionsAreSelfSufficient({ zoneId: ZONE_ID })).toBe(false);
  });
});

describe('parseActionList', () => {
  it('returns undefined for undefined input', () => {
    expect(parseActionList(undefined)).toBeUndefined();
  });

  it('parses a comma-separated list', () => {
    expect(parseActionList('save,ignore')).toEqual(['save', 'ignore']);
  });

  it('normalizes case and hyphens', () => {
    expect(parseActionList('Manual-Review')).toEqual(['manual_review']);
  });

  it('fails loudly on an unknown action', () => {
    expect(() => parseActionList('save,bogus')).toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/unknown action\(s\): bogus/);
  });
});

describe('parseConfidence', () => {
  it('returns undefined for undefined input', () => {
    expect(parseConfidence(undefined)).toBeUndefined();
  });

  it('parses a valid confidence', () => {
    expect(parseConfidence('0.5')).toBe(0.5);
  });

  it('rejects a value above 1', () => {
    expect(() => parseConfidence('1.5')).toThrow(ProcessExitError);
  });

  it('rejects a non-numeric value', () => {
    expect(() => parseConfidence('abc')).toThrow(ProcessExitError);
  });
});

describe('timestamp', () => {
  it('produces a filesystem-safe ISO-like string', () => {
    expect(timestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });
});

describe('writeFileEnsuringDir', () => {
  it('creates missing parent directories', async () => {
    const file = path.join(tmpDir, 'nested', 'deep', 'out.txt');
    await writeFileEnsuringDir(file, 'hello');
    expect(await fsp.readFile(file, 'utf-8')).toBe('hello');
  });

  it('propagates a write failure rather than swallowing it', async () => {
    const dir = path.join(tmpDir, 'readonly');
    await fsp.mkdir(dir);
    await fsp.chmod(dir, 0o500);
    try {
      await expect(writeFileEnsuringDir(path.join(dir, 'sub', 'out.txt'), 'x')).rejects.toThrow();
    } finally {
      await fsp.chmod(dir, 0o700);
    }
  });
});

// ---------------------------------------------------------------- fail/loadJson

describe('fail', () => {
  it('prints the message and exits 1', () => {
    expect(() => fail('boom')).toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toBe('Error: boom');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('loadJson', () => {
  it('names the file and cause on a missing path, never a raw ENOENT', async () => {
    const missing = path.join(tmpDir, 'absent.json');
    await expect(loadJson(missing, 'proposal bundle')).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toContain(`could not read proposal bundle at ${missing}`);
    expect(loggedLines(errorSpy)).not.toMatch(/ENOENT/);
  });

  it('reports invalid JSON distinctly from a missing file', async () => {
    const file = path.join(tmpDir, 'broken.json');
    await fsp.writeFile(file, '{ not json', 'utf-8');
    await expect(loadJson(file, 'proposal bundle')).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toContain(`proposal bundle at ${file} is not valid JSON`);
  });

  it('parses valid JSON', async () => {
    const file = path.join(tmpDir, 'ok.json');
    await fsp.writeFile(file, JSON.stringify({ a: 1 }), 'utf-8');
    await expect(loadJson(file, 'x')).resolves.toEqual({ a: 1 });
  });
});

// --------------------------------------------------------------- resolveToken

describe('resolveToken', () => {
  it('reads a token file and trims it', async () => {
    const file = await writeToken('  secret-token  \n');
    await expect(resolveToken({ tokenFile: file })).resolves.toBe('secret-token');
  });

  it('warns when the token file is group/world readable', async () => {
    const file = await writeToken('secret', 0o644);
    await resolveToken({ tokenFile: file });
    expect(loggedLines(errorSpy)).toMatch(/readable by other users/);
  });

  it('does not warn when the token file is 0600', async () => {
    const file = await writeToken('secret', 0o600);
    await resolveToken({ tokenFile: file });
    expect(loggedLines(errorSpy)).not.toMatch(/readable by other users/);
  });

  it('fails loudly when the token file cannot be read', async () => {
    const missing = path.join(tmpDir, 'nope');
    await expect(resolveToken({ tokenFile: missing })).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toContain(`could not read token file at ${missing}`);
  });

  it('falls back to CF_API_TOKEN when no tokenFile is given', async () => {
    process.env.CF_API_TOKEN = 'env-token';
    await expect(resolveToken({})).resolves.toBe('env-token');
  });

  it('returns undefined when neither channel is set', async () => {
    await expect(resolveToken({})).resolves.toBeUndefined();
  });
});

// ----------------------------------------------------------- resolveConfigPath

describe('resolveConfigPath', () => {
  it('trusts an explicit path without checking existence', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.json');
    await expect(resolveConfigPath(missing)).resolves.toEqual({ path: missing, existed: true });
  });

  it('finds the config file in the current working directory', async () => {
    const file = path.join(tmpDir, 'optimizer.config.json');
    await fsp.writeFile(file, '{}', 'utf-8');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      await expect(resolveConfigPath()).resolves.toEqual({ path: file, existed: true });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('falls back to XDG_CONFIG_HOME when no cwd config exists', async () => {
    const emptyCwd = path.join(tmpDir, 'cwd');
    await fsp.mkdir(emptyCwd);
    const xdgDir = path.join(tmpDir, 'xdg', 'api-shield-optimizer');
    await fsp.mkdir(xdgDir, { recursive: true });
    const xdgFile = path.join(xdgDir, 'config.json');
    await fsp.writeFile(xdgFile, '{}', 'utf-8');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);
    try {
      await expect(resolveConfigPath()).resolves.toEqual({ path: xdgFile, existed: true });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('reports not-existed when neither candidate is present', async () => {
    const emptyCwd = path.join(tmpDir, 'cwd2');
    await fsp.mkdir(emptyCwd);
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg-missing');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);
    try {
      const result = await resolveConfigPath();
      expect(result.existed).toBe(false);
      expect(result.path).toBe(path.join(emptyCwd, 'optimizer.config.json'));
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

// --------------------------------------------------------- loadConfigOrScaffold

describe('loadConfigOrScaffold', () => {
  it('loads an existing config file', async () => {
    const file = path.join(tmpDir, 'optimizer.config.json');
    await fsp.writeFile(file, JSON.stringify({ zoneId: ZONE_ID }), 'utf-8');
    const result = await loadConfigOrScaffold(file);
    expect(result.config.zoneId).toBe(ZONE_ID);
    expect(result.path).toBe(file);
  });

  it('returns an empty config without scaffolding when requireExisting is set', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      const result = await loadConfigOrScaffold(undefined, { requireExisting: true });
      expect(result.config).toEqual({});
      await expect(fsp.access(path.join(tmpDir, 'optimizer.config.json'))).rejects.toThrow();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // Behaviour worth preserving, per AGENTS.md: a self-sufficient invocation is
  // never interrupted by config scaffolding.
  it('does not scaffold when the command line is already self-sufficient', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      const result = await loadConfigOrScaffold(undefined, { alreadySufficient: true });
      expect(result.config).toEqual({});
      await expect(fsp.access(path.join(tmpDir, 'optimizer.config.json'))).rejects.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('scaffolds a template and exits when nothing exists and the command line is insufficient', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      await expect(loadConfigOrScaffold(undefined, {})).rejects.toThrow(ProcessExitError);
      const scaffolded = path.join(tmpDir, 'optimizer.config.json');
      const raw = await fsp.readFile(scaffolded, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ tokenFile: '', zoneId: '', accountId: '', minHits: 0, maxGroups: 0 });
      expect((await fsp.stat(scaffolded)).mode & 0o777).toBe(0o600);
      expect(loggedLines(errorSpy)).toContain(`Created ${scaffolded}`);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('surfaces a malformed existing config as invalid JSON, not a scaffold', async () => {
    const file = path.join(tmpDir, 'optimizer.config.json');
    await fsp.writeFile(file, '{ broken', 'utf-8');
    await expect(loadConfigOrScaffold(file)).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/not valid JSON/);
  });
});

// ------------------------------------------------------------ buildConnectorConfig

describe('buildConnectorConfig', () => {
  it('builds a config from a supplied zoneId and tokenFile', async () => {
    const file = await writeToken();
    const config = await buildConnectorConfig({ zoneId: ZONE_ID, tokenFile: file }, {});
    expect(config.zoneId).toBe(ZONE_ID);
    expect(config.apiToken).toBe('test-token');
    expect(config.useSchemas).toBe(true);
  });

  it('honors --no-schemas', async () => {
    const file = await writeToken();
    const config = await buildConnectorConfig({ zoneId: ZONE_ID, tokenFile: file, schemas: false }, {});
    expect(config.useSchemas).toBe(false);
  });

  // Regression: --zone-id must be validated before the token is resolved, so a
  // malformed zone id is reported as such rather than as a missing token.
  it('validates the zoneId before resolving the token', async () => {
    await expect(
      buildConnectorConfig({ zoneId: '../../evil', tokenFile: path.join(tmpDir, 'does-not-exist') }, {}),
    ).rejects.toThrow(ValidationError);
    // The token file was never touched: no "could not read token file" fail().
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fails loudly when no token is available anywhere', async () => {
    await expect(buildConnectorConfig({ zoneId: ZONE_ID }, {})).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/API token required/);
  });

  it('falls back to the file config for zoneId and tokenFile', async () => {
    const file = await writeToken();
    const config = await buildConnectorConfig({}, { zoneId: ZONE_ID, tokenFile: file });
    expect(config.zoneId).toBe(ZONE_ID);
  });

  it('prompts interactively when no zoneId is supplied anywhere', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/zones')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: ZONE_ID, name: 'picked.example.com', account: { id: 'acct' }, status: 'active' }],
        });
      }
      return emptyList();
    });

    const file = await writeToken();
    const input = Readable.from(['1\n']);
    const output = new Writable({ write(_c, _e, cb) { cb(); } });

    const config = await buildConnectorConfig({ tokenFile: file }, {}, true, undefined, { input, output });
    expect(config.zoneId).toBe(ZONE_ID);
  });
});

describe('selectZoneInteractively', () => {
  function streams(lines: string[]): { input: Readable; output: Writable; text: () => string } {
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    return { input: Readable.from(lines.map((l) => `${l}\n`)), output, text: () => chunks.join('') };
  }

  function mockZones(zones: { id: string; name: string }[]): void {
    mockApi((url) => {
      if (url.pathname.endsWith('/zones')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: zones.map((z) => ({ id: z.id, name: z.name, account: { id: 'a' }, status: 'active' })),
        });
      }
      return emptyList();
    });
  }

  it('returns the selected zone id and lists the options', async () => {
    mockZones([{ id: ZONE_ID, name: 'a.example.com' }, { id: '2'.repeat(32), name: 'b.example.com' }]);
    const s = streams(['2']);
    const id = await selectZoneInteractively('token', undefined, s);
    expect(id).toBe('2'.repeat(32));
    expect(s.text()).toContain('a.example.com');
    expect(s.text()).toContain('b.example.com');
  });

  it('fails on an out-of-range selection', async () => {
    mockZones([{ id: ZONE_ID, name: 'a.example.com' }]);
    const s = streams(['9']);
    await expect(selectZoneInteractively('token', undefined, s)).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/invalid zone selection/);
  });

  it('fails on end of input rather than hanging', async () => {
    mockZones([{ id: ZONE_ID, name: 'a.example.com' }]);
    const s = streams([]);
    await expect(selectZoneInteractively('token', undefined, s)).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/no zone selected/);
  });

  it('fails when the token has no accessible zones', async () => {
    mockZones([]);
    const s = streams(['1']);
    await expect(selectZoneInteractively('token', undefined, s)).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/no zones found/);
  });

  it('offers to remember the zone when a configPath is given and answered yes', async () => {
    mockZones([{ id: ZONE_ID, name: 'a.example.com' }]);
    const configFile = path.join(tmpDir, 'optimizer.config.json');
    await fsp.writeFile(configFile, JSON.stringify({ zoneId: '' }), 'utf-8');

    const s = streams(['1', 'y']);
    const id = await selectZoneInteractively('token', configFile, s);
    expect(id).toBe(ZONE_ID);

    const updated = JSON.parse(await fsp.readFile(configFile, 'utf-8'));
    expect(updated.zoneId).toBe(ZONE_ID);
    expect(s.text()).toMatch(/Saved zoneId/);
  });

  it('leaves the config file untouched when the operator declines', async () => {
    mockZones([{ id: ZONE_ID, name: 'a.example.com' }]);
    const configFile = path.join(tmpDir, 'optimizer.config.json');
    await fsp.writeFile(configFile, JSON.stringify({ zoneId: '' }), 'utf-8');

    const s = streams(['1', 'n']);
    await selectZoneInteractively('token', configFile, s);

    const updated = JSON.parse(await fsp.readFile(configFile, 'utf-8'));
    expect(updated.zoneId).toBe('');
  });
});

function readerOver(lines: string[], output: NodeJS.WritableStream): { reader: LineReader; close: () => void } {
  const rl = createInterface({ input: Readable.from(lines.map((l) => `${l}\n`)), output, terminal: false });
  return { reader: new LineReader(rl, output), close: () => rl.close() };
}

describe('offerToRememberZone', () => {
  it('records the choice when the operator answers yes', async () => {
    const configFile = path.join(tmpDir, 'optimizer.config.json');
    await fsp.writeFile(configFile, JSON.stringify({ zoneId: '' }), 'utf-8');

    const chunks: string[] = [];
    const output = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const { reader, close } = readerOver(['y'], output);
    try {
      await offerToRememberZone(configFile, { id: ZONE_ID, name: 'a.example.com' }, reader, output);
      expect(chunks.join('')).toMatch(/Saved zoneId/);
      expect(JSON.parse(await fsp.readFile(configFile, 'utf-8')).zoneId).toBe(ZONE_ID);
    } finally {
      close();
    }
  });

  it('leaves the config untouched when the operator declines', async () => {
    const configFile = path.join(tmpDir, 'optimizer.config.json');
    await fsp.writeFile(configFile, JSON.stringify({ zoneId: '' }), 'utf-8');

    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    const { reader, close } = readerOver(['n'], output);
    try {
      await offerToRememberZone(configFile, { id: ZONE_ID, name: 'a.example.com' }, reader, output);
      expect(JSON.parse(await fsp.readFile(configFile, 'utf-8')).zoneId).toBe('');
    } finally {
      close();
    }
  });

  it('leaves the config untouched at end of input', async () => {
    const configFile = path.join(tmpDir, 'optimizer.config.json');
    await fsp.writeFile(configFile, JSON.stringify({ zoneId: '' }), 'utf-8');

    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    const { reader, close } = readerOver([], output);
    try {
      await offerToRememberZone(configFile, { id: ZONE_ID, name: 'a.example.com' }, reader, output);
      expect(JSON.parse(await fsp.readFile(configFile, 'utf-8')).zoneId).toBe('');
    } finally {
      close();
    }
  });

  it('reports an unwritable config without throwing', async () => {
    const configFile = path.join(tmpDir, 'optimizer.config.json');
    await fsp.writeFile(configFile, JSON.stringify({ zoneId: '' }), 'utf-8');
    // The file's own write bit, not the directory's — `fs.writeFile` on an
    // existing path only needs permission on the file itself.
    await fsp.chmod(configFile, 0o400);

    const chunks: string[] = [];
    const output = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const { reader, close } = readerOver(['y'], output);
    try {
      await offerToRememberZone(configFile, { id: ZONE_ID, name: 'a.example.com' }, reader, output);
      expect(chunks.join('')).toMatch(/Could not write/);
    } finally {
      close();
      await fsp.chmod(configFile, 0o600);
    }
  });
});

// -------------------------------------------------------------------- filterBundle

function makeEp(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: 'e1',
    accountId: '',
    zoneId: '',
    host: 'api.example.com',
    method: 'GET',
    path: '/api/v1/things',
    source: 'machinelearning',
    hits: 1000,
    lastSeenAt: new Date().toISOString(),
    rawReference: {},
    ...overrides,
  };
}

function makeGroup(id: string, pathPattern: string, method = 'GET'): NormalizedGroup {
  const member = makeEp({ id: `${id}-m`, path: pathPattern, method });
  const group: NormalizedGroup = {
    groupId: id,
    normalizedHostPattern: 'api.example.com',
    normalizedPathPattern: pathPattern,
    method,
    members: [member],
    methodsOnPath: [method],
    recommendedAction: 'manual_review',
    confidence: 0,
    score: { api: 0, sensitivity: 0, combined: 0 },
    signals: [],
    reasoning: [],
    flags: [],
  };
  const classification = classifyGroup(group, getDefaultCompiledConfig());
  return { ...group, ...classification, recommendedAction: classification.action };
}

function bundleOf(count: number): ProposalBundle {
  const groups = Array.from({ length: count }, (_, i) => makeGroup(`g${i}`, `/api/v1/resource${i}`));
  return generateBundle(groups);
}

describe('filterBundle', () => {
  it('returns the same bundle reference when nothing is filtered', () => {
    const bundle = bundleOf(2);
    expect(filterBundle(bundle, undefined, undefined)).toBe(bundle);
  });

  it('filters by action and recomputes summary counts', () => {
    const bundle = bundleOf(3);
    const filtered = filterBundle(bundle, ['manual_review']);
    expect(filtered.proposals.every((p) => p.action === 'manual_review')).toBe(true);
    expect(filtered.summary.saveCount + filtered.summary.ignoreCount).toBe(0);
    expect(filtered.summary.manualReviewCount).toBe(filtered.proposals.length);
  });

  it('filters by minimum confidence', () => {
    const bundle = bundleOf(3);
    const highBar = Math.max(...bundle.proposals.map((p) => p.confidenceScore)) + 0.01;
    const filtered = filterBundle(bundle, undefined, highBar);
    expect(filtered.proposals).toHaveLength(0);
  });

  it('marks the bundle truncated when the filter removes groups', () => {
    const bundle = bundleOf(3);
    const filtered = filterBundle(bundle, ['manual_review']);
    if (filtered.proposals.length < bundle.proposals.length) {
      expect(filtered.scope.truncated).toBe(true);
    }
  });
});

// =====================================================================
// Integration: drive the real Commander wiring end to end.
// =====================================================================

/**
 * Loads a fresh copy of the `cli` module.
 *
 * `program` is a module-level Commander singleton, and Commander's own option
 * values persist across multiple `parseAsync()` calls on the same instance —
 * confirmed directly: parsing `--x hello` once and then parsing again with no
 * `--x` at all still reports `hello` the second time. In production this is
 * invisible (one process, one `parseAsync()` call), but reusing the statically
 * imported `program` across many `it()` blocks here would silently leak one
 * test's flags into the next. `vi.resetModules()` plus a fresh dynamic import
 * gives every call to `run()`/`freshCli()` its own `Command` instance.
 */
async function freshCli(): Promise<typeof import('../cli.js')> {
  vi.resetModules();
  return import('../cli.js');
}

async function run(args: string[]): Promise<void> {
  const cli = await freshCli();
  await cli.program.parseAsync(args, { from: 'user' });
}

describe('program — propose', () => {
  function mockZoneApi(overrides: { discovery?: unknown[]; managed?: unknown[] } = {}): void {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: overrides.discovery ?? [],
        });
      }
      if (url.pathname.endsWith('/api_gateway/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: overrides.managed ?? [],
        });
      }
      return emptyList();
    });
  }

  it('streams a JSON bundle to stdout with --output -', async () => {
    mockZoneApi();
    const file = await writeToken();
    await run([
      'propose',
      '--zone-id', ZONE_ID,
      '--token-file', file,
      '--no-schemas',
      '--format', 'json',
      '--output', '-',
    ]);

    const bundle = JSON.parse(writtenStdout()) as ProposalBundle;
    expect(bundle.rulesetVersion).toBeTruthy();
    expect(bundle.proposals).toEqual([]);
  });

  it('streams a text report with --format text', async () => {
    mockZoneApi();
    const file = await writeToken();
    await run([
      'propose',
      '--zone-id', ZONE_ID,
      '--token-file', file,
      '--no-schemas',
      '--format', 'text',
      '--output', '-',
    ]);
    expect(writtenStdout()).toContain('API Shield Optimizer — Proposal Report');
  });

  it('writes CSV to a file path and reports where', async () => {
    mockZoneApi();
    const file = await writeToken();
    const outPath = path.join(tmpDir, 'out.csv');
    await run([
      'propose',
      '--zone-id', ZONE_ID,
      '--token-file', file,
      '--no-schemas',
      '--format', 'csv',
      '--output', outPath,
    ]);
    const csv = await fsp.readFile(outPath, 'utf-8');
    expect(csv.split('\n')[0]).toContain('groupId');
    expect(loggedLines(errorSpy)).toContain(`Wrote csv output to ${outPath}`);
  });

  it('writes all three formats under output/ when no --output is given', async () => {
    mockZoneApi();
    const file = await writeToken();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      await run(['propose', '--zone-id', ZONE_ID, '--token-file', file, '--no-schemas']);
      const dirents = await fsp.readdir(path.join(tmpDir, 'output'));
      expect(dirents.some((f) => f.endsWith('.json'))).toBe(true);
      expect(dirents.some((f) => f.endsWith('.txt'))).toBe(true);
      expect(dirents.some((f) => f.endsWith('.csv'))).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // Behaviour worth preserving, per AGENTS.md: a self-sufficient invocation is
  // never interrupted by config scaffolding, even with no config file present.
  it('never scaffolds a config file when --zone-id and --token-file are both supplied', async () => {
    mockZoneApi();
    const file = await writeToken();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      await run([
        'propose',
        '--zone-id', ZONE_ID,
        '--token-file', file,
        '--no-schemas',
        '--output', '-',
      ]);
      await expect(fsp.access(path.join(tmpDir, 'optimizer.config.json'))).rejects.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('scaffolds a config file and exits when nothing is self-sufficient', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      await expect(run(['propose'])).rejects.toThrow(ProcessExitError);
      await expect(fsp.access(path.join(tmpDir, 'optimizer.config.json'))).resolves.toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('rejects an unsupported --format', async () => {
    mockZoneApi();
    const file = await writeToken();
    await expect(
      run([
        'propose',
        '--zone-id', ZONE_ID,
        '--token-file', file,
        '--no-schemas',
        '--format', 'xml',
        '--output', '-',
      ]),
    ).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/--format must be json, text, or csv/);
  });

  it('applies --only to filter the reported actions', async () => {
    mockZoneApi({
      discovery: [
        {
          id: 'd-1',
          host: 'www.acme.com',
          method: 'GET',
          endpoint: '/about-us',
          state: 'review',
          labels: [{ name: 'cf-web-page', source: 'managed' }],
        },
      ],
    });
    const file = await writeToken();
    await run([
      'propose',
      '--zone-id', ZONE_ID,
      '--token-file', file,
      '--no-schemas',
      '--only', 'save',
      '--format', 'json',
      '--output', '-',
    ]);
    const bundle = JSON.parse(writtenStdout()) as ProposalBundle;
    expect(bundle.proposals).toHaveLength(0);
  });
});

describe('program — zones', () => {
  it('prints zones as JSON to stdout', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/zones')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: ZONE_ID, name: 'a.example.com', account: { id: 'acct' }, status: 'active' }],
        });
      }
      return emptyList();
    });
    const file = await writeToken();
    await run(['zones', '--token-file', file]);
    const zones = JSON.parse(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(''));
    expect(zones).toEqual([{ id: ZONE_ID, name: 'a.example.com', accountId: 'acct', status: 'active', plan: '' }]);
  });

  it('writes zones to a file when --output is given', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/zones')) return jsonResponse({ success: true, result: [] });
      return emptyList();
    });
    const file = await writeToken();
    const outPath = path.join(tmpDir, 'zones.json');
    await run(['zones', '--token-file', file, '--output', outPath]);
    await expect(fsp.access(outPath)).resolves.toBeUndefined();
    expect(loggedLines(errorSpy)).toContain(`Zones written to ${outPath}`);
  });

  it('fails loudly when no token is configured, without scaffolding', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      await expect(run(['zones'])).rejects.toThrow(ProcessExitError);
      expect(loggedLines(errorSpy)).toMatch(/API token required/);
      // `zones` uses requireExisting, so it never scaffolds either.
      await expect(fsp.access(path.join(tmpDir, 'optimizer.config.json'))).rejects.toThrow();
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe('program — smoke-fetch', () => {
  it('reports discovery/managed counts and pages fetched', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: 'd-1', host: 'api.example.com', method: 'GET', endpoint: '/a', state: 'review' }],
        });
      }
      return emptyList();
    });
    const file = await writeToken();
    await run(['smoke-fetch', '--zone-id', ZONE_ID, '--token-file', file, '--no-schemas']);
    expect(loggedLines(logSpy)).toContain('Discovery operations: 1 (pages fetched: 1)');
  });

  // Regression: schema-operation truncation must be surfaced in the same
  // summary line as discovery/managed truncation.
  it('reports YES when only the schema fetch is truncated', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) return emptyList();
      if (url.pathname.endsWith('/api_gateway/operations')) return emptyList();
      if (url.pathname.endsWith('/user_schemas')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ schema_id: 'schema-1', name: 'public' }],
        });
      }
      if (url.pathname.endsWith('/user_schemas/schema-1/operations')) {
        return jsonResponse({
          success: true,
          result: Array.from({ length: 100 }, (_, i) => ({
            host: 'api.example.com',
            method: 'GET',
            endpoint: `/op/${i}`,
          })),
        });
      }
      throw new Error(`unexpected URL ${url.toString()}`);
    });
    const file = await writeToken();
    await run(['smoke-fetch', '--zone-id', ZONE_ID, '--token-file', file]);
    expect(loggedLines(logSpy)).toContain('Truncated:            YES — the zone exceeds the fetch cap, results are partial');
  }, 30_000);

  it('reports discarded malformed records', async () => {
    mockApi((url) => {
      if (url.pathname.endsWith('/discovery/operations')) {
        return jsonResponse({
          success: true,
          result_info: { page: 1, per_page: 100, total_pages: 1 },
          result: [{ id: 'bad' }],
        });
      }
      return emptyList();
    });
    const file = await writeToken();
    await run(['smoke-fetch', '--zone-id', ZONE_ID, '--token-file', file, '--no-schemas']);
    expect(loggedLines(logSpy)).toMatch(/Discarded records:\s+1/);
  });
});

describe('program — export-payload', () => {
  async function writeBundle(overrides: Partial<ProposalBundle> = {}): Promise<string> {
    const bundle = { ...bundleOf(1), ...overrides };
    const file = path.join(tmpDir, 'bundle.json');
    await fsp.writeFile(file, JSON.stringify(bundle), 'utf-8');
    return file;
  }

  it('rejects manual_review in --only before doing anything else', async () => {
    const bundleFile = await writeBundle();
    await expect(
      run(['export-payload', '--bundle', bundleFile, '--only', 'manual_review']),
    ).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/manual_review proposals cannot be exported/);
  });

  it('streams the payload to stdout with --output -', async () => {
    const bundleFile = await writeBundle();
    await run(['export-payload', '--bundle', bundleFile, '--output', '-']);
    const payload = JSON.parse(writtenStdout());
    expect(payload.warning).toMatch(/never writes to the Cloudflare API/);
  });

  it('notes a missing zone id placeholder', async () => {
    // The placeholder note is only reachable on the file-write path: `--output
    // -` returns immediately after streaming the JSON payload, before it.
    const bundleFile = await writeBundle({ scope: { ...bundleOf(1).scope, zoneId: '' } });
    const outPath = path.join(tmpDir, 'payload.json');
    await run(['export-payload', '--bundle', bundleFile, '--output', outPath]);
    expect(loggedLines(errorSpy)).toMatch(/bundle carries no zone ID/);
  });

  it('writes to a default output path and reports counts', async () => {
    const bundleFile = await writeBundle();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      await run(['export-payload', '--bundle', bundleFile]);
      const dirents = await fsp.readdir(path.join(tmpDir, 'output'));
      expect(dirents.some((f) => f.startsWith('ApiShieldPayload-'))).toBe(true);
      expect(loggedLines(errorSpy)).toMatch(/Save operations:/);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe('program — review', () => {
  it('requires --bundle', async () => {
    await expect(run(['review'])).rejects.toThrow(ProcessExitError);
  });

  // Drives the empty-queue path (`--only ignore` against a bundle whose
  // fixtures all classify `save`), which returns before ever touching
  // `process.stdin` — exercising the CLI's own wiring (bundle load, decision
  // file write, next-step message) without needing to fake interactive input.
  it('writes a decision file even when nothing matches the filter', async () => {
    const bundle = bundleOf(2);
    expect(bundle.proposals.every((p) => p.action === 'save')).toBe(true);
    const bundleFile = path.join(tmpDir, 'bundle.json');
    await fsp.writeFile(bundleFile, JSON.stringify(bundle), 'utf-8');
    const outPath = path.join(tmpDir, 'decisions.json');

    await run(['review', '--bundle', bundleFile, '--only', 'ignore', '--output', outPath]);

    const decisionFile = JSON.parse(await fsp.readFile(outPath, 'utf-8'));
    expect(decisionFile.decisions).toEqual([]);
    expect(loggedLines(errorSpy)).toContain(`Decision file written to ${outPath}`);
  });

  it('warns when the decision file ruleset does not match the bundle', async () => {
    const bundle = bundleOf(2);
    const bundleFile = path.join(tmpDir, 'bundle.json');
    await fsp.writeFile(bundleFile, JSON.stringify(bundle), 'utf-8');

    const decisionsFile = path.join(tmpDir, 'old-decisions.json');
    await fsp.writeFile(
      decisionsFile,
      JSON.stringify({ rulesetVersion: 'stale-version', decidedAt: new Date().toISOString(), decisions: [] }),
      'utf-8',
    );

    await run([
      'review',
      '--bundle', bundleFile,
      '--decisions', decisionsFile,
      '--only', 'ignore',
      '--output', path.join(tmpDir, 'out.json'),
    ]);

    expect(loggedLines(errorSpy)).toMatch(/decision file was produced with ruleset stale-version/);
  });

  it('rejects a bundle file with no proposals array', async () => {
    const bundleFile = path.join(tmpDir, 'bad-bundle.json');
    await fsp.writeFile(bundleFile, JSON.stringify({ not: 'a bundle' }), 'utf-8');
    await expect(run(['review', '--bundle', bundleFile])).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/does not contain a proposals array/);
  });
});

// --------------------------------------------------------------------- main()

describe('main', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('translates a ValidationError from deep in an action into fail()', async () => {
    process.argv = ['node', 'cli', 'propose', '--zone-id', '../../evil', '--token-file', '/nonexistent'];
    const cli = await freshCli();
    await expect(cli.main()).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toMatch(/zoneId must be a 32-character hexadecimal/);
  });

  it('translates a generic Error into fail() with its message', async () => {
    process.argv = ['node', 'cli', 'export-payload', '--bundle', path.join(tmpDir, 'missing.json')];
    const cli = await freshCli();
    await expect(cli.main()).rejects.toThrow(ProcessExitError);
    expect(loggedLines(errorSpy)).toContain('could not read proposal bundle at');
  });
});
