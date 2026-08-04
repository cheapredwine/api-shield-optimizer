# API Shield Optimizer

A command-line tool that reads Cloudflare API Shield endpoint discovery, groups
the noise into stable patterns, and proposes which operations to **save** and
which to **ignore** — with the evidence for each call spelled out.

**This tool never writes to the Cloudflare API.** It reads discovery data and
produces reports plus ready-to-send request payloads. Applying a change is
always a deliberate human action.

---

## Why

API Shield discovery returns raw observed endpoints. A busy zone produces
thousands of them, most of which are the same operation with a different ID in
the path:

```
GET /api/v1/orders/8812
GET /api/v1/orders/9930
GET /api/v1/orders/10244
... x2,000
```

Saved operations are capped by plan, so the job is not "save everything that
looks like an API" — it is "spend a limited number of operation slots on the
endpoints that matter". This tool collapses the noise into
`GET /api/v1/orders/{var1}`, scores it, and ranks proposals against the budget.

---

## Install

```bash
npm install
```

Requires Node 18+ (uses native `fetch` and `AbortSignal.timeout`).

---

## Quick start

```bash
# 1. First run scaffolds a config file and exits.
npx tsx src/cli.ts propose

# 2. Point tokenFile at a token outside the repo, then re-run.
npx tsx src/cli.ts propose
```

Output lands in `output/ApiShieldProposed-{timestamp}.json`, `.txt` and `.csv`.

### Config

The first run writes `optimizer.config.json`:

```json
{
  "tokenFile": "/absolute/path/to/cf_api_token",
  "zoneId": "",
  "accountId": "",
  "minHits": 0,
  "maxGroups": 0
}
```

Leave `zoneId` blank to get an interactive zone picker, which offers to save your
choice back to the config so you are only asked once. `minHits: 0` and
`maxGroups: 0` mean "no filter" and "no limit".

To run non-interactively, set `zoneId` or pass `--zone-id`. With neither, and no
terminal to prompt on, the tool exits with an error rather than hanging.

Config is resolved in this order:

1. `--config <path>`
2. `./optimizer.config.json`
3. `$XDG_CONFIG_HOME/api-shield-optimizer/config.json` (default `~/.config/...`)

### API token

Create the token at **My Profile → API Tokens → Create Token → Custom** with
read-only permissions:

| Permission | Needed for |
|---|---|
| Zone → **API Gateway** → Read | discovery operations, saved operations, schemas |
| Zone → **Zone** → Read | the `zones` command and the zone picker |

Scope it to the specific zones you intend to analyse. The tool only ever issues
`GET`, so read-only is sufficient — granting write would defeat the point.

#### Storing it

Write the token to a file without it ever entering your shell history:

```bash
mkdir -p ~/.cloudflare && chmod 700 ~/.cloudflare
read -rs CF_TOK \
  && printf '%s' "$CF_TOK" > ~/.cloudflare/api-shield-token \
  && chmod 600 ~/.cloudflare/api-shield-token \
  && unset CF_TOK
```

Paste the token at the blank prompt and press Enter. `read -rs` does not echo it,
`-r` stops backslashes being interpreted, `printf '%s'` avoids a trailing
newline, and `unset` drops it from the shell afterwards.

Then reference the path in your config:

```json
{ "tokenFile": "/Users/you/.cloudflare/api-shield-token" }
```

The tool warns if the file is group- or world-readable and tells you to
`chmod 600` it.

#### Other ways, in descending order of preference

| Method | Trade-off |
|---|---|
| `tokenFile` | Recommended. Nothing sensitive in history, env, or argv. |
| `CF_API_TOKEN` env var | Inherited by child processes; leaks to history if typed interactively. |

Resolution order is `tokenFile` → `CF_API_TOKEN`. Those are the only two
channels, deliberately:

- There is **no `--api-token` flag**. An argument is visible in shell history and
  in the process list to every other user on the machine.
- The config file holds **no inline token**, so `optimizer.config.json` can be
  copied, shared, or committed to a private repo without carrying a secret.

---

## Workflow

The three commands are meant to be used in sequence.

```bash
# 1. Analyse. Produces a proposal bundle.
npx tsx src/cli.ts propose --operation-budget 500

# 2. Decide. Walks the borderline calls interactively.
npx tsx src/cli.ts review --bundle output/ApiShieldProposed-<stamp>.json

# 3. Emit payloads. Still sends nothing.
npx tsx src/cli.ts export-payload \
  --bundle output/ApiShieldProposed-<stamp>.json \
  --decisions output/ApiShieldDecisions-<stamp>.json
```

### `propose`

Fetches discovery data, groups, scores and writes a bundle.

