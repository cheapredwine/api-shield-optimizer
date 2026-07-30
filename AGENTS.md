# Agent Notes

CLI-only tool. There is no Worker, no server and no deployment step.

**Hard rule: this tool must never write to the Cloudflare API.** Connectors issue
`GET` only. `src/export.ts` builds request payloads as data and performs no
network I/O. Do not add a command that applies changes.

## Build
- `npm run build` — compiles TypeScript to `dist/`
- `npm run dev` — runs CLI via `tsx`
- `npm test` — runs Vitest
- `npm run lint` — `tsc --noEmit`

## Running the tool

Run once to auto-create `optimizer.config.json` (already in `.gitignore`):

```bash
npx tsx src/cli.ts propose
```

The tool creates the config file and exits. Set `tokenFile` to a path outside the
repo:

```json
{
  "mode": "api",
  "tokenFile": "/absolute/path/to/cf_api_token",
  "zoneId": "",
  "accountId": "",
  "minHits": 0,
  "maxGroups": 0
}
```

Leave `zoneId` blank for the interactive zone picker, which offers to persist the
selection via `src/config.ts`.

Store the token without leaking it into shell history:

```bash
mkdir -p ~/.cloudflare && chmod 700 ~/.cloudflare
read -rs CF_TOK \
  && printf '%s' "$CF_TOK" > ~/.cloudflare/api-shield-token \
  && chmod 600 ~/.cloudflare/api-shield-token \
  && unset CF_TOK
```

Never paste a token into a transcript. Token precedence is `tokenFile` →
`CF_API_TOKEN`, and that is the whole list. Do not add a flag that accepts a
secret (visible in argv and shell history), and do not reintroduce an inline
`apiToken` config key — the config file is meant to be safe to share.

Config resolution order: `--config <path>` → `./optimizer.config.json` →
`$XDG_CONFIG_HOME/api-shield-optimizer/config.json`.

For iteration without hitting the API, use snapshot mode — only `host`, `method`
and `path` are required per entry:

```bash
npx tsx src/cli.ts propose --mode snapshot --snapshot fixture.json --format text --output -
```

## Code style
- Strict TypeScript (`strict: true`)
- Use `.js` extensions in imports (NodeNext module resolution)
- Prefer `const`/`let`; no `var`
- Keep logic in pure functions; side effects only in connectors and CLI

## Project structure
- `src/validate.ts` — ID/state/integer validation shared by CLI and connectors
- `src/connectors/` — Cloudflare API and snapshot connectors, plus `createConnector`
- `src/normalize.ts` — path + host normalization, grouping
- `src/scoring-config.ts` — all tunable weights, patterns, thresholds, `rulesetVersion`
- `src/classify.ts` — two-axis scoring and confidence
- `src/proposal.ts` — explanation generator + bundle assembly
- `src/format.ts` — human-readable text report
- `src/export.ts` — ready-to-POST payload + CSV builders (no network)
- `src/review.ts` — interactive review loop
- `src/prompt.ts` — `LineReader`/`askOnce`; the only sanctioned way to read stdin
- `src/config.ts` — config file persistence (the only file the tool mutates)
- `src/agent.ts` — orchestrator, budget ranking
- `src/cli.ts` — CLI entry point

## Command surface
`propose`, `review`, `export-payload`, `zones`, `smoke-fetch`, `snapshot-guide`.

Intended sequence: `propose` → `review` → `export-payload`.

## Adding a new connector
1. Implement the `DataConnector` interface in `src/connectors/`
2. Add the case to `createConnector` in `src/connectors/index.ts`
3. Add the mode to `ConnectorConfig['mode']` in `src/types.ts`
4. Read-only. `GET` requests only.

## Extending classification

Edit `src/scoring-config.ts`, not `classify.ts`, for anything tunable:

- `labelRules` — exact-match rules on Cloudflare managed labels. These are the
  highest-value signal in API mode and the only reliable way to tell an HTML
  form from an API endpoint. Enumerate the live set with
  `GET /zones/{zone}/api_gateway/labels`; every managed entry has
  `source: "managed"`. A label may appear on both axes.
- `pathRules` / `sensitivityRules` — regex rules with weights
- Anchor every pattern to whole segments, i.e. `(?:^|/)word(?:/|$)`. Unanchored
  substrings caused the original false positives: `/priv` matched
  `privacy-policy`, `/user` matched `user-guide`.
- Bump `rulesetVersion` when weights or thresholds change. It is embedded in
  every bundle and decision file, and `review` warns on a mismatch.

Scoring is two independent axes, `api` and `sensitivity`, combined as
`0.6 * api + 0.4 * sensitivity`. Decision order in `classify.ts`, first match
wins:

1. sensitive but not API-shaped → `manual_review`
2. `api < apiFloor` (0.4) → `ignore`
3. `cf-risk-zombie` → `manual_review`
4. `api >= apiCertain` (0.8) → `save`
5. `combined >= saveThreshold` (0.62) → `save`
6. `combined <= ignoreThreshold` (0.38) → `ignore`
7. otherwise → `manual_review`

