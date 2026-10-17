# Mounting this plugin

Two ways to use it in a profile, both from the profile directory
(`<profile-dir>`, e.g. `~/.dsh/profiles/<name>`).

## 1. As a bundle (recommended — gives you the Plugins-panel page)

`package.json`:

```json
{
  "dependencies": { "dsh-llm-cli": "github:Mans230/dsh-llm-cli" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-llm-cli"]
    }
  }
}
```

For a local checkout, depend on the folder and link it where Node looks:

```powershell
$w = '<profile-dir>'
New-Item -ItemType Junction -Path "$w\node_modules\dsh-llm-cli" `
  -Target '<path-to-checkout>'
```

Restart the profile. It appears in **Plugins** under *Installed*
(`dsh-llm-cli`) with its own page.

## 2. As a plain file insert (host routes + `/llm-cli/usage` only, no panel page)

The browser half is discovered only from a package manifest (`dsh.client` +
`exports["./client"]`), so a bare file insert gives you the routes, the sign-in
tools and the dashboard, but not the panel card. In the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: llm-cli
      name: '<path-to-checkout>/index.js'
      config:
        cwd: '<agent-workspace>'
        usageFile: '<profile-dir>/llm-cli-usage.json'
        providers:
          opencode:
            models:
              - opencode/deepseek-v4.1-flash-free
          codex: {}
          grok: {}
```

Point `usageFile` somewhere of your own so a test profile cannot mix its turns
into the live ledger.

## Config reminder

`cwd` is where the CLI agent runs; `usageFile` is the ledger (counts only, never
prompt or reply text); `providers.<id>` may be `false` to drop a route, or set
`models`, `bin`, `defaultModel`, `displayName`, `contextWindow`. A profile patch
replacing this entry's config must restate every field it wants to keep.

## Tests

```bash
npm test
```

The suite is dependency-free and offline: it drives stub CLIs and synthetic
Codex rollouts, so it never needs a signed-in CLI or a network.
