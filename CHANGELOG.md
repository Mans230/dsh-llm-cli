# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