| Flag | Purpose |
|---|---|
| `--zone-id`, `--account-id` | Cloudflare IDs (32 hex chars). |
| `--state <states>` | Discovery states to read: `review,saved,ignored`. |
| `--no-schemas` | Skip uploaded OpenAPI schema enrichment. |
| `--exclude-decided` | Analyse only undecided operations. By default every operation is reported, including those already saved or ignored. |
| `--min-hits <n>` | Drop endpoints below a hit count. |
| `--max-groups <n>` | Cap the number of reported groups. |
| `--operation-budget <n>` | Plan operation cap; enables budget reporting. |
| `--max-members <n>` | Members embedded per proposal (`0` = all, default 25). |
| `--only <actions>` | Report only `save`, `ignore`, `manual_review`. |
| `--min-confidence <n>` | Report only proposals at/above this confidence. |
| `--format <json\|text\|csv>` | Output format. |
| `--verbose` | Full signal breakdown in the text report. |
| `--output <path>` | Explicit path; `-` writes to stdout. |

By default all three formats are written side by side. With `--output`, only the
chosen `--format` is written.

### `review`

Interactive triage. Prints the score breakdown, signals and sample members for
each proposal and records your decision. Defaults to `--only manual_review`,
since that is where human judgement is actually needed.

```
Decision [s/i/a/d/n/e/b/q/?]:
  s  save              i  ignore           a  accept recommendation
  d  defer             n  attach a note    e  expand all signals
  b  previous          q  stop and save    ?  help
```

Decisions are written to a decision file. Quitting early, or reaching the end of
piped input, still persists everything decided so far. Resume with
`--decisions <path>`; the tool warns if the file was produced by a different
ruleset version.

### `export-payload`

Turns a bundle (plus optional decisions) into exact Cloudflare API request
bodies, with `curl` previews. Decisions override recommendations. `manual_review`
proposals cannot be exported — decide them first.

```
POST  /zones/{zoneId}/api_gateway/operations             # create saved operations
PATCH /zones/{zoneId}/api_gateway/discovery/operations   # mark as ignored
```

Nothing is transmitted. Review the payload, then apply it yourself.

### Utilities

```bash
npx tsx src/cli.ts zones           # list accessible zones
npx tsx src/cli.ts smoke-fetch     # fetch operations, print pagination stats
```

---

## Normalization

Two independent passes, both deliberately conservative.

**Paths.** A segment becomes a variable when it looks like an identifier: numeric
IDs, UUIDs, hashes, dates, or high-entropy strings judged by character-class
transitions and digit ratio. The heuristic is tuned to leave real words alone —
`iphone13promax`, `top10bestlaptops` and `office365business` stay literal.

Variables use Cloudflare's own convention — `{varN}` in paths, `{hostVarN}` in
hosts — so patterns are directly comparable with what API Shield returns.
Discovery often supplies pre-normalized shapes like `{hostVar1}.example.com`;
those placeholders are preserved as-is, and any variable this tool introduces
continues Cloudflare's numbering rather than colliding with it.

**Hosts.** A label becomes `{hostVarN}` only when it is a complete label and the
registrable domain (eTLD+1) is untouched. So `api.example.com` and
`api.example.org` never collapse, and neither do `api.acme.com` and
`api.evilcorp.com`. The same protection extends to two-label ccTLD suffixes —
`api.acme.com.co` and `api.evilcorp.com.co` never collapse either, even though
`com.co` isn't on any hardcoded list; a short final label preceded by a generic
word (`com`, `co`, `gov`, ...) is recognised as a shared suffix for any country
code. Variable-depth subdomains are never collapsed.

---

## Scoring

Every group is scored on two independent axes:

- **`api`** — is this an API surface at all?
- **`sensitivity`** — if it is, is it worth spending an operation slot on?

```
combined = 0.6 * api + 0.4 * sensitivity
```

Decision boundaries:

Evaluated in order; the first match wins.

| Condition | Result |
|---|---|
| sensitive but below the `api` floor | `manual_review` — too consequential to drop unreviewed |
| `api < 0.4` | `ignore` — below the floor, not an API surface |
| `cf-risk-zombie` | `manual_review` — already saved, review the slot |
| no discriminating `api` evidence | `manual_review` — cannot tell a page from an API |
| `api >= 0.8` | `save` — conclusively an API |
| `combined >= 0.62` | `save` |
| `combined <= 0.38` | `ignore` |
| otherwise | `manual_review` |

Splitting the axes matters: a marketing page at `/blog/generate-more-leads` can
mention a keyword, but it never clears the `api` floor, so it can never be
saved on that basis alone.

The fourth rule is what separates a rendered form from an endpoint when no label
is available. An HTML form is submitted with `POST`, lives on an auth path, and
serves `GET` and `POST` on the same URL, so none of that evidence distinguishes
it from an API. An operation is only saved automatically if something actually
discriminating backs it — an uploaded schema, an `api` label, a BOLA or
missing-schema risk label, an `/api` or version segment, GraphQL/gRPC, a path
variable, observed auth identifiers, an API hostname, or a confirmed API parent
path. Otherwise it goes to a human rather than being dropped, because a missing
signal is not proof that an endpoint is a page.

