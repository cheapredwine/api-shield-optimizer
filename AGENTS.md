# Agent Notes

## Build
- `npm run build` — compiles TypeScript to `dist/`
- `npm run dev` — runs CLI via `tsx`
- `npm test` — runs Vitest

## Running the tool

Preferred: run once to auto-create `optimizer.config.json` (already in `.gitignore`):

```bash
npx tsx src/cli.ts propose
```

The tool creates the config file and exits. Edit it to add your API token:

```json
{
  "mode": "api",
  "apiToken": "your-token",
  "zoneId": "",
  "accountId": ""
}
```

Leave `zoneId` blank for interactive zone picker. Re-run the same command.

Output: `output/ApiShieldProposed-{timestamp}.json` and `.txt`

## Code style
- Strict TypeScript (`strict: true`)
- Use `.js` extensions in imports (NodeNext module resolution)
- Prefer `const`/`let`; no `var`
- Keep logic in pure functions; side effects only in connectors and CLI

## Project structure
- `src/connectors/` — Cloudflare API, snapshot connectors
- `src/normalize.ts` — path + host normalization engine
- `src/classify.ts` — heuristic scoring (save / ignore / manual_review)
- `src/proposal.ts` — explanation generator + bundle export
- `src/format.ts` — human-readable text report formatter
- `src/agent.ts` — orchestrator
- `src/cli.ts` — CLI entry point with config file support

## Adding a new connector
1. Implement `DataConnector` interface in `src/connectors/`
2. Export from `src/connectors/index.ts`
3. Add mode to `ConnectorConfig['mode']` union in `src/types.ts`

## Extending classification
Edit `src/classify.ts`:
- Add regex patterns to `SAVE_PATH_PATTERNS` or `IGNORE_PATH_PATTERNS`
- Adjust scoring constants; keep decision boundary at `0.65` save / `0.35` ignore

## Extending normalization
Edit `src/normalize.ts`:
- Add regex to `isVariableSegment()`
- Ensure hostname variables cover a **complete label** only
- Variable-depth subdomains are **not** collapsed (safety guard)

## Output
- Default: `output/ApiShieldProposed-{timestamp}.json` and `.txt`
- Custom: `--output <path>` writes explicit path + `.txt` variant

## Testing
- Add unit tests in `src/__tests__/engine.test.ts`
- Run `npm run lint` before committing
