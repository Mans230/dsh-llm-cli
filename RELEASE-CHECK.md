# Pre-push verification, 2026-10-17

The user requested real CLI testing followed by a push to main, then supplied
the three-step verification checklist below. This report records pre-push
evidence; matching-commit CI and a fresh origin/main clone are checked after
the upload. Earlier local-only findings are preserved in AUDIT-REPORT.md.

## 1. DSH integration and CLIs

- Test: `node test/_audit.mjs runtime` loads published Cordis4.0.5 and
  @deepseek-ai/dsh-llm0.0.1-rc.1 from an isolated temporary install selected
  by `DSH_RUNTIME_DIR`. Actual service model listing, resolution, stream calls
  and disposal were executed. OpenCode beam-free, Grok4.7 and Codex6.1-sol
  returned RUNTIME_OK. Routes were unavailable after disposal.
- Check: OpenCode's separate deepseek-v4.1-flash-free turn still refused with
  HTTP429. Its successful inference remains unverified; beam-free succeeded.
  `real-capabilities` confirmed Codex/Grok images and tool request/result
  round trips. Codex workspace-write arguments still resulted in a read-only
  refusal and no file. Full DSH Web application sessions and its permission
  approval loop are not established by this service-level integration probe.

Confirmed defect: Codex streaming input included cache hits even though the
published DSH TokenUsage contract requires disjoint input/cache counters.
The existing tests had encoded the wrong expectation. After correcting the
expectation, adapter.test failed with expected input500 and actual1000.
The stream parser now subtracts cached input, retaining the native rollout
reader accounting. adapter.test and views.test guard the mapping; a scratch
  mutation reverting the subtraction is detected (32/32 mutations detected).
  A real DSH service turn reported input1924,cache12544,output7,total14475,
  and the probe asserts that the disjoint counters sum to that total.
  This is a boundary conversion,
not a merger of per-CLI data sources. Raw Codex output was also captured by
`real-sanity`, which independently cross-checks CLI-owned source sums.

## 2. Browser, authentication and updates

- Test: the optional `node test/_browser.mjs` downloads pinned React18.3.1 UMD
  files into temporary HTML. Headless rendering executed real React DOM for
  full/summary views and clicked Refresh,30d,Check for updates and the
  pause/resume checkbox. HTTP responses in this fixture are simulated.
  Result: all assertions passed; width390,scrollWidth390,six charts,
  summary without charts/tables. The saved browser.json contains the console
  results. Existing client/update/dashboard suites cover refusal messages,
  restartRequired, source selection, scroll restoration and refresh timing.
- Check: the collaborative browser snapshot timed out twice at15000ms;
  evaluation also timed out. Interaction against a complete live DSH Web
  deployment remains unverified. Human device-auth approval was not completed;
  parser,start,status,cancel,expiry and disposal are tested with process fixtures.
- Test/check: `node test/_audit.mjs hardening` exercised the actual scheduled
  check against an isolated loopback HTTP source. Requests were observed at
  5053ms and60043ms, followed by disposal. No installation was updated by this
  schedule probe. Actual isolated git update and stub npm fallback execution
  remain covered by update.test; a long-running automatic installation cycle
  was not exercised.

## 3. Robustness and release readiness

- Test: `node test/_descendants.mjs` spawned a real descendant and confirmed
  its termination after a timeout on Windows. This does not establish all
  possible detached daemon behavior or POSIX process-tree cleanup. WSL was
  unavailable here; the probe is optional, not a claim of cross-platform proof.
- Test: hardening used icacls to deny read access to a scratch usage.json,
  confirmed EACCES/EPERM, checked the reader survived, and removed the deny ACE.
  No live CLI file's ACL was changed.
- Test: the complete suite passes13/13; the cache variants and Git master
  default also pass. The scratch mutation runner now includes the Codex
  boundary conversion in addition to the previous31 mutations. Concurrent
  ledger writer,lock,HTTP,escaping,timeout and update probes are in _audit.mjs.
- Check: npm pack --dry-run contains the same seven intended package files;
  audit plans, reports, downloaded React and optional test helpers are excluded.
  No public interface was removed based on textual reachability. Reference
  counts are in the earlier source-scan evidence; exhaustive unused-prop
  analysis remains unverified.

Commands use `AUDIT_DIR=%TEMP%/dsh-prepush-20261017`. Logs include real-console,
capabilities-console,runtime-final,sanity-final,hardening-console,browser.json,
suites-final and mutations-console. Optional runtime needs an isolated install
at `DSH_RUNTIME_DIR`; the initial invocation without that variable correctly
refused and was rerun with it set. Browser fixture timing was corrected using
a DOM MutationObserver after the initial premature check failed.

All mounts use isolated usageFile paths. The live
`%USERPROFILE%/.dsh/llm-cli-usage.json` remained absent. OpenCode stats, Codex
rollouts and Grok usage.json remain independent. Successful unit tests are
not represented as successful human authentication or complete Web integration.