Rule 1 exists because rule 2 is a hard short-circuit that never weighs
sensitivity. An unlabelled `POST /checkout/session/{id}` scores `api` 0.35
against a 0.40 floor, so it was ignored despite a financial signal — the worst
failure direction for a security tool.

**Do not trigger rule 1 on sensitivity alone.** It is gated on
`sensitivityRescueApiFloor` (0.3), because a managed `cf-web-page` label pulls
`api` to ~0.21 and those pages score *higher* on sensitivity (1.00) than the
endpoints worth rescuing (0.50). Gating on sensitivity alone floods manual review
with marketing pages — measured at 127 of them on a 3,000-operation fixture.

Rule 3 must stay ahead of rule 4: a zombie is definitionally an API, so
`apiCertain` would auto-save it, but it is *already* saved and the real question
is whether to reclaim the slot. Mirror any change to rules 1 and 3 in
`redecide()`, which re-runs the whole decision after sibling propagation.

`confidence` is evidence strength, computed independently of the score. Do not
make it a restatement of the score.

Add signals via the `add(axis, id, weight, detail)` helper so every contribution
appears in the report. A recommendation with no visible signal is a bug.

## Extending normalization
Edit `src/normalize.ts`:
- Add detection to `isVariableSegment()`
- Prefer `inferSiblingVariables()` over a new regex. Per-segment rules judge each
  literal in isolation, so members of one identifier family land on opposite
  sides of a threshold and a single logical operation is reported as a `{varN}`
  group **plus** a tail of literal groups. Sibling inference never inspects the
  literal: a position is variable when enough distinct values share a prefix,
  depth and identical continuation. That is also the only thing that can catch
  word-based ids (`/c/{category}`, `/p/{slug}`), which are indistinguishable
  from static resource names in isolation. It removed the need for a
  format-specific rule entirely — 2,998 overlapping operations collapsed from
  493 groups to 32.
- Already-variable siblings **count as evidence**, and a confirmed position
  propagates to deeper continuations (`/x/{id}` ⇒ `/x/{id}/sub`). Both were
  bugs: without them an id family stayed split exactly when half of it had been
  recognised, and sub-resources with few observed values never collapsed.
- Add action verbs to `STATIC_SEGMENT_ALLOWLIST`, not just resource nouns. An
  action shares its collection's prefix, so `/products/search` pools with
  `/products/{sku}` and gets absorbed into the identifier position, hiding an
  operation and misattributing its traffic. Erring toward literal is safe: a
  missing entry merges two operations, a spurious one only splits a group.
- Keep domain-specific formats out. A VIN rule was added and then removed once
  sibling inference subsumed it; customer-specific identifier shapes do not
  belong in a general normalizer.
- Keep `isHighCardinalitySegment()` conservative. Regressions to watch:
  `iphone13promax`, `top10bestlaptops`, `office365business`, `html5videoplayer`,
  `error404handler` must all stay literal.
- Cloudflare's placeholders (`{varN}`, `{hostVarN}`) are tokens, not names. Route
  every hostname through `canonicalizeHost()` rather than calling
  `toLowerCase()`, which produced `{hostvar1}` in every report. New variables
  must continue Cloudflare's numbering.
- Hostname variables must cover a **complete label** and must never touch the
  registrable domain (eTLD+1). Add new multi-label suffixes to
  `MULTI_LABEL_SUFFIXES`.
- Variable-depth subdomains are **not** collapsed (safety guard)

## Reading stdin

Always go through `src/prompt.ts`. Never call `rl.question` directly: with
`terminal: false` readline drops lines buffered before the call, and a closed
stream leaves the callback unfired, so the process hangs or exits silently having
done nothing. Both bugs shipped once — in `review` (losing every decision on
piped input) and in the zone picker. `LineReader` queues lines and returns `null`
at end of input; handle that case explicitly.

## API mode vs snapshot mode signals

`contentTypes`, `statusCodes`, `cacheHitRatio` and `inSitemap` are **not returned
by the discovery API**. They are snapshot-mode enrichment only. Do not assume
they are present when reasoning about classification, and do not validate a
scoring change solely against a snapshot fixture that supplies them — that
mistake hid a false positive where an HTML login form scored `api=0.74`.

In API mode the equivalent signal comes from managed labels.

## Already-decided operations

`propose` reports **every** operation by default, including those already saved
or ignored in the zone. Saved operations occupy the operation budget, and a saved
operation is the only place a `cf-risk-zombie` label can appear, so filtering
them out hides both the slots in use and the slots worth reclaiming — and on a
zone whose only real API is already saved, it hides the entire API surface.
`--exclude-decided` opts out. The default lives in `AgentOptions.includeDecided`
(`?? true`), not just in the CLI, so library callers get the same behaviour.

## Traffic data

