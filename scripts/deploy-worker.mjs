#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

function loadRbacJson() {
  const filePath = resolve(process.cwd(), 'rbac.json');
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`rbac.json missing at ${filePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('rbac.json is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('rbac.json must be a JSON object');
  }

  return JSON.stringify(parsed);
}

async function main() {
  const rbacJson = loadRbacJson();
  const extraArgs = process.argv.slice(2);

  const bin = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
  const args = ['deploy', '--var', `RBAC_RULES_JSON:${rbacJson}`, ...extraArgs];

  const child = spawn(bin, args, {
    stdio: 'inherit',
    shell: false,
  });

  await new Promise((resolvePromise, rejectPromise) => {
    child.on('error', (err) => rejectPromise(err));
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise(undefined);
      } else {
        rejectPromise(new Error(`wrangler deploy exited with code ${code ?? -1}`));
      }
    });
  });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
