# Agent Notes

## Build
- `npm run build` — compiles TypeScript to `dist/`
- `npm run dev` — runs CLI via `tsx`
- `npm test` — runs Vitest

## Code style
- Strict TypeScript (`strict: true`)
- Use `.js` extensions in imports (NodeNext module resolution)
- Prefer `const`/`let`; no `var`
- Keep logic in pure functions; side effects only in connectors and CLI

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

## Testing
- Add unit tests in `src/__tests__/engine.test.ts`
- Run `npm run lint` before committing
