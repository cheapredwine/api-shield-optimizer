#!/usr/bin/env node
import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { ShieldOptimizerAgent } from './agent.js';
import { CloudflareApiConnector } from './connectors/index.js';
import { formatBundleAsText } from './format.js';
import type { ConnectorConfig } from './types.js';

interface ConfigFile {
  mode?: string;
  apiToken?: string;
  tokenFile?: string;
  zoneId?: string;
  accountId?: string;
  minHits?: number;
  maxGroups?: number;
  output?: string;
  snapshot?: string;
  state?: string;
}

async function loadConfig(path: string): Promise<ConfigFile> {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(path, 'utf-8');
  return JSON.parse(raw) as ConfigFile;
}

const DEFAULT_CONFIG_PATH = 'optimizer.config.json';

const DEFAULT_CONFIG: ConfigFile = {
  mode: 'api',
  tokenFile: '',
  zoneId: '',
  accountId: '',
  minHits: 0,
  maxGroups: 0,
};

async function ensureConfig(): Promise<{ path: string; config: ConfigFile }> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  try {
    await fs.access(DEFAULT_CONFIG_PATH);
    return { path: DEFAULT_CONFIG_PATH, config: await loadConfig(DEFAULT_CONFIG_PATH) };
  } catch {
    const json = JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n';
    await fs.writeFile(DEFAULT_CONFIG_PATH, json, 'utf-8');
    console.error(`Created ${DEFAULT_CONFIG_PATH}. Please edit it to add your API token, then re-run.`);
    process.exit(1);
  }
}

async function resolveToken(opts: {
  apiToken?: string;
  tokenFile?: string;
}): Promise<string | undefined> {
  let token = opts.apiToken;
  if (!token && opts.tokenFile) {
    const fs = await import('node:fs/promises');
    token = (await fs.readFile(opts.tokenFile, 'utf-8')).trim();
  }
  if (!token && process.env.CF_API_TOKEN) {
    token = process.env.CF_API_TOKEN;
  }
  return token;
}

async function selectZoneInteractively(apiToken: string): Promise<string> {
  const connector = new CloudflareApiConnector();
  const zones = await connector.listZones(apiToken);

  if (zones.length === 0) {
    throw new Error('No zones found for this token.');
  }

  console.error('Available zones:');
  zones.forEach((z, i) => {
    console.error(`  ${i + 1}. ${z.name} (${z.id})`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question('Select zone number: ', (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });

  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= zones.length) {
    throw new Error('Invalid selection.');
  }

  return zones[idx].id;
}

const program = new Command();

program
  .name('api-shield-optimizer')
  .description('Cloudflare API Shield / Web Assets Endpoint Optimization Agent')
  .version('0.1.0');

program
  .command('propose')
  .description('Generate a proposal bundle from discovered endpoints')
  .option('--config <path>', 'Path to JSON config file')
  .option('--mode <mode>', 'connector mode: api, snapshot')
  .option('--api-token <token>', 'Cloudflare API token ( discouraged: leaks to shell history and process list )')
  .option('--token-file <path>', 'Path to a file containing the API token')
  .option('--account-id <id>', 'Cloudflare account ID')
  .option('--zone-id <id>', 'Cloudflare zone ID')
  .option('--snapshot <path>', 'Path to snapshot JSON file')
  .option('--state <states>', 'Endpoint states to include (comma-separated)')
  .option('--min-hits <n>', 'Filter out endpoints below hit threshold')
  .option('--max-groups <n>', 'Limit number of groups in output')
  .option('--output <path>', 'Write proposal bundle to file instead of stdout')
  .action(async (opts) => {
    let fileConfig: ConfigFile;
    if (opts.config) {
      fileConfig = await loadConfig(opts.config);
    } else {
      const ensured = await ensureConfig();
      fileConfig = ensured.config;
    }

    const mode = opts.mode ?? fileConfig.mode ?? 'snapshot';
    let apiToken = await resolveToken({
      apiToken: opts.apiToken || fileConfig.apiToken || undefined,
      tokenFile: opts.tokenFile ?? fileConfig.tokenFile ?? undefined,
    });

    if (mode === 'api' && !apiToken) {
      console.error('Error: API token required. Set CF_API_TOKEN, use --token-file, or pass --api-token.');
      process.exit(1);
    }

    let zoneId = opts.zoneId ?? fileConfig.zoneId ?? undefined;
    if (mode === 'api' && apiToken && (!zoneId || zoneId === '')) {
      zoneId = await selectZoneInteractively(apiToken);
    }

    const config: ConnectorConfig = {
      mode,
      apiToken,
      accountId: opts.accountId ?? fileConfig.accountId ?? undefined,
      zoneId,
      snapshotPath: opts.snapshot ?? fileConfig.snapshot ?? undefined,
      state: opts.state ?? fileConfig.state ?? undefined,
    };

    const agent = new ShieldOptimizerAgent();
    const bundle = await agent.run({
      connectorConfig: config,
      minHits: parseInt(opts.minHits ?? String(fileConfig.minHits ?? 0), 10),
      maxGroups: parseInt(opts.maxGroups ?? String(fileConfig.maxGroups ?? 0), 10) || undefined,
    });

    const outputPath = opts.output ?? fileConfig.output ?? undefined;
    const json = JSON.stringify(bundle, null, 2);
    if (outputPath) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.writeFile(outputPath, json, 'utf-8');
      console.error(`Proposal bundle written to ${outputPath}`);

      const textPath = outputPath.replace(/\.json$/i, '') + '.txt';
      const text = formatBundleAsText(bundle);
      await fs.writeFile(textPath, text, 'utf-8');
      console.error(`Human-readable report written to ${textPath}`);
    } else {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '');
      await fs.mkdir('output', { recursive: true });

      const jsonPath = path.join('output', `ApiShieldProposed-${timestamp}.json`);
      await fs.writeFile(jsonPath, json, 'utf-8');
      console.error(`Proposal bundle written to ${jsonPath}`);

      const textPath = path.join('output', `ApiShieldProposed-${timestamp}.txt`);
      const text = formatBundleAsText(bundle);
      await fs.writeFile(textPath, text, 'utf-8');
      console.error(`Human-readable report written to ${textPath}`);
    }
  });

