# API Shield Optimizer

Cloudflare API Shield / Web Assets Endpoint Optimization Agent.

Reads discovered endpoints, groups them into normalized shapes, and produces reviewable save/ignore/manual-review proposals with full rationale.

## Quick start

```bash
npm install
npm run build
```

### Config file (recommended)

On first run, the tool automatically creates `optimizer.config.json` if it doesn't exist. Set `tokenFile` to a token path outside repo, then run:

```bash
npx tsx src/cli.ts propose
```

The generated file looks like this:

```json
{
  "mode": "api",
  "tokenFile": "",
  "zoneId": "",
  "accountId": "",
  "minHits": 0,
  "maxGroups": 0
}
```

- Preferred: set `tokenFile` to a path outside repo (example: `~/.config/api-shield/cf_api_token`)
- Leave `zoneId` blank for an interactive zone picker
- Re-run the same command

Writes `output/ApiShieldProposed-{timestamp}.json` and `.txt`.

### Config file fields

| Field | Required | Description |
|-------|----------|-------------|
| `mode` | Yes | `api` or `snapshot` |
| `tokenFile` | For API mode | Path to file containing Cloudflare API token (preferred for local usage) |
| `zoneId` | For API mode | Cloudflare zone ID. Leave blank for interactive picker |
| `accountId` | No | Cloudflare account ID |
| `snapshot` | For snapshot mode | Path to snapshot JSON file |
| `state` | No | Comma-separated states: `review`, `saved`, `ignored` |
| `minHits` | No | Filter endpoints below hit threshold (default: 0) |
| `maxGroups` | No | Limit number of groups in output (default: 0 = no limit) |

### Snapshot mode (no API access needed)

```bash
npx tsx src/cli.ts propose --mode snapshot --snapshot endpoints.json
```

### Pagination smoke check (API mode)

Use this to verify real-account pagination behavior for discovery + managed operations:

```bash
npx tsx src/cli.ts smoke-fetch --state review,saved,ignored
```

Output shows operation counts and pages fetched per endpoint type.

## Cloudflare Workers mode

This project now includes a Worker entrypoint at `src/worker.ts` and `wrangler.toml`.

### Endpoints

- `GET /health`
- `GET /smoke-fetch?zoneId=<zone>&state=review,saved,ignored`
- `GET /propose?zoneId=<zone>&minHits=10&maxGroups=100`

If `state` is omitted, the tool defaults to all discovery states: `review,saved,ignored`.

### Secrets (required)

Use Wrangler secrets so token never lands in repo or command history:

```bash
wrangler secret put CF_API_TOKEN
```

### Access enforcement

Worker enforces Cloudflare Access headers by default.

- Required request headers: `cf-access-authenticated-user-email`, `cf-access-jwt-assertion`
- Required config: `ACCESS_AUD`, `ACCESS_JWKS_URL`, `ACCESS_ISSUER`
- Local-only bypass: set `REQUIRE_CF_ACCESS=0` in local `wrangler dev` env

Worker performs cryptographic JWT signature verification against JWKS (`RS256`) plus `aud`, time-claim, and required `iss` checks.
Primary enforcement should still be Access policy on application in Cloudflare Zero Trust.

RBAC enforcement:

- Worker enforces per-user/per-group allowlist for `/smoke-fetch` and `/propose`.
- Rule source: `rbac.json` (in repo), injected into Worker var `RBAC_RULES_JSON` by deploy script.
- Default behavior: deny unless matching rule allows action + scope.

Example `rbac.json`:

```json
{
  "defaultDeny": true,
  "users": {
    "alice@company.com": {
      "permissions": ["smoke", "propose"],
      "zoneIds": ["zone_123"],
      "accountIds": ["acc_123"]
    }
  },
  "groups": {
    "api-shield-readonly": {
      "permissions": ["smoke"],
      "zoneIds": ["zone_123"]
    }
  }
}
```

How to find values:

- `ACCESS_AUD`
  - Zero Trust -> Access -> Applications -> select your app -> Settings -> **AUD**
- `ACCESS_JWKS_URL`
  - Use your Access team domain and append `/cdn-cgi/access/certs`
  - Format: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
- `ACCESS_ISSUER`
  - Use your Access team domain only
  - Format: `https://<team>.cloudflareaccess.com`

How to find `<team>`:

- Open Access application Launch URL or login URL in Zero Trust app settings
- Extract hostname: `<team>.cloudflareaccess.com`

Quick verification:

```bash
curl "https://<team>.cloudflareaccess.com/cdn-cgi/access/certs"
```

Expected: JSON payload containing `keys`.

### Run and deploy

```bash
npm run dev:worker
npm run deploy:worker:check
npm run deploy:worker
```

### Deploy requirements (must be true before deploy)

- `wrangler login` completed on machine/CI runner.
- `CF_API_TOKEN` secret exists in Worker (`wrangler secret put CF_API_TOKEN`).
- `wrangler.toml` has non-empty `ACCESS_AUD`, `ACCESS_JWKS_URL`, `ACCESS_ISSUER`.
- `rbac.json` exists and contains valid JSON object with intended allowlist.

