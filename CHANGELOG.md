# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A CLI that emits partial text and then exits unsuccessfully or reports an
  error now fails the turn and records the reason, instead of recording success.
- Already-aborted requests do not launch a CLI; running cancellations record
  their own failed turn. Invalid or zero timeouts fall back to a positive bound.
- Completed device sign-ins release their pending entry without polling.
  Sign-ins can be cancelled explicitly and are closed when the plugin disposes.
- OpenCode stats refusals and JSON without token counters report unavailable
  usage with a reason instead of available usage containing fabricated zeroes.
- Plugin logs no longer include deployment paths or raw CLI/update diagnostics.

### Tests

- Pin the update exports and additional manifest fields in the contract suite;
  exercise both client slot registrations, disposal and the summary view.
- Isolate the client suite from installed CLIs using local process fixtures.
- Add `test/_audit.mjs` for cache variants, scratch-copy mutation checks,
  concurrent ledger writers, HTTP, readers, real-host and fresh-clone probes.
  Its `real`, `real-sanity` and `clone` modes intentionally access host data or
  the network; ordinary `npm test` does not invoke them.

## [0.7.1]

### Removed

- **Fields the dashboard payload produced that nothing read:** `recentSessions`,
  `contextWindows`, `signInText`, `signInNote`, `subagents` and `streak`. Each
  was written into `/llm-cli/usage.json` and into the view the Web client
  renders, and neither half (nor any test) ever read one. `signInText` also
  captured CLI output on every route facts refresh for a field nobody used.
- **The `codexModelsCache` passthrough** in the normalized config. The key is
  still read from your config when building the Codex model reader; the copy
  placed on the normalized object had no reader.
- **Two palette entries** in the browser half (`grok`, `opencode`) that no chart
  colour lookup referenced.
- A tautological `assert(true, …)` at the end of the ledger suite, which could
  never fail and proved nothing.

### Fixed

- **The update button was offered where it could not work.** A remote dashboard
  reader gets the version check with the action token blanked, and `canApply`
  stays true, so "Update now" rendered and then silently did nothing. The button
  now requires the token, exactly like the server-rendered page already did.
- **A refused update was recorded as a result.** The browser half parsed the
  response body without checking the status, so a 403 from the token check (or
  any 5xx) became a "last run" entry instead of an error. It now rejects on a
  non-2xx response and shows `HTTP <status>`.
- **A turn-counting table was labelled "Steps".** Grok and Codex report turns,
  not agent steps; only OpenCode reports steps. The Web client's combined table
  now says "Turns / steps", and the server-rendered tables name the unit per
  route.
- **A finished turn rendered as bare `ok`** while a failed one was red, though
  the stylesheet already had an `.ok` rule with no markup to match. Both
  outcomes are marked now.

### Tests

- The browser half's React stub now keeps per-hook state and returns working
  setters, so a click can be driven: the update button's visibility and both
  update outcomes (refused and applied) are asserted, and each assertion was
  verified to fail against the pre-fix code.
- The dashboard suite records a successful and a failed turn and asserts the
  marked, escaped result cells and the per-route unit header.
- `resolveModel`'s assertion checks the metadata it returns instead of only that
  the result is an object.

## [0.7.0]

### Added

- **A check-for-updates button, and one-click update.** The plugin's page in the
  Web client, and the server-rendered dashboard, now show the installed version,
  the newest published one, and how this copy was installed. The button runs the
  command that suits that install: `npm install <the spec your profile already
  declares>` for a dependency, or `git pull --ff-only` for a checkout or a
  junction to one.
- `GET /llm-cli/update.json` and `POST /llm-cli/update`, both of which answer
  this machine only. The POST needs an action token that the page carries, so a
  cross-site form cannot trigger it.
- `autoUpdate` (`false`, `'check'` or `'apply'`), `updateIntervalMs`,
  `updateSource` and `updateInstall`. The default makes no network calls, so the
  version check happens only when you ask for it.
- `currentVersion` is exported, and an `UpdateManager` built directly falls back
  to the default source instead of requiring one.
- `test/update.test.mjs` covers version comparison, install detection, a real
  local `git pull` through the update path, and the npm command shape.

### Fixed

