#!/usr/bin/env node
import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { LineReader, type PromptStreams } from './prompt.js';
import { saveZoneIdToConfig } from './config.js';
import { ShieldOptimizerAgent } from './agent.js';
import { CloudflareApiConnector } from './connectors/index.js';
import { formatBundleAsText } from './format.js';
import { buildApplyPayload, bundleToCsv } from './export.js';
import { runInteractiveReview } from './review.js';
import type { Action, ConnectorConfig, DecisionFile, ProposalBundle } from './types.js';
import type { ScoringConfig } from './scoring-config.js';
import { ValidationError, assertCloudflareId, parseBoundedInt, parseDiscoveryStates } from './validate.js';

export interface ConfigFile {
  tokenFile?: string;
  zoneId?: string;
  accountId?: string;
  minHits?: number;
  maxGroups?: number;
  operationBudget?: number;
  maxMembers?: number;
  output?: string;
  state?: string;
  useSchemas?: boolean;
  excludeDecided?: boolean;
  scoring?: Partial<ScoringConfig>;
}

const DEFAULT_CONFIG_FILENAME = 'optimizer.config.json';

const DEFAULT_CONFIG: ConfigFile = {
  tokenFile: '',
  zoneId: '',
  accountId: '',
  minHits: 0,
  maxGroups: 0,
};

/**
 * Exported so tests can drive individual CLI helpers directly, without going
 * through `program.parseAsync()` and without a real `process.exit`. Not part
 * of the package's public API (see `index.ts`, which does not re-export this
 * module) — this is a testing seam, not a supported import for consumers.
 */
export function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

