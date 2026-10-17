# Three-step repair plan

The implementation below was initially verified locally. The user subsequently
requested CLI verification and a push to main; see RELEASE-CHECK.md for that
release check and the remaining gaps.

## 1. Model limits and source freshness

- [x] Read native OpenCode context/output metadata. Cap context at 500,000;
  preserve smaller native limits and million-token free models.
- [x] Make Codex snapshot age explicit and allow forced source rereads.
- [x] Check whether Grok is actually installed and discover its models.
- [x] Test: model-limit precedence/caps, quota-only records, stale timestamps,
  adapter TTL and forced rereads including unchanged file metadata.
- [x] Check: execute installed CLI catalog commands and compare native limits.

## 2. Turn execution

- [x] Resolve the session workspace; reject an unavailable session workspace.
- [x] Make the Codex sandbox configurable and forward system instructions by default.
- [x] Verify deltas arrive before child exit.
- [x] Test: parallel workspace writes, argument builders, instruction opt-out,
  streaming before exit, cancellation and bounded timeouts.
- [x] Check: execute the installed Codex write probe in a scratch workspace.
  It refused twice with a read-only policy despite workspace-write arguments;
  successful live Codex editing remains unverified.

## 3. Tools, images and integration

- [x] Relay offered DSH tools and correlated results; validate requested tools.
- [x] Transport real image bytes and remove temporary files on success/failure.
- [x] Test: tool frames/results, malformed requests, attachment bytes/cleanup,
  Grok ACP completion, all suites/cache variants and scratch-copy mutations.
- [x] Check: real Codex/Grok vision and tool round trips, published DSH service
  mount/stream/disposal, dashboard rendering and package contents.
  OpenCode inference refused with HTTP 429. Collaborative browser snapshots
  timed out twice; headless HTML rendering passed at 390px.

See the linked evidence in the completion report for executed results and limits.
