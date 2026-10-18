/**
 * Usage test: the Codex rollout reader (tokens, per-model, per-day, the real
 * 5-hour/weekly rate limits) and the trailing-window projection.
 * All fixtures are synthetic; no CLI is involved.
 */
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodexCliUsage, readCodexModelList, windowCliUsage } from '../index.js'
import { assert, assertEqual } from './_assert.mjs'
import { mount } from './_harness.mjs'

const root = join(tmpdir(), `dsh-llm-cli-usage-${process.pid}`)
rmSync(root, { recursive: true, force: true })

const day = (dirName) => join(root, 'sessions', ...dirName.split('-'))
const line = (value) => JSON.stringify(value)

function writeRollout(dir, { id, model, at, input, cached, output, reasoning, contextWindow, rateLimits }) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `rollout-${id}.jsonl`),
    [
      line({ timestamp: at, type: 'session_meta', payload: { id, cwd: '/tmp', model } }),
      line({ timestamp: at, type: 'turn_context', payload: { model } }),
      line({
        timestamp: at,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              reasoning_output_tokens: reasoning,
              total_tokens: input + output,
            },
            last_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              reasoning_output_tokens: reasoning,
              total_tokens: input + output,
            },
            model_context_window: contextWindow,
          },
          rate_limits: rateLimits,
        },
      }),
    ].join('\n') + '\n',
    'utf8',
  )
}

// Keep the scenario aligned with its literal UTC day buckets. The host clock
// crossed UTC midnight during a pre-push run and moved the relative fixtures.
const now = Date.parse('2026-10-17T12:00:00Z')
const iso = (msAgo) => new Date(now - msAgo).toISOString()

// Newest session (and the one whose rate limits should win): absolute resets_at.
writeRollout(day('2026-10-17'), {
  id: '22222222-2222-2222-2222-222222222222',
  model: 'gpt-5',
  at: iso(3600000),
  input: 5000,
  cached: 4000,
  output: 500,
  reasoning: 40,
  contextWindow: 475000,
  rateLimits: {
    primary: { used_percent: 18, window_minutes: 300, resets_at: 1792252352 },
    secondary: { used_percent: 4, window_minutes: 10080, resets_at: 1792699047 },
  },
})

// Older session: relative resets_in_seconds, a different model.
const olderAt = now - 2 * 86400000
writeRollout(day('2026-10-15'), {
  id: '11111111-1111-1111-1111-111111111111',
  model: 'gpt-5-codex',
  at: new Date(olderAt).toISOString(),
  input: 12000,
  cached: 9000,
  output: 800,
  reasoning: 120,
  contextWindow: 400000,
  rateLimits: {
    primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 3600 },
    secondary: { used_percent: 2, window_minutes: 10080, resets_in_seconds: 300000 },
  },
})

const full = readCodexCliUsage(join(root, 'sessions'))
assertEqual(full.available, true, 'rollouts make usage available')
assertEqual(full.sessionCount, 2, 'both sessions are read')
assertEqual(full.turns, 2, 'each session counts as a turn')
assertEqual(full.inputTokens, 17000, 'input tokens are summed')
assertEqual(full.cacheReadTokens, 13000, 'cached input is summed')
assertEqual(full.outputTokens, 1300, 'output tokens are summed')
assertEqual(full.totalTokens, 18300, 'total tokens are summed')
assertEqual(full.reasoningTokens, 160, 'reasoning tokens are summed')
assertEqual(
  full.models.map((model) => `${model.id}:${model.totalTokens}`),
  ['gpt-5-codex:12800', 'gpt-5:5500'],
  'per-model totals are sorted by tokens',
)
assertEqual(full.daily.map((entry) => entry.date), ['2026-10-15', '2026-10-17'], 'daily rows are ordered')
assertEqual(full.contextWindow, 475000, 'the context window comes from the newest turn')
assertEqual(full.limits.primary, { usedPercent: 18, windowMinutes: 300, resetsAt: 1792252352000 }, 'the 5-hour limit uses absolute resets_at')
assertEqual(full.limits.secondary, { usedPercent: 4, windowMinutes: 10080, resetsAt: 1792699047000 }, 'the weekly limit is read')

// Only the older session: a relative reset must be resolved against its turn.
const olderOnly = readCodexCliUsage(day('2026-10-15'))
assertEqual(olderOnly.limits.primary.resetsAt, olderAt + 3600000, 'resets_in_seconds resolves to an absolute time')
assertEqual(olderOnly.contextWindow, 400000, 'the context window follows the newest turn')

// Trailing windows recompute totals, models and the session list.
const windowed = windowCliUsage(full, now - 86400000, 'codex')
assertEqual(windowed.sessionCount, 1, 'the window keeps only recent sessions')
assertEqual(windowed.totalSessions, 2, 'the unwindowed count is preserved')
assertEqual(windowed.models.map((model) => model.id), ['gpt-5'], 'windowed models are recomputed')
assertEqual(windowed.totalTokens, 5500, 'windowed totals are recomputed')