export async function loadJson<T>(path: string, label: string): Promise<T> {
  const fs = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch {
    fail(`could not read ${label} at ${path}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    fail(`${label} at ${path} is not valid JSON`);
  }
}

/**
 * Resolves the config file location in a predictable order so running the tool
 * from a different working directory does not silently create a second config.
 *
 *   1. `--config <path>`
 *   2. `./optimizer.config.json`
 *   3. `$XDG_CONFIG_HOME/api-shield-optimizer/config.json`
 */
export async function resolveConfigPath(explicit?: string): Promise<{ path: string; existed: boolean }> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  if (explicit) {
    return { path: explicit, existed: true };
  }

  const candidates = [
    path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME),
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
      'api-shield-optimizer',
      'config.json',
    ),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { path: candidate, existed: true };
    } catch {
      // try next candidate
    }
  }

  return { path: candidates[0], existed: false };
}

/**
 * True when the command line alone carries everything needed to run, so no
 * config file has to exist.
 *
 * A run needs a zone plus a token, and the token legitimately arrives from the
 * environment rather than from any flag.
 */
export function optionsAreSelfSufficient(opts: { zoneId?: string; tokenFile?: string }): boolean {
  const hasToken = Boolean(opts.tokenFile ?? process.env.CF_API_TOKEN);
  return Boolean(opts.zoneId) && hasToken;
}

/** Loads config, creating a template on first run. Returns the resolved path so
 *  callers can persist choices back to it. */
export async function loadConfigOrScaffold(
  explicit?: string,
  opts: { requireExisting?: boolean; alreadySufficient?: boolean } = {},
): Promise<{ config: ConfigFile; path?: string }> {
  const resolved = await resolveConfigPath(explicit);

  if (resolved.existed) {
    return { config: await loadJson<ConfigFile>(resolved.path, 'config file'), path: resolved.path };
  }

  if (opts.requireExisting) {
    return { config: {} };
  }

  // The config file exists to spare the user from repeating connection details,
  // so demanding one when the command line already carries everything is pure
  // friction.
  if (opts.alreadySufficient) {
    return { config: {} };
  }

  const fs = await import('node:fs/promises');
  await fs.writeFile(resolved.path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  console.error(`Created ${resolved.path}. Add your token file path and zone ID, then re-run.`);
  process.exit(1);
}

/**
 * Resolves the API token from `tokenFile`, falling back to `CF_API_TOKEN`.
 *
 * These are the only two channels by design. There is no command-line flag,
 * because an argument is visible in shell history and in the process list; and
 * the config file holds no inline token, so the config can be copied or shared
 * without carrying a secret.
 */
export async function resolveToken(opts: { tokenFile?: string }): Promise<string | undefined> {
  if (opts.tokenFile) {
    const fs = await import('node:fs/promises');
    try {
      const stat = await fs.stat(opts.tokenFile);
      // Warn loudly if the token file is group/world readable.
      if ((stat.mode & 0o077) !== 0) {
        console.error(
          `Warning: token file ${opts.tokenFile} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}). ` +
            'Run `chmod 600` on it.',
        );
      }
      return (await fs.readFile(opts.tokenFile, 'utf-8')).trim();
    } catch {
      fail(`could not read token file at ${opts.tokenFile}`);
    }
  }

  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  return undefined;
}

/**
 * Prompts for a zone and offers to remember the choice.
 *
 * `configPath` is where the selection is persisted. Without it the prompt still
 * works, it just cannot be remembered. `streams` defaults to `process.stdin`/
 * `process.stderr`; tests inject a `Readable`/`Writable` pair instead of
 * mutating global `process.stdin`.
 *
 * Both prompts share a single `readline.Interface`/`LineReader`, rather than
 * each opening and closing its own via a separate `askOnce()` call. A second
 * `askOnce()` recreates the exact "line arrives before the next `question`
 * call" hazard `LineReader` exists to prevent (see `prompt.ts`), just one
 * level up: if the input stream delivers both answers before the first
 * `readline.Interface` closes, that first interface's own `LineReader` queues
 * the second line internally and takes it down with it on `close()` — the
 * second `askOnce()` then opens a fresh, empty `LineReader` and waits forever
 * on a stream that already ended.
 */
export async function selectZoneInteractively(
  apiToken: string,
  configPath?: string,
  streams: PromptStreams = {},
): Promise<string> {
  const connector = new CloudflareApiConnector();
  const zones = await connector.listZones(apiToken);
  const output = streams.output ?? process.stderr;
  const err = (line: string): void => {
    output.write(`${line}\n`);
  };

  if (zones.length === 0) {
    fail('no zones found for this token');
  }

  err('Available zones:');
  zones.forEach((z, i) => {
    err(`  ${i + 1}. ${z.name} (${z.id})`);
  });

  const rl = createInterface({ input: streams.input ?? process.stdin, output, terminal: false });
  const reader = new LineReader(rl, output);

  try {
    const answer = await reader.ask('Select zone number: ');

    // End of input. Fail loudly rather than hanging on a promise that will
    // never settle, which is what the previous readline callback did.
    if (answer === null) {
      fail('no zone selected (end of input). Pass --zone-id, or set zoneId in the config, to run non-interactively.');
    }

    const idx = Number.parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= zones.length) {
      fail(`invalid zone selection '${answer}'; expected a number between 1 and ${zones.length}`);
    }

    const selected = zones[idx];

    if (configPath) {
      await offerToRememberZone(configPath, selected, reader, output);
    }

    return selected.id;
  } finally {
    rl.close();
  }
}

/**
 * Asks before editing the config file. The file is hand-authored, so it is not
 * modified without consent, and only the `zoneId` field is touched.
 *
 * Takes an existing `LineReader` rather than opening its own — see the note on
 * `selectZoneInteractively`, its only caller.
 */
export async function offerToRememberZone(
  configPath: string,
  zone: { id: string; name: string },
  reader: LineReader,
  output: NodeJS.WritableStream,
): Promise<void> {
  const err = (line: string): void => {
    output.write(`${line}\n`);
  };
  const answer = await reader.ask(`Remember ${zone.name} as zoneId in ${configPath}? [y/N]: `);
  if (answer === null || !/^y(es)?$/i.test(answer)) return;

  const result = await saveZoneIdToConfig(configPath, zone.id);

  switch (result) {
    case 'saved':
      err(`Saved zoneId to ${configPath}.`);
      break;
    case 'unchanged':
      break;
    case 'unreadable':
      err(`Could not parse ${configPath}; leaving it unchanged.`);
      break;
    case 'unwritable':
      err(`Could not write ${configPath}; leaving it unchanged.`);
      break;
  }
}

export function parseActionList(raw: string | undefined): Action[] | undefined {
  if (!raw) return undefined;
  const valid: Action[] = ['save', 'ignore', 'manual_review'];
  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/-/g, '_'))
    .filter(Boolean);
  const invalid = requested.filter((r) => !valid.includes(r as Action));
  if (invalid.length > 0) {
    fail(`unknown action(s): ${invalid.join(', ')}. Allowed: ${valid.join(', ')}`);
  }
  return requested as Action[];
}

export function parseConfidence(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail('--min-confidence must be between 0 and 1');
  }
  return value;
}

export async function writeFileEnsuringDir(filePath: string, contents: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  // Resolve once and reuse the same absolute path for both calls. Passing the
  // original (possibly relative) `filePath` to `writeFile` after resolving a
  // separate absolute path just for `mkdir` relies on the two calls agreeing
  // on `process.cwd()` by coincidence rather than by construction.
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, contents, 'utf-8');
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Applies action/confidence filters to a bundle, recomputing the summary. */
export function filterBundle(bundle: ProposalBundle, only?: Action[], minConfidence?: number): ProposalBundle {
  if (!only && minConfidence === undefined) return bundle;

  const proposals = bundle.proposals.filter((p) => {
    if (only && only.length > 0 && !only.includes(p.action)) return false;
    if (minConfidence !== undefined && p.confidenceScore < minConfidence) return false;
    return true;
  });

  return {
    ...bundle,
    scope: {
      ...bundle.scope,
      groupCount: proposals.length,
      endpointCount: proposals.reduce((s, p) => s + p.target.membersCount, 0),
      truncated: bundle.scope.analyzedGroupCount > proposals.length,
    },
    proposals,
    summary: {
      ...bundle.summary,
      saveCount: proposals.filter((p) => p.action === 'save').length,
      ignoreCount: proposals.filter((p) => p.action === 'ignore').length,
      manualReviewCount: proposals.filter((p) => p.action === 'manual_review').length,
    },
  };
}

export interface SharedOpts {
  config?: string;
  tokenFile?: string;
  zoneId?: string;
  accountId?: string;
}

export async function buildConnectorConfig(
  opts: SharedOpts & { state?: string; schemas?: boolean },
  fileConfig: ConfigFile,
  requireZone = true,
  configPath?: string,
  streams: PromptStreams = {},
): Promise<ConnectorConfig> {
  // Check anything the user typed before checking what they may not have set up
  // yet. A malformed --zone-id otherwise surfaces as "API token required",
  // which points at the wrong argument entirely.
  const suppliedZoneId = opts.zoneId ?? fileConfig.zoneId ?? undefined;
  if (suppliedZoneId) {
    assertCloudflareId(suppliedZoneId, 'zoneId');
  }

  const apiToken = await resolveToken({
    tokenFile: opts.tokenFile ?? fileConfig.tokenFile ?? undefined,
  });

  if (!apiToken) {
    fail('API token required. Set CF_API_TOKEN, use --token-file, or set tokenFile in the config.');
  }

  let zoneId = suppliedZoneId;
  if (apiToken && requireZone && (!zoneId || zoneId === '')) {
    zoneId = await selectZoneInteractively(apiToken, configPath, streams);
  }

  zoneId = assertCloudflareId(zoneId, 'zoneId');

  return {
    apiToken,
    accountId: opts.accountId ?? fileConfig.accountId ?? undefined,
    zoneId,
    state: parseDiscoveryStates(opts.state ?? fileConfig.state ?? undefined).join(','),
    useSchemas: opts.schemas === false ? false : (fileConfig.useSchemas ?? true),
    // stderr, so `--output -` keeps a clean report on stdout.
    onWarning: (message) => console.error(`Warning: ${message}`),
  };
}

/**
 * Exported so tests can drive the real command wiring via
 * `program.parseAsync(argv, { from: 'user' })` instead of spawning a
 * subprocess. Not part of the package's public API — `index.ts` does not
 * re-export this module, and consumers should use the CLI binary or the
 * library exports in `index.ts`, not this `Command` instance directly.
 */
export const program = new Command();

program
  .name('api-shield-optimizer')
  .description('Cloudflare API Shield / Web Assets Endpoint Optimization Agent')
  .version('0.3.0');

// --------------------------------------------------------------------- propose

program
  .command('propose')
  .description('Generate a proposal bundle from discovered endpoints')
  .option('--config <path>', 'Path to JSON config file')
  .option('--token-file <path>', 'Path to a file containing the API token')
  .option('--account-id <id>', 'Cloudflare account ID')
  .option('--zone-id <id>', 'Cloudflare zone ID')
  .option('--state <states>', 'Discovery states to include: review,saved,ignored')
  .option('--no-schemas', 'Skip uploaded API schema enrichment')
  .option(
    '--exclude-decided',
    'Analyse only undecided operations, omitting those already saved or ignored in the zone',
  )
  .option('--min-hits <n>', 'Filter out endpoints below hit threshold')
  .option('--max-groups <n>', 'Limit number of groups in output')
  .option('--operation-budget <n>', 'Zone operation cap, used to rank proposals against available slots')
  .option('--max-members <n>', 'Raw member endpoints embedded per proposal. Use 0 to embed all.')
  .option('--only <actions>', 'Only report these actions: save,ignore,manual_review')
  .option('--min-confidence <n>', 'Only report proposals at or above this confidence (0-1)')
  .option('--format <format>', 'Output format: json, text, csv', 'json')
  .option('--verbose', 'Include full signal breakdown in the text report')
  .option('--output <path>', 'Write to this path. Use "-" for stdout.')
  .action(async (opts) => {
    const { config: fileConfig, path: configPath } = await loadConfigOrScaffold(opts.config, {
      alreadySufficient: optionsAreSelfSufficient(opts),
    });
    const config = await buildConnectorConfig(opts, fileConfig, true, configPath);

    const agent = new ShieldOptimizerAgent();
    const bundle = await agent.run({
      connectorConfig: config,
      // 0 is accepted and means "no filter" / "no limit", matching the value
      // written into the scaffolded config file.
      minHits: parseBoundedInt(opts.minHits ?? fileConfig.minHits, 'minHits', { min: 0, max: 1_000_000_000 }),
      maxGroups: parseBoundedInt(opts.maxGroups ?? fileConfig.maxGroups, 'maxGroups', { min: 0, max: 100_000 }),
      operationBudget: parseBoundedInt(
        opts.operationBudget ?? fileConfig.operationBudget,
        'operationBudget',
        { min: 1, max: 1_000_000 },
      ),
      maxEmbeddedMembers: parseBoundedInt(
        opts.maxMembers ?? fileConfig.maxMembers,
        'maxMembers',
        { min: 0, max: 100_000 },
      ),
      // Already-decided operations are reported by default. They occupy the
      // operation budget, and a saved operation is the only place a
      // `cf-risk-zombie` label can appear, so omitting them hides both the
      // slots in use and the slots worth reclaiming.
      includeDecided: !(opts.excludeDecided ?? fileConfig.excludeDecided ?? false),
      scoringOverrides: fileConfig.scoring,
    });

    const filtered = filterBundle(bundle, parseActionList(opts.only), parseConfidence(opts.minConfidence));

    const format = String(opts.format).toLowerCase();
    if (!['json', 'text', 'csv'].includes(format)) {
      fail('--format must be json, text, or csv');
    }

    const payloads: Record<string, string> = {
      json: JSON.stringify(filtered, null, 2),
      text: formatBundleAsText(filtered, { verbose: Boolean(opts.verbose) }),
      csv: bundleToCsv(filtered),
    };

    const outputOpt = opts.output ?? fileConfig.output ?? undefined;

    // `-` streams to stdout so the bundle can be piped.
    if (outputOpt === '-') {
      process.stdout.write(payloads[format]);
      return;
    }

    if (outputOpt) {
      await writeFileEnsuringDir(outputOpt, payloads[format]);
      console.error(`Wrote ${format} output to ${outputOpt}`);
      return;
    }

    // Default: write all three representations alongside each other.
    const path = await import('node:path');
    const stamp = timestamp();
    const base = path.join('output', `ApiShieldProposed-${stamp}`);
    await writeFileEnsuringDir(`${base}.json`, payloads.json);
    await writeFileEnsuringDir(`${base}.txt`, payloads.text);
    await writeFileEnsuringDir(`${base}.csv`, payloads.csv);
    console.error(`Proposal bundle written to ${base}.json`);
    console.error(`Human-readable report written to ${base}.txt`);
    console.error(`Spreadsheet export written to ${base}.csv`);
    console.error('');
    console.error(`Next: api-shield-optimizer review --bundle ${base}.json`);
  });

// ---------------------------------------------------------------------- review

program
  .command('review')
  .description('Interactively review a proposal bundle and record decisions')
  .requiredOption('--bundle <path>', 'Path to a proposal bundle JSON file')
  .option('--decisions <path>', 'Existing decision file to resume from')
  .option('--only <actions>', 'Review only these actions: save,ignore,manual_review', 'manual_review')
  .option('--min-confidence <n>', 'Skip proposals below this confidence (0-1)')
  .option('--output <path>', 'Where to write the decision file')
  .action(async (opts) => {
    const bundle = await loadJson<ProposalBundle>(opts.bundle, 'proposal bundle');
    if (!Array.isArray(bundle.proposals)) {
      fail('bundle does not contain a proposals array');
    }

    const existing = opts.decisions
      ? await loadJson<DecisionFile>(opts.decisions, 'decision file')
      : undefined;

    if (existing && existing.rulesetVersion !== bundle.rulesetVersion) {
      console.error(
        `Warning: decision file was produced with ruleset ${existing.rulesetVersion} but the bundle uses ` +
          `${bundle.rulesetVersion}. Recommendations may have changed.`,
      );
    }

    const only = parseActionList(opts.only);
    const result = await runInteractiveReview(bundle, {
      only: only && only.length > 0 ? only : undefined,
      minConfidence: parseConfidence(opts.minConfidence),
      existing,
    });

    const outputPath = opts.output ?? `output/ApiShieldDecisions-${timestamp()}.json`;
    await writeFileEnsuringDir(outputPath, JSON.stringify(result.decisionFile, null, 2));
    console.error(`Decision file written to ${outputPath}`);
    console.error('');
    console.error(
      `Next: api-shield-optimizer export-payload --bundle ${opts.bundle} --decisions ${outputPath}`,
    );
  });

// -------------------------------------------------------------- export-payload

program
  .command('export-payload')
  .description('Generate ready-to-POST Cloudflare API payloads. Never sends anything.')
  .requiredOption('--bundle <path>', 'Path to a proposal bundle JSON file')
  .option('--decisions <path>', 'Decision file that overrides recommendations')
  .option('--only <actions>', 'Export only these actions: save,ignore', 'save,ignore')
  .option('--min-confidence <n>', 'Skip proposals below this confidence (0-1)')
  .option('--output <path>', 'Where to write the payload. Use "-" for stdout.')
  .action(async (opts) => {
    const bundle = await loadJson<ProposalBundle>(opts.bundle, 'proposal bundle');
    const decisions = opts.decisions
      ? await loadJson<DecisionFile>(opts.decisions, 'decision file')
      : undefined;

    const actions = parseActionList(opts.only);
    if (actions?.includes('manual_review')) {
      fail('manual_review proposals cannot be exported; decide them with `review` first');
    }

    const payload = buildApplyPayload(bundle, {
      actions,
      decisions,
      minConfidence: parseConfidence(opts.minConfidence),
    });

    const json = JSON.stringify(payload, null, 2);

    if (opts.output === '-') {
      process.stdout.write(json);
      return;
    }

    const outputPath = opts.output ?? `output/ApiShieldPayload-${timestamp()}.json`;
    await writeFileEnsuringDir(outputPath, json);

    console.error(`Payload written to ${outputPath}`);
    console.error('');
    console.error(`  Save operations:   ${payload.counts.save}`);
    console.error(`  Ignore operations: ${payload.counts.ignore}`);
    console.error(`  Skipped:           ${payload.counts.skipped}`);
    console.error('');
    console.error('This tool does not write to the Cloudflare API. Review the payload, then apply it yourself.');

    if (payload.zoneId === '{zoneId}') {
      console.error('');
      console.error('Note: the bundle carries no zone ID.');
      console.error('Replace the {zoneId} placeholder in the request URLs before applying.');
    }

    for (const request of payload.requests) {
      console.error('');
      console.error(`# ${request.description}`);
      console.error(`${request.method} ${request.url}`);
    }
  });