**`confidence` is separate from the score.** It measures how much evidence backs
the decision — traffic volume, member count, feature data, schema membership,
observation freshness — not how strong the recommendation is. A confident
`ignore` is a normal outcome.

### Cloudflare managed labels

The strongest signals are Cloudflare's own **managed labels**, returned on every
discovered operation. They reflect Cloudflare's response inspection and traffic
analysis rather than a guess from the URL, so they outweigh path heuristics.

| Label | Effect |
|---|---|
| `cf-api-endpoint` | strong `api` — serves machine-readable responses |
| `cf-web-page` | strong negative `api` — serves HTML |
| `cf-mcp` | Model Context Protocol endpoint; raises both axes |
| `cf-log-in`, `cf-sign-up`, `cf-password-reset` | credential handling → `sensitivity` |
| `cf-add-payment`, `cf-purchase`, `cf-add-cart`, `cf-check-value` | payment and commerce flows → `sensitivity` |
| `cf-risk-sensitive` | WAF matched sensitive data in responses → strong `sensitivity` |
| `cf-risk-bola-*` | active enumeration or pollution attacks observed — both axes: the attack is only possible against an API, and it is worth protecting |
| `cf-risk-missing-schema` | a learned schema exists → `api`, implying a structured API surface |
| `cf-risk-missing-auth`, `cf-risk-mixed-auth` | successful unauthenticated requests |
| `cf-risk-zombie` | saved but idle 32 days → routed to review to reclaim the slot |
| `cf-rss-feed` | machine-readable but rarely worth an operation slot |

This is what separates an HTML login form from an API login endpoint. Both match
every `login`/`auth` path keyword, but only one carries `cf-web-page`:

```
POST www.acme.com/users/login   cf-web-page, cf-log-in   → ignore  (api 0.12)
POST api.acme.com/v1/sessions   cf-api-endpoint, cf-log-in → save  (api 1.00)
```

Note that the rejected form still scores high on `sensitivity` — it genuinely
handles credentials. It is rejected because it is not an API surface, which is
exactly the distinction the two axes exist to make.

### Other signals

| Signal | Axis | Note |
|---|---|---|
| Present in an uploaded OpenAPI schema | api | highest-precision non-label signal |
| `/api` or version segment | api | anchored to whole segments |
| API hostname | api | matched on the host, e.g. `api.`, `graphql.`, `*-api.`; suppressed by `cf-web-page` |
| GraphQL / gRPC endpoint | both | one path fronting an entire API |
| Auth tokens observed | both | from API Shield feature data |
| Write method | both | `POST`/`PUT`/`PATCH`/`DELETE` |

Response metadata — content type, status codes, cache-hit ratio, sitemap
membership — is **not returned by the discovery API**, so nothing here depends on
it. Telling a rendered page from an API surface is the managed labels' job.

All weights, patterns and thresholds live in `src/scoring-config.ts` and can be
overridden per-run via a `scoring` key in the config file. The active
`rulesetVersion` is stamped into every bundle so a report can always be traced
to the rules that produced it.

---

## Traffic data

The discovery API reports traffic only as a **rate** —
`features.traffic_stats.requests` over `period_seconds` — never as an absolute
count, so `Endpoint.hits` is always `null` and every comparison uses requests per
hour. A rate is the better basis anyway: an absolute total mostly favours whichever
endpoint has been observed longest.

`null` means unknown, not zero. Managed operations carry no traffic data at all,
and scoring that as zero traffic would penalise exactly the endpoints already
known to matter.

---

## Output

Each proposal explains itself:

- `whyThisGroupingIsSafe` — why the normalization did not over-generalize
- `whyThisGroupingIsUseful` — what consolidating it buys
- `whyItMayBeWrong` — the honest failure modes
- `score` / `signals` — every rule that fired, with its weight
- `confidenceScore` — strength of the underlying evidence

Bundles also report already-saved and already-ignored counts, groups whose
members disagree about their current state, and — with `--operation-budget` —
how the proposals fit the available slots.

---

## Development

```bash
npm run build    # compile to dist/
npm test         # vitest
npm run lint     # tsc --noEmit
npm run format   # prettier
```

See `AGENTS.md` for architecture and extension points.

---

## Limitations

- Discovery only sees observed traffic. An endpoint with no requests in the
  window will not appear.
- Session-identifier discovery requires a configured session ID.
- Scoring is heuristic. `manual_review` means the tool genuinely cannot tell —
  treat it as a prompt, not a failure.
- The zone operation cap is not read automatically; pass `--operation-budget`.
