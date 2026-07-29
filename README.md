# API Shield Optimizer

Cloudflare API Shield / Web Assets Endpoint Optimization Agent.

Reads discovered endpoints, groups them into normalized shapes, and produces reviewable save/ignore/manual-review proposals with full rationale.

## Quick start

```bash
npm install
npm run build
```

### Snapshot mode (no API access needed)

```bash
npx tsx src/cli.ts propose --mode snapshot --snapshot endpoints.json
```

Writes `output/<timestamp>/ApiShieldProposed.json` and `ApiShieldProposed.txt`.

### API mode

```bash
export CF_API_TOKEN=<your-token>
npx tsx src/cli.ts propose --mode api --zone-id <zone-id>
```

Or use `--config` to load settings from a JSON file (see `optimizer.config.json.example`).

## CLI options

| Option | Description |
|--------|-------------|
| `--mode` | `api` or `snapshot` |
| `--api-token` | Cloudflare API token ( discouraged — use env var or token file ) |
| `--token-file` | Path to file containing API token |
| `--zone-id` | Cloudflare zone ID |
| `--account-id` | Cloudflare account ID |
| `--snapshot` | Path to snapshot JSON file |
| `--state` | Endpoint states to include: `review`, `saved`, `ignored` |
| `--min-hits` | Filter endpoints below hit threshold |
| `--max-groups` | Limit number of groups in output |
| `--output` | Explicit output path (default: `output/<timestamp>/ApiShieldProposed.json`) |

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

3. **Score mutation** — Each signal applies a fixed delta to the running score:
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

### Negative signals (−)

| Signal | Δ | Reason text |
|--------|---|-------------|
| Noise path (health, ping, debug, test, static assets, favicon) | −0.45 | matches debug/health/test noise pattern |
| Very low traffic (<10 hits) | −0.15 | very low traffic |
| Mixed HTTP methods on same shape | −0.10 | mixed HTTP methods on same path shape |
| Host consolidation | −0.05 | host consolidation across multiple subdomains |
| Path variables present | −0.05 | path variables detected — verify shape coverage |
| Already ignored by operator | −0.20 | some members already ignored |

### Flags

When a signal fires, a flag is attached to the proposal:
- `likely-noise` — hit an ignore pattern
- `low-confidence` — very low traffic
- `method-ambiguity` — mixed methods
- `host-consolidation` — collapsed subdomains
- `path-variable` — contains `{varN}`
- `borderline-score` — score fell in the ambiguous middle range

## Architecture

- `src/connectors/` — Cloudflare API, snapshot, future MCP
- `src/normalize.ts` — path + host normalization engine
- `src/classify.ts` — heuristic scoring (save / ignore / manual_review)
- `src/proposal.ts` — explanation generator + bundle export
- `src/agent.ts` — orchestrator
- `src/cli.ts` — CLI entry point

## Security notes

- Prefer `CF_API_TOKEN` environment variable over `--api-token` flag.
- `--api-token` leaks into shell history and process lists.
- Use `--token-file` with `chmod 600` if env vars are not an option.

## Tests

```bash
npm test
```

## License

MIT