- **The npm shim is resolved correctly.** npm's own `.cmd` assigns its node and
  its script to variables before running them, which the previous pattern read as
  the target. It now picks the script the shim actually runs, which is what makes
  an install that ships only a shim reachable at all.
- **A POSIX-shaped PATH entry no longer defeats command lookup.** A harness
  launched from git-bash or WSL interop hands Node `/c/...` entries, which no
  native probe can join. Those entries are translated first.
- **A GitHub install that git cannot fetch is retried as a tarball.** npm
  resolves `github:owner/repo` over SSH, which fails without a key even for a
  public repository, and npm 11 rewrites an explicit `git+https` URL to ssh as
  well. The update path now tries the declared spec, then the https git URL, then
  `https://github.com/owner/repo/tarball/HEAD`, which needs no git and no
  credentials. The README recommends the https form directly.

## [0.6.0]

### Fixed

- **The dashboard is no longer readable from another machine by default.** It
  carries cost, model names and sign-in state, so a request that does not come
  from this host now gets `403` unless it presents `dashboardToken` as a query
  token, an `x-llm-cli-token` header, or the cookie the page sets from a query
  token. The comparison is timing-safe, a token under 16 characters is treated
  as unconfigured, and the refusal never echoes payload.
- **A device-code sign-in that nobody approves is closed.** The CLI used to wait
  for a human indefinitely. The manager now closes the window after
  `signInTtlMs` (default 10 minutes) and kills the process.
- **The dashboard no longer jumps to the top every 20 seconds.** The meta
  refresh is gone. An inline script saves the scroll position before reloading
  and restores it after, and `?refresh=off`, or the on-page link, stops the
  reload entirely.

### Added

- `dashboardToken` and `signInTtlMs` in the plugin config.
- `test/dashboard.test.mjs` covers the authorization matrix and the refresh
  behaviour, and the sign-in suite covers the TTL.

## [0.5.0]

### Fixed

- **A sub-day window no longer overstates OpenCode's precision.**
  `opencode stats --days` takes whole days, so a `5h` window was served one day
  of data under a five-hour label. The view carries `scopeDays` and both pages
  say the figure covers a day.
- **The token mix adds up to the headline.** Slices are built where each CLI's
  counting rule is known, so cache reads are subtracted from input for Grok and
  Codex and kept beside it for OpenCode. Reasoning is reported separately under
  the chart instead of being drawn as a slice that inflated the sum.
- **A Grok per-model row has a total.** The session file gives no per-model
  total, so the table's Total column read zero for every model.
- **Two profiles can share one `usageFile`.** Writes take an exclusive lock,
  merge with what is already on disk, and replace the file in one step. A turn
  that cannot take the lock stays pending and retries on the next one instead
  of replacing the file with its own view.
- **A Windows CLI installed only as a `.cmd` shim launches.** The shim is read
  and its real target is spawned, rather than the shim being handed to a shell.
  A bare command name is now resolved on `PATH` with `PATHEXT`, so a global
  install that ships only a shim is reachable at all.

### Added

- `scopeDays` and `mix` on every CLI usage view, and a per-entry `id` in the
  ledger so merged writes can be deduplicated.
- `resolveWindowsShim()` is exported, and the test suite covers the shim path,
  the merge, the scope note and the mix arithmetic.

## [0.4.0]

Each CLI is still read from its own source. This release makes the shape of
those views the same, states what each one can report, and stops printing a
zero for a figure the CLI never produced.

### Added

- `capabilities` on every CLI usage view, with `cost`, `rateLimits`, `perStep`
  and a `costReason`. A caller can tell "free" from "not reported".
- `costTurns` in the ledger totals, so the dashboard knows whether a route has
  ever reported a cost.
- `test/views.test.mjs` pins the per-CLI measurement rules and the
  dash-not-zero rule for both halves.

### Changed

- A turn on a route that reports usage per agent step now sums the steps.
  OpenCode reports one `step_finish` per step, and the adapter kept only the
  last one, so a multi-step turn under-reported tokens and cost.
- Unavailable figures render as a dash in the server-rendered page as well as
  the React page. Codex cost is a dash everywhere, because that CLI reports no
  cost at all.
