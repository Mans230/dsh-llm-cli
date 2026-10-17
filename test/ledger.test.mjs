/**
 * Ledger test: drives the real adapter against a stub CLI that emits an
 * OpenCode-shaped NDJSON turn (text + tokens + cost) and a failing turn, then
 * checks the usage ledger recorded both.
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageLedger, apply } from '../index.js'
import { assert, assertEqual } from './_assert.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const stub = join(here, 'stubs', 'stub-cli.mjs')
const ledger = join(tmpdir(), `dsh-llm-cli-ledger-test-${process.pid}.json`)
rmSync(ledger, { force: true })

let adapter
apply(
  {
    logger: { info() {}, warn() {} },
    llm: { registerAdapter: (_routes, value) => { adapter = value } },
    inject: (_deps, cb) => cb({ tools: { register() {} }, webServer: { register: () => () => {} }, effect() {} }),
    effect() {},
  },
  {
    cwd: here,
    usageFile: ledger,
    providers: {
      opencode: { bin: process.execPath, buildArgs: () => [stub, 'stream'] },
      grok: { bin: process.execPath, buildArgs: () => [stub, 'fail'] },
    },
  },
)

const turn = async (provider, model) => {
  const chunks = []
  try {
    for await (const chunk of adapter.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })) {
      chunks.push(chunk)
    }
  } catch (error) {
    chunks.push({ type: 'error', message: error.message })
  }
  return chunks
}

const ok = await turn('opencode', 'opencode/test-model')
assertEqual(ok.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'LEDGER-OK', 'stub text is streamed')
assertEqual(
  ok.find((c) => c.type === 'usage')?.usage,
  { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 0, reasoningTokens: 7 },
  'stub usage is parsed',
)
assertEqual(ok.find((c) => c.type === 'finish')?.reason?.kind, 'stop', 'turn finishes cleanly')

const bad = await turn('grok', 'grok-4.7')
assert(/not authenticated/i.test(bad.find((c) => c.type === 'error')?.message ?? ''), 'a failing CLI surfaces its error')

const summary = adapter.ledger.summary()
assertEqual(summary.turns, 2, 'the ledger records both turns')
assertEqual(summary.recent.filter((entry) => entry.ok).length, 1, 'one successful turn')
assertEqual(summary.recent.filter((entry) => !entry.ok).length, 1, 'one failed turn')

// Retention caps the stored turns, never the lifetime totals. Deriving the
// totals from the capped list made every figure plateau at 1000 turns.
const retentionFile = join(tmpdir(), `dsh-llm-cli-ledger-retention-${process.pid}.json`)
rmSync(retentionFile, { force: true })
const retention = new UsageLedger(retentionFile, 50)
for (let index = 0; index < 200; index += 1) {
  retention.record({ at: index, ms: 10, provider: 'codex', model: 'gpt', inputTokens: 10, outputTokens: 1, costUsd: 0.01, ok: true })
}
const kept = retention.summary()
assertEqual(kept.turns, 200, 'turns are counted over the whole life of the ledger')
assertEqual(kept.providers[0].turns, 200, 'per-provider turns are lifetime totals')
assertEqual(kept.providers[0].inputTokens, 2000, 'per-provider tokens are lifetime totals')
assertEqual(Number(kept.providers[0].costUsd.toFixed(2)), 2, 'lifetime cost is not capped by retention')
assertEqual(kept.recent.length, 50, 'the recent list stays bounded by retention')

const reloaded = new UsageLedger(retentionFile, 50).summary()
assertEqual(reloaded.turns, 200, 'lifetime turns survive a restart')
assertEqual(Number(reloaded.providers[0].costUsd.toFixed(2)), 2, 'lifetime cost survives a restart')
assertEqual(reloaded.recent.length, 50, 'retention still caps the stored turns')
rmSync(retentionFile, { force: true })

rmSync(ledger, { force: true })
assert(true, 'ledger test')
console.log('ok  ledger.test')