### End-to-end deploy checklist

1) Authenticate Wrangler:

```bash
wrangler login
```

2) Configure required Access vars in `wrangler.toml`:

```toml
[vars]
REQUIRE_CF_ACCESS = "1"
ACCESS_AUD = "<access-app-aud-tag>"
ACCESS_JWKS_URL = "https://<team>.cloudflareaccess.com/cdn-cgi/access/certs"
ACCESS_ISSUER = "https://<team>.cloudflareaccess.com"
```

3) Edit `rbac.json` with your user/group allowlist.

Where to find `ACCESS_AUD`:
- Zero Trust Dashboard -> Access -> Applications -> your app -> Settings -> AUD

Where to find `<team>` for `ACCESS_JWKS_URL` and `ACCESS_ISSUER`:
- Zero Trust -> Access -> Applications -> your app -> Launch URL/login URL
- Use hostname from that URL: `https://<team>.cloudflareaccess.com`

4) Set Worker secret:

```bash
wrangler secret put CF_API_TOKEN
```

Notes:
- This is usually one-time per Worker environment. Re-run only when token rotates.
- Secret is not read from `rbac.json` or `wrangler.toml`.

5) Deploy Worker (injects `RBAC_RULES_JSON` from `rbac.json` automatically):

```bash
npm run deploy:worker
```

What deploy command does:
- Runs preflight (`npm run deploy:worker:check`)
- Reads `rbac.json`
- Fails if JSON invalid or missing
- Sends `RBAC_RULES_JSON` via `wrangler deploy --var ...`
- Deploys Worker with current code + RBAC

Preflight checks:
- `wrangler.toml` has non-empty `ACCESS_AUD`, `ACCESS_JWKS_URL`, `ACCESS_ISSUER`
- `REQUIRE_CF_ACCESS` is not disabled
- `rbac.json` is valid JSON object
- `rbac.json` has `defaultDeny: true`
- `rbac.json` has at least one `users` or `groups` object

Important:
- RBAC changes are not live until you run deploy again.
- `ACCESS_*` values come from `wrangler.toml` (or Wrangler env config), not `rbac.json`.

6) In Cloudflare Zero Trust, create/attach Access app policy for Worker hostname/route:

- Require your IdP group(s)
- Ensure Access injects `cf-access-jwt-assertion`

7) Verify deployed endpoints:

```bash
curl "https://<worker-host>/health"
curl "https://<worker-host>/smoke-fetch?zoneId=<ZONE_ID>&state=review,saved,ignored"
curl "https://<worker-host>/propose?zoneId=<ZONE_ID>&minHits=10&maxGroups=100"
```

### GitHub Actions secret model

- Keep Cloudflare deploy token in GitHub Secrets.
- Keep API Shield read token as separate secret if CI calls `/smoke-fetch` or `/propose`.
- Do not commit token values to `wrangler.toml` or source files.

### CLI options (use config file instead when possible)

| Option | Description |
|--------|-------------|
| `--config` | Path to JSON config file |
| `--mode` | `api` or `snapshot` |
| `--api-token` | Cloudflare API token ( discouraged — use token file or env var ) |
| `--token-file` | Path to file containing API token |
| `--zone-id` | Cloudflare zone ID |
| `--account-id` | Cloudflare account ID |
| `--snapshot` | Path to snapshot JSON file |
| `--state` | Endpoint states to include: `review`, `saved`, `ignored` (default when omitted: all three) |
| `--min-hits` | Filter endpoints below hit threshold |
| `--max-groups` | Limit number of groups in output |
| `--output` | Explicit output path (default: `output/ApiShieldProposed-{timestamp}.json`) |

## Normalized groups

A **normalized group** is a cluster of discovered endpoints that share the same canonical shape after the optimizer collapses variable segments and similar hostnames. The grouping process works in two stages:

### Path normalization

Variable path segments are replaced with `{var1}`, `{var2}`, etc. when they look like:

- Numeric IDs (`/users/123` → `/users/{var1}`)
- UUIDs (`/orders/ab12cd34-...` → `/orders/{var1}`)
- Dates and timestamps
- Hex or Base64 tokens
- High-cardinality random strings

### Host normalization

When multiple subdomains share the same path shape, the hostname is collapsed into a variable pattern:

```
us-api.example.com/users/{var1}
de-api.example.com/users/{var1}
fr-api.example.com/users/{var1}
```

→ `{hostVar1}.example.com/users/{var1}`

**Safety constraint:** hostnames are only collapsed when all members have the **same label depth** and exactly **one label differs**. Variable-depth subdomains are never merged (e.g. `api.example.com` and `foo.bar.example.com` stay separate).

### Why groups matter

Each group becomes one proposal. Instead of reviewing hundreds of raw endpoints individually, you review a handful of canonical shapes. Every proposal lists the specific member endpoints that were grouped together, the confidence score, and the reasoning.

