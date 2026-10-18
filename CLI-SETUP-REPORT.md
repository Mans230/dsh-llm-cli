# CLI installation and sign-in verification

Local implementation after main commit48a8b57. No new commit or push was made
for this feature during this verification.

- Current host: all three installed CLIs report signed in. Existing accounts
  were reused; no logout, credential copying or account replacement occurred.
- Real isolated installs succeeded: Codex0.163.0 via @openai/codex,
  OpenCode2.0.32 via @opencode/cli, Grok1.0.62 via the official x.ai installer.
  Each binary passed --version and read its own CLI authentication store.
- Separate temporary profiles started signed out. Real device flows returned
  URL plus code from auth.openai.com,accounts.x.ai and opencode.ai respectively.
  Those attempts were cancelled without browser approval. This proves device
  initiation, not successful approval on a new account or a separately deployed VM.
- Installer concurrency, immediate use, failures, version-check rollback,
  unknown providers, prototype keys, action tokens, host-only access and POST
  enforcement are covered by setup.test. The Web controls and pending code
  display are covered by client.test and a real React DOM fixture with fake HTTP.
- signin.test first reproduced and then guarded: empty successful OpenCode
  auth output, longer ANSI-colored Codex codes, delayed code writes, and a failed
  login that had already printed a URL. Login failures remain visible during
  subsequent status checks; pending processes are cancelled on expiry/disposal.
- The optional real React DOM fixture at390px rendered six charts without
  horizontal overflow and executed the Install CLI request along with existing
  refresh/window/update/pause controls. It is not a complete DSH Web deployment.

Automatic install occurs on first model use or sign-in, only for enabled routes
on the machine running this plugin. Managed installs live under ~/.dsh/clis by
default, with no global npm installation. Grok's official script may also manage
its own profile downloads and PATH entry. A VM must actually run the plugin to
receive its installation; remote VM orchestration is not implemented.

The UI at CLI setup and sign-in offers install,sign-in,status,cancel. Account
approval remains a human browser step. Host-only setup HTTP routes require an
action token. Authorized provider_signin tool calls also work from DSH chat.
Read-only remote dashboards receive no setup action token or device instructions.
Set autoInstall:false to disable installation on first use; explicit Install CLI
remains available. Missing operator-configured binaries are not silently replaced.

Evidence is in %TEMP%/dsh-cli-setup-20261017: setup-real-console.log,
signin-real-final.log,probes-console.log,suites-console.log,mutations-final.log.
Final results:14/14 suites for empty-cache,host-cache,master-default;
36/36 scratch mutations detected. The live ledger remains absent.
Commands executed include npm test; node test/setup.test.mjs; client.test.mjs;
signin.test.mjs; node test/_audit.mjs setup-real,signin-real,snapshot,probes,suites,
mutations; node test/_browser.mjs; node --check index.js/client.js; git diff --check;
npm pack --dry-run --json. All mounts use isolated usageFile paths; the live
%USERPROFILE%/.dsh/llm-cli-usage.json remains absent. CLI data sources stay separate.

Official references consulted:

- [Codex authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
- [OpenCode source and distribution](https://github.com/anomalyco/opencode)
- [Grok setup](https://docs.x.ai/build/overview),
  [Windows installer](https://x.ai/cli/install.ps1),
  [POSIX installer](https://x.ai/cli/install.sh)
