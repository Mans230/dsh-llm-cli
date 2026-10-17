# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
