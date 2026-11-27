# dsh-llm-cli

**Use OpenCode, Grok Build, and OpenAI Codex as model routes in DeepSeek Harness.**
The plugin runs each CLI on the Harness host, streams replies into your session,
and adds a dashboard for token usage, reported costs, and available quotas.

[![CI](https://github.com/Mans230/dsh-llm-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Mans230/dsh-llm-cli/actions/workflows/ci.yml)
[![Node.js 20.11+](https://img.shields.io/badge/Node.js-20.11%2B-brightgreen)](package.json)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Quick start](#quick-start) · [Model routes](#model-routes) · [Usage dashboard](#usage-dashboard) · [Configuration](#configuration) · [Access and updates](#access-and-updates) · [Troubleshooting](#troubleshooting) · [Development](#development)

## Quick start

You need an existing [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
profile and **Node.js 20.11 or later**. Use a Web-enabled profile to get the
embedded dashboard. CLI binaries and credentials belong to the account running
Harness, so if Harness runs in a VM, set up the CLIs there.

1. From the Harness profile directory (for example, `~/.dsh/profiles/<name>`),
   install the bundle as an npm dependency. This Git URL requires Git on the host.

   ```sh
   npm install "git+https://github.com/Mans230/dsh-llm-cli.git"
   ```

2. Add `dsh-llm-cli` to `dsh.profile.bundles` in the profile's `package.json`.
   Keep the profile's existing bundles. A typical Web profile includes:

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-llm-cli"]
       }
     }
   }
   ```

3. Restart the Harness profile. Pick an OpenCode, Grok, or Codex model in the
   model picker. Open **Settings → LLM usage** to see the dashboard, or find the
   same panel under **Plugins → Grok + Codex + OpenCode (CLI)**.

By default, the first turn or sign-in request can install a missing default
CLI. For explicit setup, open **Host management** from a browser on the Harness
host. It can install a CLI, start device sign-in, check status, or cancel a
pending sign-in. Existing CLI logins are reused. The plugin provides
`provider_signin` and `provider_signin_status` tools for authorized Harness
calls, too.

See [Mounting this plugin](MOUNT-EXAMPLE.md) for linking a local checkout or
loading the host entry directly. Direct loading provides the model routes and
standalone dashboard; the bundle manifest is required for the embedded panel.

## Model routes

| Route | CLI | How a turn runs |
| --- | --- | --- |
| `opencode` | OpenCode CLI | Runs `opencode run` with JSON output. Free OpenCode models can run without an account; other models use their configured credentials. |
| `grok` | Grok Build CLI | Uses streaming JSON for text turns and ACP for image input. Sign in with `grok login --device-auth`. |
| `codex` | OpenAI Codex CLI | Uses `codex app-server` over stdio by default. Sign in with `codex login --device-auth`. |

The selected CLI handles authentication, inference, and its own agent loop.
Harness supplies the session workspace and, by default, its system and developer
instructions. The plugin forwards text deltas as they arrive. Harness tools can
be requested through a model-dependent JSON relay: Harness applies its usual
permissions and returns the correlated results on the next turn. The relay
doesn't forward MCP connections directly.

- **Model controls:** Where supported, the model picker exposes reasoning
  options and Codex Standard/Fast speed. **Default** preserves the CLI's
  settings. Keep model IDs exactly as the CLI accepts them.
- **Context limits:** The dashboard distinguishes the provider's published
  context from the effective Harness context. Explicit per-model configuration
  takes precedence over discovered limits.
- **Image input:** With a vision-capable model, attach PNG, JPEG, WebP, or GIF
  files up to 20 MiB each. OpenCode accepts one image per request; Grok and Codex
  accept up to eight. The plugin removes its temporary attachment files after the
  turn.
- **Codex sandbox:** Defaults to `read-only`. A profile may request
  `workspace-write`; Codex's host policy still applies.

## Usage dashboard

Open **LLM usage** inside Harness or visit `/llm-cli/usage` on the same server
for the standalone view. `/llm-cli/usage.json` supplies the underlying data.

- Filter by CLI, then search or drill down into individual models.
- Select **5h, 7h, 24h, 7d, 30d, 90d, or All time**. Short-range charts use
  hourly buckets when the source supports them; longer ranges use daily UTC
  buckets. **Limits & budgets** retains each quota or billing period.
- Inspect token mix, activity, reported costs, model limits, and the latest
  retained Harness turns. **Refresh** rereads the CLI sources instead of using
  cached usage.

### What the numbers mean

**This Harness** shows the turns recorded in the plugin's usage ledger. The
ledger stores usage and turn metadata without prompt or reply text.
**CLI-recorded** shows each CLI's own accounting on that host, which may include
the same turns plus sessions started elsewhere. The two views can overlap, so
don't add them together.

| CLI | Usage source | Coverage and limits |
| --- | --- | --- |
| OpenCode | Cached `opencode stats --json --all --models --cost` | Reports model totals and daily activity. Short ranges use whole-day data and label that scope. Exact hourly or per-model token history isn't available. |
| Grok | Session `usage.json` files under `~/.grok/sessions` | Reports tokens and cost by session and model. Date attribution follows session activity. A weekly premium gauge uses a configured value or an available local snapshot. |
| Codex | `token_count` events under `~/.codex/sessions` | Attributes token deltas to the model active at each event. Rollouts missing timestamps are labeled as session approximations. Quota is read from the signed-in CLI, with recorded snapshots as a fallback. Cost isn't reported. |

A dash means the source didn't report a value. Optional budgets are
operator-defined targets. Codex's reported 5-hour and weekly quota windows
are separate from the dashboard's usage filters.

## Configuration

The bundle has defaults. Override them in the profile's `cordis.patch.yml`
using the `llm-cli` entry. Omitting a route preserves its default configuration.
Use `false` to disable it or `models` to pin the picker to a known list.

```yaml
- id: llm-cli
  name: dsh-llm-cli
  config:
    autoInstall: true
    timeoutMs: 180000
    providers:
      opencode:
        models:
          - opencode/deepseek-v4.1-flash-free
      grok: false
      codex:
        sandbox: read-only
    plan:
      opencode:
        monthlyBudgetTokens: 100000000
        resetDay: 1
```

Substitute an OpenCode model ID from your own CLI catalog if the example isn't
available to you.

| Setting | What it controls |
| --- | --- |
| `cwd`, `providers.<id>.cwd` | Fallback workspace for calls without a Harness session. Session turns use the session's directory. |
| `providers.<id>.{bin,defaultModel,displayName,contextWindow}` | Overrides for the CLI command, default model, route label, and context limit. |
| `providers.<id>.models` | Model IDs or objects with `id`, `name`, `contextWindow`, and `maxOutputTokens`. Optional fields may be omitted. |
| `providers.opencode.{contextWindowCap,preserveFreeContext}` | OpenCode's default cap is 500,000 tokens. Published smaller limits are retained, and qualifying `*-free` models with at least one million tokens keep their native context by default. |
| `timeoutMs`, `autoInstall`, `cliInstallDir`, `installTimeoutMs` | Per-turn timeout and CLI installer settings. Managed binaries default to `~/.dsh/clis`. |
| `includeSystemPrompt`, `toolBridge` | Set either to `false` to stop forwarding instructions or disable the JSON tool relay, respectively. |
| `usageFile`, `grokUsageDir`, `codexUsageDir`, `opencodeStats.args` | Overrides for the ledger and CLI usage sources. The ledger defaults to `~/.dsh/llm-cli-usage.json`. |
| `codexModelsCache`, `providers.codex.appServer`, `providers.codex.liveQuota` | Override the Codex model catalog path, use legacy `exec --json`, or disable live quota reads. |
| `plan.<route>` | Optional budget gauges using `monthlyBudgetUsd`, `monthlyBudgetTokens`, and `resetDay` (1–28). `plan.grok.weeklyPremium` can supply a manual quota snapshot. |
| `dashboardToken` | Legacy dashboard access when the host doesn't provide owner-session authentication. Use a token of at least 16 characters. |
| `autoUpdate`, `updateIntervalMs`, `updateSource`, `updateInstall` | Optional scheduled version checks or updates. Scheduling is off by default. |

## Access and updates

An authenticated **Harness owner** can open the dashboard and use **Check for
updates** remotely. The remote version check returns version information without
the host's install path or action token. Direct loopback access is also
supported; forwarded requests count as remote. Older hosts can use a configured
dashboard token for usage reads. On HTTPS, enter it in the embedded **LLM usage**
panel to keep it out of the URL.

CLI setup and **Update now** require direct access from the host and a host
action token. A version check compares the installed package version with the
configured update source, which defaults to this repository's `main`. Commits
that keep the same version won't trigger an update notification. To pick up
those commits in a Git-backed npm install, install the Git dependency at the
desired commit from the profile directory. **Restart the profile** after
updating so it loads the new package.

| Endpoint | Purpose |
| --- | --- |
| `GET /llm-cli/usage` and `GET /llm-cli/usage.json` | Read the dashboard or its JSON data. Use `?days=7` or `?hours=5` to select a trailing window, and `force=1` to refresh the sources. |
| `GET /llm-cli/update.json` | Read the version check. Use `?force=1` to refresh it. |
| `GET /llm-cli/setup.json` | Read CLI setup status directly from the host. |
| `POST /llm-cli/setup` and `POST /llm-cli/update` | Run a host-only setup action or apply a plugin update. |

### Behind nginx

For each Harness profile served by nginx, configure Harness's `--public-url`
with the HTTPS URL users open and `--trusted-host` with that URL's hostname
(include a non-default port if used). Proxy the Harness UI, WebSocket upgrades,
and `/llm-cli/` requests to the same profile. Preserve the original `Host`,
the `X-Forwarded-*` headers, and the browser's cookies. Use the same origin
for the Harness UI and dashboard.

1. Sign in as the Harness owner at the proxied URL.
2. Open **Settings → LLM usage** or `/llm-cli/usage` on that same origin.
   When Harness passes the owner session to the plugin, no separate dashboard
   token is needed in any profile. Normal Harness sign-in still applies.

This was verified with Harness `0.2.3-alpha.2` and two separate profiles
behind nginx. Harness `0.2.1-rc.5` doesn't pass the owner session to plugin
routes. On that version, updating only the plugin still leaves the dashboard
returning `403` through nginx. Upgrade Harness as well, or configure
`dashboardToken` in each affected profile as a fallback.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Routes are present, but the embedded panel is missing | Confirm the plugin is installed and listed as a bundle in a Web-enabled profile. Restart the profile. A direct file mount only exposes the standalone dashboard. |
| A CLI is missing or signed out | Run the CLI under the Harness process account or check **Host management** on the host. Complete any device sign-in and verify the status there. On Windows, an explicit `bin` can point to the CLI's actual executable if its shim can't be resolved. |
| A model doesn't appear or is rejected | Check the exact ID and available models in the installed CLI. A profile's pinned `models` list overrides discovery. |
| Remote usage or the version check returns `401` or `403` | Sign in as the Harness owner and confirm the plugin build supports remote version checks. Older hosts may need a dashboard token for usage reads. Remote setup and installation are expected to be refused. |
| The dashboard behind nginx says it needs a `dashboardToken` | See [Behind nginx](#behind-nginx). Check both the Harness and plugin versions; an older Harness can require the token even when the owner is signed in. |
| A chart is empty or a number looks different from the CLI | Compare the same source, model, and date range. Check the displayed scope and whether that CLI reports the metric. Refresh if you just ran a turn. |

Report reproducible problems in [GitHub Issues](https://github.com/Mans230/dsh-llm-cli/issues).
Include the Harness, plugin, Node.js, and CLI versions, whether you're using Web
or desktop, the steps to reproduce, and a sanitized profile or log excerpt.

## Development

```sh
npm ci --legacy-peer-deps
npm run build
npm test
npm run test:ui
```

Harness supplies the runtime peer packages. The dashboard is built with React,
Base UI, coss ui, Tailwind CSS, and Recharts. `npm run build` regenerates
`client.js` and `dist/`; packaging also runs the build. Running Harness loads the
generated assets directly.

| Path | Responsibility |
| --- | --- |
| [`index.js`](index.js) | Harness adapter, CLI execution and setup, usage aggregation, HTTP routes. |
| [`src/dashboard.tsx`](src/dashboard.tsx), [`src/usage-data.js`](src/usage-data.js) | Shared dashboard and data presentation. |
| [`src/host-client.js`](src/host-client.js), [`src/standalone.tsx`](src/standalone.tsx) | Harness panel and standalone entry points. |
| [`scripts/build.mjs`](scripts/build.mjs) | Builds the hosted bundle against Harness's React runtime and packages a separate React runtime for standalone. |
| [`test/`](test/) | Offline CLI fixtures, usage and route tests, and browser coverage for standalone and React 18/19 hosts. |

The browser suite uses installed Chrome by default. CI installs Playwright
Chromium and sets `DSH_BROWSER_CHANNEL=chromium`. See the
[CI workflow](.github/workflows/ci.yml), [release checklist](RELEASE-CHECK.md),
and [changelog](CHANGELOG.md).

## License

[MIT](LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