// ----------------------------------------------------------------------- zones

program
  .command('zones')
  .description('List zones accessible with the API token')
  .option('--config <path>', 'Path to JSON config file')
  .option('--token-file <path>', 'Path to a file containing the API token')
  .option('--output <path>', 'Write JSON to file instead of stdout')
  .action(async (opts) => {
    const { config: fileConfig } = await loadConfigOrScaffold(opts.config, { requireExisting: true });
    const apiToken = await resolveToken({
      tokenFile: opts.tokenFile ?? fileConfig.tokenFile ?? undefined,
    });

    if (!apiToken) {
      fail('API token required. Use --token-file, set tokenFile in the config, or set CF_API_TOKEN.');
    }

    const connector = new CloudflareApiConnector();
    const zones = await connector.listZones(apiToken);
    const payload = JSON.stringify(zones, null, 2);

    if (opts.output && opts.output !== '-') {
      await writeFileEnsuringDir(opts.output, payload);
      console.error(`Zones written to ${opts.output}`);
    } else {
      console.log(payload);
    }
  });

// ----------------------------------------------------------------- smoke-fetch

program
  .command('smoke-fetch')
  .description('Fetch API Shield operations and print pagination stats')
  .option('--config <path>', 'Path to JSON config file')
  .option('--token-file <path>', 'Path to a file containing the API token')
  .option('--zone-id <id>', 'Cloudflare zone ID')
  .option('--account-id <id>', 'Cloudflare account ID')
  .option('--state <states>', 'Discovery states to include: review,saved,ignored')
  .option('--no-schemas', 'Skip uploaded API schema enrichment')
  .action(async (opts) => {
    const { config: fileConfig, path: configPath } = await loadConfigOrScaffold(opts.config, {
      alreadySufficient: optionsAreSelfSufficient(opts),
    });
    const config = await buildConnectorConfig(opts, fileConfig, true, configPath);

    const connector = new CloudflareApiConnector();
    const stats = await connector.fetchEndpointStats(config);

    console.log(`Discovery operations: ${stats.discovery.operationCount} (pages fetched: ${stats.discovery.pagesFetched})`);
    console.log(`Managed operations:   ${stats.managed.operationCount} (pages fetched: ${stats.managed.pagesFetched})`);
    console.log(`Merged endpoints:     ${stats.merged.endpointCount}`);
    if (stats.schemas) {
      console.log(`Uploaded schemas:     ${stats.schemas.schemaCount} (operations: ${stats.schemas.operationCount})`);
    }

    const discarded = stats.discovery.discarded + stats.managed.discarded;
    if (discarded > 0) {
      console.log(`Discarded records:    ${discarded} (malformed, missing host/method/path)`);
    }
    if (stats.discovery.truncated || stats.managed.truncated || stats.schemas?.truncated) {
      console.log('Truncated:            YES — the zone exceeds the fetch cap, results are partial');
    }
  });

export async function main(): Promise<void> {
  try {
    await program.parseAsync();
  } catch (error) {
    if (error instanceof ValidationError) {
      fail(error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }
}

// Only auto-run when this file is the process entrypoint (`node dist/cli.js`,
// or the `api-shield-optimizer` bin). Importing it from a test — or from any
// other module — must not have the side effect of parsing `process.argv` and
// potentially calling `process.exit`. `require.main === module` works because
// this file compiles to CommonJS (no `"type": "module"` in package.json), the
// same convention Node's own docs use for a dual library/executable package.
if (require.main === module) {
  void main();
}