## Library usage

```ts
import { ShieldOptimizerAgent } from './src/agent.js';

const bundle = await new ShieldOptimizerAgent().run({
  connectorConfig: { mode: 'snapshot', snapshotPath: 'endpoints.json' },
  minHits: 10,
});

console.log(bundle.summary);
```

## Snapshot format

```json
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
```

Or wrap in `{ "endpoints": [ ... ] }`.

## Classification

The classifier scores each normalized group on a **0–1 scale** and applies decision boundaries:

| Score | Action | Confidence |
|-------|--------|------------|
| ≥ 0.65 | `save` | clamped to ≤ 0.95 |
| ≤ 0.35 | `ignore` | clamped to ≤ 0.90 |
| 0.36 – 0.64 | `manual_review` | 0.5 + distance from midpoint |

Starting score: **0.5**

### How scoring works

1. **Group assembly** — After normalization, endpoints with the same method + canonical path shape are collected into a group. If their hostnames can be safely collapsed (same label depth, exactly one differing label), a hostname variable is applied.

2. **Signal collection** — The classifier inspects the group and gathers boolean signals from the patterns, traffic, methods, and existing operator state.

3. **Score mutation** — Each signal applies a fixed delta to the running score (clamped to 0..1):
   - Positive signals nudge the score up (save-ward)
   - Negative signals nudge the score down (ignore-ward)
   - Multiple signals stack additively

4. **Decision boundary** — The final score falls into one of three bands:
   - **Save band (≥ 0.65)** — High-confidence production endpoints. Confidence = min(0.95, score).
   - **Ignore band (≤ 0.35)** — Noise, debug, or low-value traffic. Confidence = min(0.90, 1 − score).
   - **Manual-review band (0.36 – 0.64)** — Ambiguous cases where signals conflict or no strong pattern matched. Confidence = 0.5 + |score − 0.5|, so a score of 0.5 yields 50% confidence while 0.64 yields 64%.

5. **Rationale accumulation** — Every signal that fired contributes a human-readable reason string to the proposal. If the score lands in the middle band, an additional `borderline-score` reason is appended.

6. **Flag attachment** — Signals also emit machine-readable flags (e.g. `likely-noise`, `path-variable`) so downstream automation can filter or override proposals.

### Positive signals (+)

| Signal | Δ | Reason text |
|--------|---|-------------|
| Production-critical path (auth, login, account, payment, admin, AI/LLM) | +0.35 | matches production-critical path pattern |
| High traffic (>10k hits) | +0.10 | high traffic volume |
| Sensitive HTTP method (POST, PUT, PATCH, DELETE) | +0.10 | sensitive HTTP method observed |
| Already saved by operator | +0.20 | some members already saved |
| API-contract-oriented path (`/vN`, `/graphql`, `/openapi`, `/swagger`) | +0.08 | API contract-oriented path detected |
| Contains manual operations | +0.08 | contains manually managed operations |
| Fresh traffic signal (seen in 14d and >1k hits) | +0.05 | recently active endpoint shape with meaningful traffic |

### Negative signals (−)

| Signal | Δ | Reason text |
|--------|---|-------------|
| Noise path (health, ping, debug, test, static assets, favicon) | −0.45 | matches debug/health/test noise pattern |
| Very low traffic (<10 hits) | −0.15 | very low traffic |
| Host consolidation | −0.05 | host consolidation across multiple subdomains |
| Path variables present | −0.05 | path variables detected — verify shape coverage |
| Already ignored by operator | −0.20 | some members already ignored |
| CORS preflight (`OPTIONS`) | −0.50 | CORS preflight method is usually low-value |
| Stale low-traffic signal (>90d old and <100 hits) | −0.08 | stale endpoint shape with low observed traffic |

### Flags

When a signal fires, a flag is attached to the proposal:
- `likely-noise` — hit an ignore pattern
- `low-confidence` — very low traffic
- `host-consolidation` — collapsed subdomains
- `path-variable` — contains `{varN}`
- `stale-observation` — endpoints old with low traffic
- `borderline-score` — score fell in the ambiguous middle range

## Architecture

- `src/connectors/` — Cloudflare API, snapshot, future MCP
- `src/normalize.ts` — path + host normalization engine
- `src/classify.ts` — heuristic scoring (save / ignore / manual_review)
- `src/proposal.ts` — explanation generator + bundle export
- `src/agent.ts` — orchestrator
- `src/cli.ts` — CLI entry point

## Security notes

- **Config file** — Keep `optimizer.config.json` non-secret. Store `tokenFile`, not raw token.
- **Token file** — Preferred for local runs in multi-shell/LLM workflows. Put file outside repo and lock permissions (`chmod 600`).
- **Environment variable** — `CF_API_TOKEN` is also safe and CI-friendly.
- **Never use `--api-token`** — It leaks into shell history and process lists.

## Tests

```bash
npm test
```

## License

MIT