`Endpoint.hits` is `number | null`. `null` means unknown, not zero. Managed
operations carry no traffic data. Never coerce `null` to `0` — use
`totalKnownHits()`. Filters must retain endpoints with unknown traffic.

**In API mode `hits` is always `null`.** The discovery API reports traffic only
as a rate — `features.traffic_stats.requests` over `period_seconds` — never as an
absolute count. Use `requestsPerHour()` / `totalRequestsPerHour()`, and prefer a
rate for comparisons anyway: an absolute total just favours whichever endpoint
was observed longest.

Consequences worth remembering:
- `rankValue()` in `src/agent.ts` falls back to the rate. Without that fallback
  every live endpoint contributes zero and budget ranking degenerates to path
  order — a `--operation-budget 2` run picked 5 req/hr over 900 req/hr.
- `hasTrafficData` must consider the rate, or every live endpoint is flagged
  `no-traffic-data` and reports read `Total Hits: 0`.
- `highTrafficRatePerHour` / `lowTrafficRatePerHour` are **absolute** thresholds
  (1000 and 1). On a zone doing billions of requests a day every endpoint clears
  the high mark and none falls below the low one, so both signals saturate and
  stop discriminating. Percentile-relative thresholds are the known fix.

## Output
- Default: `output/ApiShieldProposed-{timestamp}.json`, `.txt` and `.csv`
- `--output <path>` writes only the selected `--format`
- `--output -` streams to stdout, so reports print but progress goes to stderr

## Testing
- `src/__tests__/engine.test.ts` — normalization, scoring, proposals
- `src/__tests__/connectors.test.ts` — API pagination/validation, snapshot parsing
- `src/__tests__/review.test.ts` — interactive loop (drive it with `Readable.from`)
- `src/__tests__/prompt.test.ts` — line buffering and end-of-input behaviour
- `src/__tests__/config.test.ts` — config mutation, permission and failure modes
- Run `npm run lint` before committing
- When fixing a classification bug, add the offending path as a named regression
  case

### Where coverage has been thin

Two bugs survived because **no test asserted the shape of the output**, only the
scores:

- The CSV column headed `flags` carried signal ids, so triage flags never reached
  the spreadsheet an operator signs off on.
- `includeDecided` had no test at all, which is why flipping its default broke
  nothing.

Prefer a test that asserts what an operator actually sees over one that asserts an
internal number.

## Open questions and future work

Ordered roughly by risk. Nothing here is blocking, but each is a known weakness
rather than a speculative nicety.

### Validate against real high-cardinality data
Every collapse figure quoted in this file (493 → 32 groups) comes from a
hand-authored fixture, so it partly encodes the author's assumptions about what
the traffic looks like. `MIN_SIBLINGS_FOR_VARIABLE = 4` and the stage-2 prefix
propagation are the two riskiest knobs: propagation could over-merge a genuine
sub-resource that is missing from `STATIC_SEGMENT_ALLOWLIST`. A sanitized path
list from a zone with thousands of overlapping operations would settle it. Until
then, treat the numbers as indicative.

### Percentile-relative traffic thresholds
`highTrafficRatePerHour` / `lowTrafficRatePerHour` are absolute, so on a very
large zone every endpoint clears the high threshold and the signal stops
discriminating. Replace with per-zone percentiles, and keep the absolute values as
a fallback for zones too small for percentiles to mean anything.

### Surface truncation
`fetchPaginated` computes a `truncated` flag and then discards it. `MAX_PAGES`
(200) × `PER_PAGE` (100) caps a zone at 20,000 operations. A zone past that limit
is silently analysed on partial data, which is exactly the situation where a
missing endpoint matters most. Thread it into `EndpointFetchStats` and print it.

### No-label fallback has almost no headroom
An operation with no managed labels sits at `baseApiScore` 0.35 against an
`apiFloor` of 0.40 — a 0.05 gap that only `pathRules` can close. A real API on a
path with no recognisable API markers (no `/api`, no version, no variable) is
therefore ignored unless it trips a sensitivity rule. Worth measuring how often
labels are actually absent in practice before tuning, since in API mode labels are
the primary signal.

### Host consolidation is coarse
`normalizeHost` collapses `api.retail.com` and `m.retail.com` into
`{hostVar1}.retail.com`, which is flagged but may still merge materially different
applications — a mobile backend and a web backend can have different auth and
different risk. Consider making collapse conditional on the two hosts having
similar path sets.

### Method-set reporting
Groups are keyed by method, so `GET /x` and `POST /x` are separate proposals. That
is correct for API Shield, but a reviewer usually wants to see the whole method
set for a path together. A grouped view would reduce review effort without
changing the emitted payload.

### `manual_review` volume has never been measured against a real budget
The escalation rules deliberately push ambiguous cases to humans. On a zone with
thousands of operations that queue could be impractically long. Measure it, and if
it is unmanageable, rank `manual_review` by traffic rate so the queue is at least
ordered by consequence.