// A scan caches each rollout by size and mtime, so a dashboard refresh does not
// re-parse the whole history, and a rewritten rollout is not served stale.
const cacheRoot = join(root, 'cache-sessions')
const cacheDay = join(cacheRoot, '2026', '10', '18')
mkdirSync(cacheDay, { recursive: true })
const cacheFile = join(cacheDay, 'rollout-cache.jsonl')
const writeCached = (input) =>
  writeFileSync(
    cacheFile,
    [
      line({ timestamp: iso(60000), type: 'session_meta', payload: { id: 'cache', model: 'gpt-5' } }),
      line({
        timestamp: iso(60000),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: input, output_tokens: 5, total_tokens: input + 5 } },
        },
      }),
    ].join('\n') + '\n',
    'utf8',
  )
writeCached(100)
assertEqual(readCodexCliUsage(cacheRoot).totalTokens, 105, 'the first scan reads the rollout')
assertEqual(readCodexCliUsage(cacheRoot).totalTokens, 105, 'a repeat scan agrees with the first')
writeCached(900000)
assertEqual(readCodexCliUsage(cacheRoot).totalTokens, 900005, 'a rewritten rollout is re-read instead of served stale')
const mounted = mount({codexUsageDir:cacheRoot,providers:{opencode:false,grok:false,codex:{bin:process.execPath,models:['gpt-5']}}})
assertEqual((await mounted.adapter.cliUsage()).codex.totalTokens,900005,'the adapter reads the original rollout')
writeCached(200)
assertEqual((await mounted.adapter.cliUsage()).codex.totalTokens,900005,'the ordinary request reuses its bounded cache')
assertEqual((await mounted.adapter.cliUsage(0,{force:true})).codex.totalTokens,205,'explicit refresh rereads the changed rollout immediately')
mounted.adapter.cliUsageCache.get(0).at=0
// Change file size too: this fixture tests the adapter TTL, not filesystem
// timestamp resolution for two same-size writes within one clock tick.
writeCached(300000)
assertEqual((await mounted.adapter.cliUsage()).codex.totalTokens,300005,'the ordinary cache also refreshes when its TTL expires')
const fixedStamp=new Date('2026-10-17T12:00:00Z')
writeCached(400000);utimesSync(cacheFile,fixedStamp,fixedStamp)
await mounted.adapter.cliUsage(0,{force:true})
writeCached(500000);utimesSync(cacheFile,fixedStamp,fixedStamp)
assertEqual((await mounted.adapter.cliUsage(0,{force:true})).codex.totalTokens,500005,'force refresh bypasses the rollout cache even with unchanged size and mtime')

// A missing directory is reported, never thrown.
const missing = readCodexCliUsage(join(root, 'nope'))
assertEqual(missing.available, false, 'a missing directory is unavailable')
assert(missing.note.length > 0, 'a missing directory explains itself')

// The model catalog reader skips hidden entries and survives junk.
assertEqual(readCodexModelList(join(root, 'nope.json')), [], 'a missing catalog is empty')
writeFileSync(join(root, 'junk.json'), '{not json', 'utf8')
assertEqual(readCodexModelList(join(root, 'junk.json')), [], 'an unreadable catalog is empty')

// Quotas are snapshots, not live readings; later chat activity must not re-date them.
const snapshotDir = join(root, 'snapshots')
mkdirSync(snapshotDir, { recursive: true })
const observedAt = now - 10 * 86400000
writeFileSync(join(snapshotDir, 'rollout-snapshot.jsonl'), [
  line({ timestamp: new Date(observedAt).toISOString(), type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: 5, output_tokens: 1 } },
    rate_limits: { primary: { used_percent: 30, window_minutes: 300, resets_in_seconds: 60 } },
  } }),
  line({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: 'recent chat' } }),
].join('\n'))
const snapshot = readCodexCliUsage(snapshotDir)
assertEqual(snapshot.limitsObservedAt.primary, observedAt, 'quota age follows its token event, not later session activity')
assertEqual(snapshot.limitsStale.primary, true, 'an old or expired quota is marked stale')
const noRecent = windowCliUsage(snapshot, now + 1, 'codex', 7)
assertEqual(noRecent.limits.primary.usedPercent, 30, 'a usage window preserves the last recorded account quota')
assertEqual(noRecent.limitsObservedAt.primary, observedAt, 'windowing preserves the quota observation time')
writeFileSync(join(snapshotDir, 'rollout-quota-only.jsonl'), line({timestamp:new Date(now).toISOString(),type:'event_msg',payload:{type:'token_count',rate_limits:{primary:{used_percent:42,window_minutes:300,resets_in_seconds:3600}}}}))
const quotaOnly=readCodexCliUsage(snapshotDir)
assertEqual(quotaOnly.limits.primary.usedPercent,42,'a fresh quota-only rollout supersedes old usage snapshots')
assertEqual(quotaOnly.limitsObservedAt.primary,now,'quota-only events retain their actual observation time')

rmSync(root, { recursive: true, force: true })
console.log('ok  usage.test')
