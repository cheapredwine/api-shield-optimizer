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
npx tsx src/cli.ts propose --mode snapshot --snapshot endpoints.json --output bundle.json
```

### API mode

```bash
export CF_API_TOKEN=<your-token>
npx tsx src/cli.ts propose --mode api --zone-id <zone-id> --output bundle.json
```

## CLI options

| Option | Description |
|--------|-------------|
| `--mode` | `api` or `snapshot` |
| `--api-token` | Cloudflare API token ( discouraged — use env var or token file ) |
| `--token-file` | Path to file containing API token |
| `--zone-id` | Cloudflare zone ID |
| `--account-id` | Cloudflare account ID |
| `--snapshot` | Path to snapshot JSON file |
| `--min-hits` | Filter endpoints below hit threshold |
| `--max-groups` | Limit number of groups in output |
| `--output` | Write bundle to file instead of stdout |

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