- A window note for a CLI that could not answer keeps that CLI's own reason
  instead of replacing it with a window count.

### Fixed

- The window note could read `last 7.0000183 days`, because it recomputed the
  window from `Date.now()` instead of using the requested one.

## [0.3.1]

### Fixed

- **The test suite no longer writes into the live ledger.** `test/adapter.test.mjs`
  and `test/signin.test.mjs` mounted the plugin without a `usageFile`, so they
  recorded stub turns into `~/.dsh/llm-cli-usage.json`. Every suite now mounts
  through `test/_harness.mjs`, which always owns a scratch ledger.
- **OpenCode and Grok error events are surfaced.** Both CLIs report provider
  failures (quota, auth, model access) as an `error` event on stdout, and both
  used to drop it, so a rate limit read as `produced no reply`. It now reads as
  `Rate limit exceeded. Please try again later. (HTTP 429)`.
- **A timeout is a failure, not a short answer.** A CLI killed by
  `timeoutMs` used to hand back whatever it had streamed as a finished turn and
  ledger it as successful. It now fails with `timed out after N ms`.
- **Lifetime totals survive ledger retention.** Turn and cost totals are kept
  beside the capped turn list instead of derived from it, so the dashboard no
  longer plateaus at the retention limit (1000 turns). The ledger file moves to
  version 2; version 1 files are read and migrated on load.
- **Reasoning that arrives after text no longer collides with it.** Block
  indices are allocated on first use, so each block starts and ends once, and
  the reasoning block ends with the text it streamed.
- **Plain-text CLI answers are recovered.** An answer printed as text instead
  of JSON was dropped; it is now read from stdout, or from stderr when stdout
  is empty. Structured output with no text is still reported as no reply.
- **A missing `cwd` names the cwd.** The turn used to fail with a spawn ENOENT
  that pointed at the CLI binary.
- **Codex rollout parsing is cached by size and mtime.** A warm scan of 500
  rollouts drops from ~1.6 s to ~0.11 s, so a dashboard refresh no longer walks
  the account's whole history.
- The standalone usage page names Codex in its subtitle.

### Added

- `test/failures.test.mjs` covers every failure path above, and the ledger and
  rollout-cache tests cover retention and invalidation.

## [0.3.0]

### Added

- **Codex route** (`codex`) backed by the OpenAI Codex CLI
  (`codex exec --json`), including a device-code sign-in flow
  (`codex login --device-auth`).
- **Real Codex subscription limits**: the dashboard reads the 5-hour (`primary`)
  and weekly (`secondary`) rate-limit windows — used percentage and reset time —
  from Codex's own session rollouts, plus its published context window.
- Codex model discovery from the CLI's own catalog
  (`~/.codex/models_cache.json`).
- **5-hour** option in the usage window selector (alongside 7d/30d/90d/all),
  with fractional-day window support end to end.
- `plan.grok.weeklyPremium` — configure the grok.com "Weekly Premium Limit"
  (used percent + reset time) since the Grok CLI exposes no quota. A
  `~/.grok/subscription.json` snapshot is honoured if one exists.
- Best-effort Codex error surfacing: an error event from `codex exec --json`
  is reported instead of an empty reply.
- Test suite (`npm test`) with stub CLIs and a GitHub Actions workflow.

### Changed

- Grok/OpenCode window helpers unified behind `windowCliUsage()`.
- `profilePath()` also falls back to `$HOME`, so the plugin loads on non-Windows
  hosts.

## [0.2.0]

### Added

- Charted usage dashboard rendered in **two** Web-client slots: the Plugins
  panel (`plugins.item`) and a Settings section (`settings.section`).
- Hand-rolled SVG charts: daily tokens, cost by model, token mix, activity
  heatmap, per-model tables, and budget gauges.
- Trailing-window selector (7d/30d/90d/all) applied on both the client and the
  host, including re-scoping `opencode stats`.
- Server-rendered dashboard at `/llm-cli/usage` and `/llm-cli/usage.json`.

## [0.1.0]

### Added

- Initial release: `opencode` and `grok` model routes served by the OpenCode and
  Grok Build CLIs, `provider_signin` / `provider_signin_status` tools, the usage
  ledger, CLI-recorded usage readers, and per-model limits.