program
  .command('zones')
  .description('List zones accessible with the API token')
  .option('--config <path>', 'Path to JSON config file')
  .option('--api-token <token>', 'Cloudflare API token')
  .option('--token-file <path>', 'Path to a file containing the API token')
  .option('--output <path>', 'Write JSON to file instead of stdout')
  .action(async (opts) => {
    let fileConfig: ConfigFile;
    if (opts.config) {
      fileConfig = await loadConfig(opts.config);
    } else {
      const ensured = await ensureConfig();
      fileConfig = ensured.config;
    }
    const apiToken = await resolveToken({
      apiToken: opts.apiToken || fileConfig.apiToken || undefined,
      tokenFile: opts.tokenFile ?? fileConfig.tokenFile ?? undefined,
    });

    if (!apiToken) {
      console.error('Error: API token required. Set CF_API_TOKEN, use --token-file, or pass --api-token.');
      process.exit(1);
    }

    const connector = new CloudflareApiConnector();
    const zones = await connector.listZones(apiToken);

    const payload = JSON.stringify(zones, null, 2);
    if (opts.output) {
      const fs = await import('node:fs/promises');
      await fs.writeFile(opts.output, payload, 'utf-8');
      console.error(`Zones written to ${opts.output}`);
    } else {
      console.log(payload);
    }
  });

program
  .command('smoke-fetch')
  .description('Fetch API Shield operations and print pagination stats')
  .option('--config <path>', 'Path to JSON config file')
  .option('--api-token <token>', 'Cloudflare API token')
  .option('--token-file <path>', 'Path to a file containing the API token')
  .option('--zone-id <id>', 'Cloudflare zone ID')
  .option('--account-id <id>', 'Cloudflare account ID')
  .option('--state <states>', 'Endpoint states to include (comma-separated)')
  .action(async (opts) => {
    let fileConfig: ConfigFile;
    if (opts.config) {
      fileConfig = await loadConfig(opts.config);
    } else {
      const ensured = await ensureConfig();
      fileConfig = ensured.config;
    }

    const apiToken = await resolveToken({
      apiToken: opts.apiToken || fileConfig.apiToken || undefined,
      tokenFile: opts.tokenFile ?? fileConfig.tokenFile ?? undefined,
    });

    if (!apiToken) {
      console.error('Error: API token required. Set CF_API_TOKEN, use --token-file, or pass --api-token.');
      process.exit(1);
    }

    let zoneId = opts.zoneId ?? fileConfig.zoneId ?? undefined;
    if (!zoneId || zoneId === '') {
      zoneId = await selectZoneInteractively(apiToken);
    }

    const connector = new CloudflareApiConnector();
    const stats = await connector.fetchEndpointStats({
      mode: 'api',
      apiToken,
      accountId: opts.accountId ?? fileConfig.accountId ?? undefined,
      zoneId,
      state: opts.state ?? fileConfig.state ?? undefined,
    });

    console.log(`Discovery operations: ${stats.discovery.operationCount} (pages fetched: ${stats.discovery.pagesFetched})`);
    console.log(`Managed operations:   ${stats.managed.operationCount} (pages fetched: ${stats.managed.pagesFetched})`);
    console.log(`Merged endpoints:     ${stats.merged.endpointCount}`);
  });

program
  .command('snapshot-guide')
  .description('Print the expected snapshot JSON format')
  .action(() => {
    console.log(`Snapshot must be JSON containing either:
1) An array of Endpoint objects:
[
  {
    "id": "ep-1",
    "accountId": "abc",
    "zoneId": "z-1",
    "host": "api.example.com",
    "method": "GET",
    "path": "/users/123",
    "source": "machinelearning",
    "hits": 5000,
    "lastSeenAt": "2026-07-28T00:00:00Z",
    "rawReference": {}
  }
]

2) Or an object with an endpoints key:
{ "endpoints": [ ... ] }
`);
  });

program.parse();
