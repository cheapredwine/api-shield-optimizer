#!/usr/bin/env node
import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { ShieldOptimizerAgent } from './agent.js';
import { CloudflareApiConnector } from './connectors/index.js';
import type { ConnectorConfig } from './types.js';

interface ConfigFile {
  mode?: string;
  apiToken?: string;
  zoneId?: string;
  accountId?: string;
  minHits?: number;
  maxGroups?: number;
  output?: string;
  snapshot?: string;
}

async function loadConfig(path: string): Promise<ConfigFile> {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(path, 'utf-8');
  return JSON.parse(raw) as ConfigFile;
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
  .option('--min-hits <n>', 'Filter out endpoints below hit threshold')
  .option('--max-groups <n>', 'Limit number of groups in output')
  .option('--output <path>', 'Write proposal bundle to file instead of stdout')
  .action(async (opts) => {
    const fileConfig: ConfigFile = opts.config ? await loadConfig(opts.config) : {};

    const mode = opts.mode ?? fileConfig.mode ?? 'snapshot';
    let apiToken = await resolveToken({
      apiToken: opts.apiToken || fileConfig.apiToken || undefined,
      tokenFile: opts.tokenFile,
    });

    if (mode === 'api' && !apiToken) {
      console.error('Error: API token required. Set CF_API_TOKEN, use --token-file, pass --api-token, or set apiToken in config.');
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
      await fs.writeFile(outputPath, json, 'utf-8');
      console.error(`Proposal bundle written to ${outputPath}`);
    } else {
      console.log(json);
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
    const fileConfig: ConfigFile = opts.config ? await loadConfig(opts.config) : {};
    const apiToken = await resolveToken({
      apiToken: opts.apiToken || fileConfig.apiToken || undefined,
      tokenFile: opts.tokenFile,
    });

    if (!apiToken) {
      console.error('Error: API token required. Set CF_API_TOKEN, use --token-file, pass --api-token, or set apiToken in config.');
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
