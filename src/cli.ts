#!/usr/bin/env node
import { Command } from 'commander';
import { askOnce } from './prompt.js';
import { saveZoneIdToConfig } from './config.js';
import { ShieldOptimizerAgent } from './agent.js';
import { CloudflareApiConnector, createConnector } from './connectors/index.js';
import { formatBundleAsText } from './format.js';
import { buildApplyPayload, bundleToCsv } from './export.js';
import { runInteractiveReview } from './review.js';
import type { Action, ConnectorConfig, DecisionFile, ProposalBundle } from './types.js';
import type { ScoringConfig } from './scoring-config.js';
import { ValidationError, assertCloudflareId, parseBoundedInt, parseDiscoveryStates } from './validate.js';

interface ConfigFile {
  mode?: string;
  tokenFile?: string;
  zoneId?: string;
  accountId?: string;
  minHits?: number;
  maxGroups?: number;
  operationBudget?: number;
  maxMembers?: number;
  output?: string;
  snapshot?: string;
  state?: string;
  useSchemas?: boolean;
  excludeDecided?: boolean;
  scoring?: Partial<ScoringConfig>;
}

const DEFAULT_CONFIG_FILENAME = 'optimizer.config.json';

const DEFAULT_CONFIG: ConfigFile = {
  mode: 'api',
  tokenFile: '',
  zoneId: '',
  accountId: '',
  minHits: 0,
  maxGroups: 0,
};

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function loadJson<T>(path: string, label: string): Promise<T> {
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
async function resolveConfigPath(explicit?: string): Promise<{ path: string; existed: boolean }> {
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

/** Loads config, creating a template on first run. Returns the resolved path so
 *  callers can persist choices back to it. */
async function loadConfigOrScaffold(
  explicit?: string,
  opts: { requireExisting?: boolean } = {},
): Promise<{ config: ConfigFile; path?: string }> {
  const resolved = await resolveConfigPath(explicit);

  if (resolved.existed) {
    return { config: await loadJson<ConfigFile>(resolved.path, 'config file'), path: resolved.path };
  }

  if (opts.requireExisting) {
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
async function resolveToken(opts: { tokenFile?: string }): Promise<string | undefined> {
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
 * works, it just cannot be remembered.
 */
async function selectZoneInteractively(apiToken: string, configPath?: string): Promise<string> {
  const connector = new CloudflareApiConnector();
  const zones = await connector.listZones(apiToken);

  if (zones.length === 0) {
    fail('no zones found for this token');
  }

  console.error('Available zones:');
  zones.forEach((z, i) => {
    console.error(`  ${i + 1}. ${z.name} (${z.id})`);
  });

  const answer = await askOnce('Select zone number: ');

  // End of input. Fail loudly rather than hanging on a promise that will never
  // settle, which is what the previous readline callback did.
  if (answer === null) {
    fail('no zone selected (end of input). Pass --zone-id, or set zoneId in the config, to run non-interactively.');
  }

  const idx = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= zones.length) {
    fail(`invalid zone selection '${answer}'; expected a number between 1 and ${zones.length}`);
  }

  const selected = zones[idx];

  if (configPath) {
    await offerToRememberZone(configPath, selected);
  }

  return selected.id;
}

/**
 * Asks before editing the config file. The file is hand-authored, so it is not
 * modified without consent, and only the `zoneId` field is touched.
 */
async function offerToRememberZone(configPath: string, zone: { id: string; name: string }): Promise<void> {
  const answer = await askOnce(`Remember ${zone.name} as zoneId in ${configPath}? [y/N]: `);
  if (answer === null || !/^y(es)?$/i.test(answer)) return;

  const result = await saveZoneIdToConfig(configPath, zone.id);

  switch (result) {
    case 'saved':
      console.error(`Saved zoneId to ${configPath}.`);
      break;
    case 'unchanged':
      break;
    case 'unreadable':
      console.error(`Could not parse ${configPath}; leaving it unchanged.`);
      break;
    case 'unwritable':
      console.error(`Could not write ${configPath}; leaving it unchanged.`);
      break;
  }
}

function parseActionList(raw: string | undefined): Action[] | undefined {
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

function parseConfidence(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail('--min-confidence must be between 0 and 1');
  }
  return value;
}

async function writeFileEnsuringDir(filePath: string, contents: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = path.dirname(path.resolve(filePath));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, contents, 'utf-8');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Applies action/confidence filters to a bundle, recomputing the summary. */
function filterBundle(bundle: ProposalBundle, only?: Action[], minConfidence?: number): ProposalBundle {
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

interface SharedOpts {
  config?: string;
  tokenFile?: string;
  zoneId?: string;
  accountId?: string;
}

async function buildConnectorConfig(
  opts: SharedOpts & { mode?: string; snapshot?: string; state?: string; schemas?: boolean },
  fileConfig: ConfigFile,
  requireZone = true,
  configPath?: string,
): Promise<ConnectorConfig> {
  const mode = (opts.mode ?? fileConfig.mode ?? 'snapshot') as ConnectorConfig['mode'];

  const apiToken = await resolveToken({
    tokenFile: opts.tokenFile ?? fileConfig.tokenFile ?? undefined,
  });

  if (mode === 'api' && !apiToken) {
    fail('API token required. Set CF_API_TOKEN, use --token-file, or set tokenFile in the config.');
  }

  let zoneId = opts.zoneId ?? fileConfig.zoneId ?? undefined;
  if (mode === 'api' && apiToken && requireZone && (!zoneId || zoneId === '')) {
    zoneId = await selectZoneInteractively(apiToken, configPath);
  }

  if (mode === 'api') {
    zoneId = assertCloudflareId(zoneId, 'zoneId');
  }

  return {
    mode,
    apiToken,
    accountId: opts.accountId ?? fileConfig.accountId ?? undefined,
    zoneId,
    snapshotPath: opts.snapshot ?? fileConfig.snapshot ?? undefined,
    state: parseDiscoveryStates(opts.state ?? fileConfig.state ?? undefined).join(','),
    useSchemas: opts.schemas === false ? false : (fileConfig.useSchemas ?? true),
  };
}

const program = new Command();

program
  .name('api-shield-optimizer')
  .description('Cloudflare API Shield / Web Assets Endpoint Optimization Agent')
  .version('0.2.0');

// --------------------------------------------------------------------- propose

program
  .command('propose')
  .description('Generate a proposal bundle from discovered endpoints')
  .option('--config <path>', 'Path to JSON config file')
  .option('--mode <mode>', 'connector mode: api, snapshot')
  .option('--token-file <path>', 'Path to a file containing the API token')
  .option('--account-id <id>', 'Cloudflare account ID')
  .option('--zone-id <id>', 'Cloudflare zone ID')
  .option('--snapshot <path>', 'Path to snapshot JSON file')
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
    const { config: fileConfig, path: configPath } = await loadConfigOrScaffold(opts.config);
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
      console.error('Note: the bundle carries no zone ID (typical for snapshot mode).');
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
    const { config: fileConfig, path: configPath } = await loadConfigOrScaffold(opts.config);
    const config = await buildConnectorConfig({ ...opts, mode: 'api' }, fileConfig, true, configPath);

    const connector = new CloudflareApiConnector();
    const stats = await connector.fetchEndpointStats(config);

    console.log(`Discovery operations: ${stats.discovery.operationCount} (pages fetched: ${stats.discovery.pagesFetched})`);
    console.log(`Managed operations:   ${stats.managed.operationCount} (pages fetched: ${stats.managed.pagesFetched})`);
    console.log(`Merged endpoints:     ${stats.merged.endpointCount}`);
    if (stats.schemas) {
      console.log(`Uploaded schemas:     ${stats.schemas.schemaCount} (operations: ${stats.schemas.operationCount})`);
    }
  });

// -------------------------------------------------------------- snapshot-guide

program
  .command('snapshot-guide')
  .description('Print the expected snapshot JSON format')
  .action(() => {
    console.log(`Snapshot must be JSON containing either an array of Endpoint objects
or an object with an "endpoints" key.

[
  {
    "id": "ep-1",
    "accountId": "",
    "zoneId": "",
    "host": "api.example.com",
    "method": "GET",
    "path": "/users/123",
    "source": "machinelearning",
    "hits": 5000,
    "lastSeenAt": "2026-07-28T00:00:00Z",
    "rawReference": {},

    // Optional enrichment. Each field materially improves classification.
    "status": "candidate",
    "inSchema": true,
    "contentTypes": ["application/json"],
    "statusCodes": { "200": 4800, "401": 200 },
    "cacheHitRatio": 0.02,
    "inSitemap": false,
    "features": { "authIdTokens": 42, "dataPoints": 5000 }
  }
]

Notes:
  - "hits" may be null to mean "traffic volume unknown". Omit it rather than
    using 0 when no data is available.
  - "contentTypes" is the strongest single signal for distinguishing an API
    from a rendered web page.
  - "inSchema" marks operations present in an uploaded OpenAPI schema and is
    the highest-precision signal available.
`);
  });

async function main(): Promise<void> {
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

void main();
