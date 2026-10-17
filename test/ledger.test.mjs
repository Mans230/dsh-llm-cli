/**
 * Ledger test: drives the real adapter against a stub CLI that emits an
 * OpenCode-shaped NDJSON turn (text + tokens + cost) and a failing turn, then
 * checks the usage ledger recorded both.
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
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

rmSync(ledger, { force: true })
assert(true, 'ledger test')
console.log('ok  ledger.test')
