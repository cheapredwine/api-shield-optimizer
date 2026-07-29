#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readText(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    throw new Error(`Missing required file: ${path}`);
  }
}

function extractTomlVar(content, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm');
  const match = content.match(re);
  if (!match) return null;
  return match[1].trim();
}

function validateWranglerToml(content) {
  const required = ['ACCESS_AUD', 'ACCESS_JWKS_URL', 'ACCESS_ISSUER'];
  const missing = [];

  for (const key of required) {
    const value = extractTomlVar(content, key);
    if (!value) {
      missing.push(key);
    }
  }

  const requireAccess = extractTomlVar(content, 'REQUIRE_CF_ACCESS');
  if (requireAccess && ['0', 'false', 'off', 'no'].includes(requireAccess.toLowerCase())) {
    missing.push('REQUIRE_CF_ACCESS must be enabled ("1") for production deploys');
  }

  return missing;
}

function validateRbacJson(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return ['rbac.json is not valid JSON'];
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return ['rbac.json must be a JSON object'];
  }

  const issues = [];
  if (parsed.defaultDeny !== true) {
    issues.push('rbac.json should set "defaultDeny": true');
  }

  const hasUsers = parsed.users && typeof parsed.users === 'object' && !Array.isArray(parsed.users);
  const hasGroups = parsed.groups && typeof parsed.groups === 'object' && !Array.isArray(parsed.groups);
  if (!hasUsers && !hasGroups) {
    issues.push('rbac.json must define at least one of: users or groups');
  }

  return issues;
}

function main() {
  const root = process.cwd();
  const wranglerPath = resolve(root, 'wrangler.toml');
  const rbacPath = resolve(root, 'rbac.json');

  const wrangler = readText(wranglerPath);
  const rbac = readText(rbacPath);

  const errors = [
    ...validateWranglerToml(wrangler).map((e) => `wrangler.toml: ${e}`),
    ...validateRbacJson(rbac),
  ];

  if (errors.length > 0) {
    process.stderr.write('Deploy preflight failed:\n');
    for (const err of errors) {
      process.stderr.write(`- ${err}\n`);
    }
    process.exit(1);
  }

  process.stdout.write('Deploy preflight passed.\n');
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
