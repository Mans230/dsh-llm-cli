# dsh-llm-cli

Model routes for **DeepSeek Harness** served by **agent CLIs installed on the
host** instead of an HTTP provider API — plus a charted usage dashboard that
reads what those CLIs record about themselves.

[![CI](https://github.com/Mans230/dsh-llm-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Mans230/dsh-llm-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg)](package.json)

| Route | CLI | Turn |
| --- | --- | --- |
| `opencode` | OpenCode CLI | `opencode run --model <m> --format json` |
| `grok` | Grok Build CLI | `grok -p <prompt> -m <m> --output-format streaming-json` |
| `codex` | OpenAI Codex CLI | `codex exec --json -m <m> <prompt>` |

Each CLI owns its authentication and agent loop. Text deltas are forwarded as
the CLI emits them. Turns use the DSH session workspace and forward its system
instructions by default. Offered harness tools can be requested through a JSON
relay; the harness executes them under its own permission rules and returns
correlated results on the next turn. This relay depends on the model following
the protocol; it is not native MCP forwarding.

Image attachments are resolved through the DSH attachment service and delivered
as actual bytes: Codex uses `--image`, OpenCode uses `--file`, and Grok uses ACP
image blocks over stdin. Vision still requires a capable model. OpenCode accepts
one image per request; Codex/Grok accept up to eight, at most 20 MiB each. PNG,
JPEG, WebP and GIF are accepted. Temporary attachment files are removed after
the turn. Missing attachment services produce an explicit error.

## Requirements

- Node.js **20.11+** (the plugin itself has **no dependencies**; the peer
  `@deepseek-ai/*` packages come from the harness).
- Internet access to install missing CLIs, or an existing installation:
  - OpenCode — `opencode` (the `opencode/*-free` model ids need no account)
  - Grok Build — `grok` (sign in with `grok login --device-auth`)
  - OpenAI Codex — `codex` (sign in with `codex login --device-auth`)

Missing CLIs install automatically on their first model turn or sign-in request.
The Web plugin page has **CLI setup and sign-in** controls: install, start
sign-in, check status and cancel. Existing accounts are reused. New sign-ins
display the CLI's real device URL/code and poll while you approve in a browser.
OpenCode's account flow targets OpenCode Console's `device` method; free models
can still run without an account. A successful status check, not a displayed
code, determines whether the account is signed in.

Installation runs as the DSH process user on the machine running this plugin.
If DSH runs inside a VM, installation and credentials belong to that VM. This
does not connect to a different VM or copy accounts between machines. OpenCode
and Codex use their official npm packages (`@opencode/cli`, `@openai/codex`)
under `~/.dsh/clis`; Grok uses the official x.ai installer with its binary
directory set there. Nothing is installed globally by this plugin. The Grok
installer may manage its own downloads/PATH integration under the user profile.
Node/npm and, for Grok on POSIX, bash plus curl/wget must be available.

Setup HTTP actions are host-only and require the host action token. Remote
dashboard readers cannot obtain that token; use an authorized DSH
`provider_signin` tool call or a loopback tunnel to the host for VM setup.

On Windows the plugin reads an npm `.cmd` shim and launches its real target
instead of handing the shim to a shell, so prompt text never reaches a shell.
A bare command name is looked up on `PATH` with `PATHEXT`, which is how a
globally installed CLI that ships only a shim stays reachable.

## Install

The package is a plugin **bundle**: `package.json` declares
`dsh.bundle.patch` (the bundled `cordis.patch.yml`, which mounts the host plugin)
and `dsh.client.platform: web` (the browser half at `./client`, discovered from
the manifest).

Wire it into a profile by adding it as a dependency and selecting its bundle:

```json
{
  "dependencies": { "dsh-llm-cli": "git+https://github.com/Mans230/dsh-llm-cli.git" },
  "dsh": { "profile": { "bundles": ["dsh-llm-cli"] } }
}
```

Use the `git+https` form rather than the `github:` shorthand. npm resolves the
shorthand over SSH, which fails on a host with no GitHub key even though the
repository is public. The update button retries over https when the shorthand
fails, but starting from https avoids the round trip.

or, in the Web UI, **Plugins → Add plugin** with this package's path. See
[MOUNT-EXAMPLE.md](MOUNT-EXAMPLE.md) for the junction-based local install.

## Configuration

The bundle mounts the entry with defaults; a profile patch overrides it by `id`:

```yaml
- id: llm-cli
  config:
    cwd: '/path/to/agent/workspace'
    usageFile: '/path/to/.dsh/llm-cli-usage.json'
    # Optional "usage plan" gauges. The CLIs publish no quota for Grok/OpenCode,
    # so a budget gauge is only drawn against numbers you set here; without them
    # the dashboard shows plain measured usage. `resetDay` is the day of month
    # the period starts on (1-28).
    plan:
      grok:
        # The grok.com "Weekly Premium Limit" (the CLI exposes it only behind a
        # private RPC, so copy it here): used percent + reset time.
        weeklyPremium:
          usedPercent: 1
          resetAt: '2026-10-23T15:13:00Z'
        monthlyBudgetUsd: 20
        resetDay: 1
      opencode:
        monthlyBudgetTokens: 100000000
        resetDay: 1
    providers:
      opencode:
        models: [opencode/deepseek-v4.1-flash-free]
      codex: {}
      grok: {}
```

- `cwd` — fallback workspace for calls without a session id. Session turns use
  `ctx.sessions.get(sessionId).header.cwd`; a missing session workspace fails
  explicitly. `providers.<id>.cwd` overrides the fallback for that route.
  Programmatic mounts may supply `resolveCwd(options)` instead.
- `usageFile` — the usage ledger (JSON). Counts only: never prompt or reply text.
  Writes take a lock and merge with what is on disk, so two profiles can share
  one file without losing each other's turns.
- `providers.<id>` — `false`/`{enabled:false}` to disable a route; `models` to
  offer an explicit list (otherwise whatever the CLI lists); `bin`,
  `defaultModel`, `displayName`, `contextWindow` to override.
- `providers.<id>.models` entries are either a bare model id or an object that
  also states that model's limits: `{ id, name?, contextWindow?,
  maxOutputTokens? }`. OpenCode reads native limits with
  `opencode api GET /api/model`. `providers.opencode.contextWindowCap` defaults
  to 500,000; smaller published limits stay smaller. With
  `preserveFreeContext: true` (default), `*-free` models advertising at least
  one million tokens retain their native context. Published output limits stay
  unchanged. If the catalog is unavailable, the 200,000-token harness fallback
  is explicitly labeled. Set `modelInfoArgs: false` to disable catalog lookup.
  A configured entry
  wins over the route's `contextWindow` and over anything a CLI cache reports:

  ```yaml
  providers:
    opencode:
      models:
        - opencode/deepseek-v4.1-flash-free
        - id: getvibe/deepseek-v4.1-flash
          name: DeepSeek V4.1 Flash (getvibe)
          contextWindow: 65536
          maxOutputTokens: 8192
  ```

  The dashboard labels such a row `configured for this model` rather than
  claiming the CLI published it.
- `timeoutMs` — per-turn timeout.
- `autoInstall` — install a missing default CLI on first use (default `true`);
  `false` requires an explicit Install CLI action or operator installation.
- `cliInstallDir` — absolute managed-install directory (default `~/.dsh/clis`).
- `installTimeoutMs` — installer timeout (default five minutes).
- `providers.<id>.installCommand` — optional trusted operator configuration
  `{ bin, args, binPath, binArgs? }` for offline/custom installers. HTTP callers
  cannot supply commands. A missing explicitly configured `bin` is an error
  unless an installCommand is also configured; it is never silently replaced.
- `plan.<route>` — optional monthly budget for the dashboard gauges:
  `monthlyBudgetUsd`, `monthlyBudgetTokens` and `resetDay`.
- `grokUsageDir` — where the Grok CLI keeps its session stores (default
  `~/.grok/sessions`); the dashboard sums the per-session `usage.json` files.
- `codexUsageDir` — where the Codex CLI keeps its session rollouts (default
  `~/.codex/sessions`); the dashboard reads the newest rate-limit and token
  snapshot from them.
- `codexModelsCache` — Codex's own model catalog (default
  `~/.codex/models_cache.json`); the route offers the entries it marks `list`
  (pin `providers.codex.models` to override).
- `opencodeStats.args` — override the `opencode stats` arguments the dashboard
  runs (default `stats --json --all --models --cost`).
- `includeSystemPrompt` — forward system/developer instructions (default `true`);
  set `false` to opt out.
- `providers.codex.sandbox` — `read-only` (default) or `workspace-write`.
  The latter requests workspace editing; the CLI's own host policy can still
  refuse it. The plugin does not bypass that policy.
- `toolBridge` — JSON harness-tool relay by default; `false` disables it.
- `dashboardToken` — required for a dashboard request from another machine.
  Loopback needs no token. A token shorter than 16 characters does not count as
  configured, so a stray `token=1` cannot unlock remote reads.
- `signInTtlMs` — how long a device-code sign-in may wait for a human before the
  plugin closes it (default 10 minutes).
- `autoUpdate` — `false` (default) disables scheduled update requests. `'check'` looks for a
  newer published version on a timer, `'apply'` installs it too.
- `updateIntervalMs` — how often an auto-updating install checks (default 24
  hours, minimum one minute).
- `updateSource` — the URL the check reads a `package.json` from (default this
  repository's copy on `main`).
- `updateInstall` — `{ method: 'npm'|'git', dir, spec }` for a copy whose install
  the plugin cannot work out by itself.

## What it adds

- The three route groups in the model picker.
- `provider_signin` / `provider_signin_status` tools, and an automatic
  device-code error when a route's CLI is signed out.
- `GET /llm-cli/setup.json` and `POST /llm-cli/setup` provide host-only setup
  status and install/sign-in/status/cancel actions for the Web plugin page.
- `/llm-cli/usage` (HTML) and `/llm-cli/usage.json` (JSON) on the harness's own
  web server, backed by the ledger and the CLIs' own usage. A `?days=`/`?hours=`
  query (or the on-page 5h/7d/30d/90d/all buttons) scopes the charts to a
  trailing window. The two endpoints answer this machine only; another host
  needs `dashboardToken`, presented as `?token=`, an `x-llm-cli-token` header,
  or the `llm_cli_token` cookie the page sets from a query token.
- The plugin's page in **two places** in the Web client, both rendering the same
  charted dashboard:
  - **Plugins → Grok + Codex + OpenCode (CLI)** (`client.js`, slot
    `plugins.item`), and
  - **Settings → LLM usage** (slot `settings.section`).

  Each shows every route and model with the limits its CLI publishes, plus
  charts: daily tokens per CLI, an activity heatmap and token mix, cost by model,
  per-model usage tables, recorded Codex 5-hour and weekly subscription-limit
  snapshots with observation times and stale markers, and — when `plan` budgets or `plan.grok.weeklyPremium` are configured —
  used-vs-budget gauges. It also carries a **Check for updates** button and, when
  a newer version exists, **Update now**.
- `GET /llm-cli/update.json` and `POST /llm-cli/update` for the same two actions
  from the server-rendered page. Both answer this machine only, and the POST
  needs the action token the page or the JSON carries. The POST runs `npm install
  <the spec your profile declares>` for a dependency install, or `git pull
  --ff-only` in the checkout for a git install. **A restart of the profile is
  what loads the new code**, so the update reports `restartRequired` rather than
  pretending the running process changed.

The browser Refresh button and `?force=1` on either usage endpoint invalidate
the plugin's caches and reread the original CLI sources. Codex quota snapshots
remain the last values its CLI recorded, including quota-only events. Refresh
does not query a live account quota; values older than five minutes or past
their reset time are marked stale, even if subsequent chat activity is recent.

## Usage data sources

Two independent usage views are shown, and they answer different questions:

- **This harness** — the turns *this* DSH instance recorded, from the ledger.
- **CLI-recorded** — what each CLI accounts for itself, including sessions
  started outside this harness:
  - **Grok** — the CLI persists per-session token and cost accounting at
    `~/.grok/sessions/<workspace>/<sessionId>/usage.json`; the dashboard sums
    those files (per model, per day, per session). Cost is stored as ticks of
    `1e-10` USD. The CLI writes that file when it runs a session itself, so a
    host with no CLI-run session yet reports the view as unavailable instead of
    showing zero.
  - **OpenCode** — the dashboard runs `opencode stats --json --all --models
    --cost` (cached) for lifetime totals, per-model usage and a daily activity
    series.
  - **Codex** — the CLI writes a rollout per session under
    `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`; the dashboard reads the
    newest `token_count` event for cumulative tokens per model and the account
    `rate_limits` (a **5-hour** `primary` window and a **weekly** `secondary`
    window, each with a real used-percentage and reset time).

Each CLI is read from the source that suits it, and every view carries
`available`, `source`, `note` and `capabilities`. A figure a CLI does not report
is a dash, not a zero. Codex cost is always a dash. Only OpenCode reports usage
per agent step, so only its turns sum their steps.

The two views can split the same total differently. Grok's session file counts
cached input inside `inputTokens`, while the turn's own usage event reports it
separately, so one turn reads as 16,404 input in the CLI view and 14,740 input
plus 1,664 cache reads in the ledger. Both add up to 17,492.

Each view also carries `mix`, three slices that add up to its own `totalTokens`,
built where the CLI's counting rule is known: OpenCode counts cache beside
input, Grok and Codex count it inside. Reasoning is reported separately and is
named under the chart rather than drawn as a slice.

`opencode stats --days` takes whole days, so a sub-day window is served at one
day. That view carries `scopeDays` and the page says so, instead of a `5h` label
covering a day of data.

## What each CLI can and cannot report

- **Grok** — caches its model catalog at `~/.grok/models_cache.json`
  (`context_window`, `context_windows`, `max_completion_tokens`); the plugin reads
  it and also hands the context window to DSH. For usage it persists real
  per-session token and cost accounting — but it exposes **no subscription
  quota** (the weekly premium limit shown on grok.com is fetched only behind a
  private auth RPC), so the Grok weekly gauge uses `plan.grok.weeklyPremium` (or a
  `~/.grok/subscription.json` snapshot, if one exists).
- **Codex** — records its own usage **and its real subscription limits**: the
  dashboard shows the 5-hour and weekly used-percentages and reset times straight
  from the rollout files, plus the context window from the same turn. Codex has
  no `models` listing command, so the route reads its own catalog.
- **OpenCode** — prints model ids only; those rows say so and use the harness
  default window. The `opencode/*-free` ids need no account; `magpie/*` ids need
  an authenticated OpenCode account.

## Development

```bash
npm test        # runs every test/*.test.mjs in its own process
```

The suite has **no dependencies and makes no network calls**: it drives stub CLIs
(`test/stubs/stub-cli.mjs`) that emit the exact JSON shapes the CLIs emit, and it
builds synthetic Codex rollouts for the usage reader.

| Suite | Covers |
| --- | --- |
| `test/adapter.test.mjs` | route registration, the Codex catalog reader, a `codex exec --json` turn |
| `test/ledger.test.mjs` | a successful and a failed turn, and the usage ledger |
| `test/signin.test.mjs` | device-code parsing, `SignInManager`, the auto sign-in error |
| `test/usage.test.mjs` | Codex rollout reading (tokens, models, days, 5h/weekly limits) and windowing |
| `test/client.test.mjs` | the browser half rendered against a real payload, and the update button's gate and both outcomes |
| `test/failures.test.mjs` | CLI error events, timeouts, plain-text answers, a bad `cwd`, block indices |
| `test/views.test.mjs` | per-CLI usage rules (step summing, single totals), capabilities, dashes |
| `test/dashboard.test.mjs` | dashboard authorization (loopback, token, cookie), the page refresh, and the recent-turn cells |
| `test/update.test.mjs` | version compare, install detection, a real local git pull, a stub npm |
| `test/contract.test.mjs` | the manifest and both halves' public exports |
| `test/model-limits.test.mjs` | native OpenCode limits, context caps and configured precedence |
| `test/execution.test.mjs` | session workspaces, sandbox arguments, instructions and incremental streaming |
| `test/capabilities.test.mjs` | harness tool relay, image bytes/cleanup and Grok ACP |

Every test mount passes its own scratch ledger path; most use
`test/_harness.mjs`. A test run therefore never writes into the ledger of a
profile that is running the plugin.

`node test/_audit.mjs probes`, `suites` and `mutations` run the extended audit
checks. `snapshot` reads host usage without running inference. `real-capabilities`
executes real vision/tool turns and a Codex workspace-write probe in scratch
directories. `real` reads host usage and runs one real turn per CLI; `real-sanity`
cross-checks the source files and runs a raw Codex turn; `clone` downloads and
tests `origin/main`. Those modes intentionally use host data or the network.
Logs are written under the system temporary directory in
`dsh-llm-cli-audit-20261017` (override with `AUDIT_DIR`). Run `snapshot` or `real` before
`probes` to provide its dashboard snapshot. All audit mounts isolate their ledger
and assert the live ledger remains absent. They refuse to run if it exists.

`hardening` tests a real denied-read Windows ACL and scheduled checks against a
loopback source. `runtime` loads the published Cordis/DSH LLM services from an
isolated install selected by `DSH_RUNTIME_DIR` and executes all three routes.
`node test/_descendants.mjs` probes child cleanup on the current OS.
`setup-real` installs all three CLIs in temporary directories and checks their
versions/authentication. `signin-real` uses a separate temporary home to request
real device instructions and cancels the pending attempts; it never claims
human approval. Both require network access and are optional audit modes.
`node test/_browser.mjs` creates an optional real React DOM browser fixture in
`AUDIT_DIR`, downloading pinned React UMD scripts into that temporary HTML;
its HTTP responses are fixtures. These optional probes do not add dependencies
to the plugin or run during `npm test`.

CI runs the syntax check and the suite on Node 20, 22 and 24
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## License

[MIT](LICENSE)
