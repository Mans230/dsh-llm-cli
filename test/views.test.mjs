/**
 * Usage-view tests. Each CLI is read from the source that suits it, so the
 * measurement rules differ per route. These cases pin those rules, and pin the
 * rule that a figure a CLI never reports is shown as a dash, never as zero.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeRoutes, readGrokCliUsage, renderUsageHtml } from '../index.js'
import { mount, drain, turn, writeCli } from './_harness.mjs'
import { assert, assertEqual, assertMatch } from './_assert.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-llm-cli-views-'))
const dash = '\u2014'

// --- 1. OpenCode reports usage per agent step, so a turn sums its steps.
const multi = mount({
  providers: {
    opencode: { bin: process.execPath, buildArgs: () => [`${multi.root}/steps.mjs`] },
    grok: false,
    codex: false,
  },
})
writeCli(
  multi.root,
  'steps.mjs',
  `process.stdout.write([
     JSON.stringify({ type: 'text', part: { text: 'one' } }),
     JSON.stringify({ type: 'step_finish', part: { tokens: { input: 100, output: 10, cache: { read: 5 } }, cost: 0.001 } }),
     JSON.stringify({ type: 'text', part: { text: 'two' } }),
     JSON.stringify({ type: 'step_finish', part: { tokens: { input: 900, output: 20, cache: { read: 50 } }, cost: 0.009 } }),
   ].join('\\n') + '\\n')
   process.exit(0)`,
)
const multiTurn = await drain(multi.adapter, turn('opencode', 'opencode/free'))
assertEqual(
  multiTurn.chunks.find((chunk) => chunk.type === 'usage')?.usage,
  { inputTokens: 1000, outputTokens: 30, cacheReadTokens: 55, cacheWriteTokens: 0, reasoningTokens: 0 },
  'a multi-step turn sums the tokens of every step',
)
const multiRow = multi.adapter.ledger.summary().recent[0]
assertEqual(multiRow.inputTokens, 1000, 'the ledger records the summed input tokens')
assertEqual(multiRow.costUsd.toFixed(3), '0.010', 'the ledger records the summed cost')
assertEqual(multi.adapter.ledger.summary().providers[0].costTurns, 1, 'a turn that reported a cost counts as a costed turn')

// --- 2. A route that reports one total per turn replaces, so it is not doubled.
const codex = mount({
  providers: {
    codex: { bin: process.execPath, buildArgs: () => [`${codex.root}/turn.mjs`] },
    opencode: false,
    grok: false,
  },
})
writeCli(
  codex.root,
  'turn.mjs',
  `process.stdout.write([
     JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
     JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 20, reasoning_output_tokens: 7 } }),
   ].join('\\n') + '\\n')
   process.exit(0)`,
)
const codexTurn = await drain(codex.adapter, turn('codex', 'gpt-6.1-sol'))
assertEqual(
  codexTurn.chunks.find((chunk) => chunk.type === 'usage')?.usage,
  { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 0, reasoningTokens: 7, totalTokens: 1020 },
  'a single per-turn total is reported once, not doubled',
)
assertEqual(codex.adapter.ledger.summary().providers[0].costTurns, 0, 'a turn with no cost is not a costed turn')

// --- 3. Grok reports one usage block per turn, so the last one stands.
const grok = mount({
  providers: {
    grok: { bin: process.execPath, buildArgs: () => [`${grok.root}/usage.mjs`] },
    opencode: false,
    codex: false,
  },
})
writeCli(
  grok.root,
  'usage.mjs',
  `process.stdout.write([
     JSON.stringify({ type: 'text', data: 'answer' }),
     JSON.stringify({ type: 'usage', usage: { input_tokens: 10, output_tokens: 1 } }),
     JSON.stringify({ type: 'usage', usage: { input_tokens: 40, output_tokens: 4 } }),
   ].join('\\n') + '\\n')
   process.exit(0)`,
)
const grokTurn = await drain(grok.adapter, turn('grok', 'grok-4.7'))
assertEqual(
  grokTurn.chunks.find((chunk) => chunk.type === 'usage')?.usage,
  { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  'a repeated per-turn usage block is not summed',
)

// --- 3b. The Grok CLI does record its own sessions. This is the shape a real
// session writes, captured from `grok -p` on this host.
const grokAt = new Date(Date.now() - 120000).toISOString()
const grokSession = {
  inputTokens: 16404,
  outputTokens: 1088,
  cachedReadTokens: 1664,
  cacheCreationTokens: 0,
  reasoningTokens: 1086,
  totalTokens: 17492,
  modelCalls: 1,
  costUsdTicks: 368400000,
  turnCount: 1,
  primaryModelId: 'grok-4.7-build',
  modelUsage: {
    'grok-4.7-build': {
      inputTokens: 16404,
      outputTokens: 1088,
      cachedReadTokens: 1664,
      cacheCreationTokens: 0,
      reasoningTokens: 1086,
      totalTokens: 17492,
      modelCalls: 1,
      costUsdTicks: 368400000,
    },
  },
}
const grokSessionDir = join(root, 'grok-usage', 'C%3A%5Cwork', '01a14a4e-412a-7e93-923d-7757e896c56a')
mkdirSync(grokSessionDir, { recursive: true })
writeFileSync(
  join(grokSessionDir, 'usage.json'),
  JSON.stringify({
    sessionId: '01a14a4e-412a-7e93-923d-7757e896c56a',
    updatedAt: grokAt,
    session: grokSession,
    turns: [{ turnNumber: 1, endedAt: grokAt, ...grokSession }],
  }),
  'utf8',
)
const grokFile = readGrokCliUsage(join(root, 'grok-usage'))
assertEqual(grokFile.available, true, 'a written usage.json makes the grok view available')
assertEqual(grokFile.sessionCount, 1, 'the session file is counted once')
assertEqual(grokFile.totalTokens, 17492, 'the session total is read')
assertEqual(grokFile.costUsd.toFixed(5), '0.03684', 'cost ticks convert to dollars')
assertEqual(grokFile.models.map((model) => model.id), ['grok-4.7-build'], 'per-model usage is read')
assertEqual(grokFile.capabilities.cost, true, 'a recorded session makes cost available')
assertEqual(grokFile.daily[0].date, grokAt.slice(0, 10), 'the turn lands on its own day')

// --- 4. Each route says what its CLI reports, and keeps the same shape when it
// cannot answer at all.
const rolloutDay = join(root, 'codex', 'sessions', '2026', '10', '17')
mkdirSync(rolloutDay, { recursive: true })
const at = new Date(Date.now() - 3600000).toISOString()
writeFileSync(
  join(rolloutDay, 'rollout-views.jsonl'),
  [
    JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: 'views', model: 'gpt-6.1-sol' } }),
    JSON.stringify({
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 80, total_tokens: 1280 },
          last_token_usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 80, total_tokens: 1280 },
          model_context_window: 475000,
        },
        rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_in_seconds: 600 } },
      },
    }),
  ].join('\n') + '\n',
  'utf8',
)
mkdirSync(join(root, 'grok-empty'), { recursive: true })

const views = mount({
  cwd: root,
  codexUsageDir: join(root, 'codex', 'sessions'),
  grokUsageDir: join(root, 'grok-empty'),
  providers: {
    // A missing binary is the real "this CLI is not installed" case.
    opencode: { bin: 'definitely-not-installed-xyz', models: ['opencode/free'] },
    grok: { bin: process.execPath, statusArgs: ['-e', 'process.exit(0)'], models: ['grok-4.7'] },
    codex: { bin: process.execPath, statusArgs: ['-e', 'process.exit(0)'], models: ['gpt-6.1-sol'] },
  },
})
const payload = await describeRoutes(views.adapter, views.adapter.ledger, 0)
for (const id of ['grok', 'opencode', 'codex']) {
  const view = payload.cliUsage[id]
  assert(view, `the payload carries a ${id} view`)
  for (const key of ['available', 'source', 'note', 'capabilities', 'models', 'daily']) {
    assert(key in view, `the ${id} view keeps the field "${key}" even when unavailable`)
  }
  assert(typeof view.capabilities.cost === 'boolean', `the ${id} view states whether it reports cost`)
}

assertEqual(payload.cliUsage.opencode.available, false, 'a missing opencode binary is reported as unavailable')
assertEqual(payload.cliUsage.opencode.capabilities.cost, true, 'opencode is known to report cost')
assertEqual(payload.cliUsage.codex.available, true, 'the codex view reads its rollout')
assertEqual(payload.cliUsage.codex.capabilities.cost, false, 'codex never reports cost')
assertMatch(payload.cliUsage.codex.capabilities.costReason, /never a cost|no cost/, 'the reason travels with the flag')
assertEqual(payload.cliUsage.grok.available, false, 'grok has no recorded session to read')
assertEqual(payload.cliUsage.grok.capabilities.cost, false, 'grok reports no cost when it has no session')
assertMatch(payload.cliUsage.grok.note, /no grok session usage recorded/, 'the note says no session was recorded')

// --- 5. The server-rendered page shows a dash, never a zero, for a figure the
// CLI did not report.
const html = renderUsageHtml(
  { providers: [], models: [], turns: 0, recent: [], ledgerFile: 'x' },
  Date.now(),
  [],
  '',
  payload.cliUsage,
  payload.plans,
)
assert(html.includes(`Codex cost</div><div class="v">${dash}`), 'the codex cost card is a dash')
assert(!html.includes('Codex cost</div><div class="v">$0.00'), 'the codex cost card is not a fake zero')
assert(html.includes(`Grok CLI tokens</div><div class="v">${dash}`), 'an unavailable grok token card is a dash')
assert(!html.includes('Grok CLI tokens</div><div class="v">0<'), 'an unavailable grok token card is not a zero')
assert(html.includes('never a cost'), 'the page explains why a cost is missing')
assert(html.includes('no grok session usage recorded'), 'the page explains why grok usage is missing')

// --- 6. The harness route card also avoids a confident zero for a route whose
// CLI never reports cost.
const routePayload = await describeRoutes(codex.adapter, codex.adapter.ledger, 0)
const routeHtml = renderUsageHtml(
  routePayload,
  Date.now(),
  routePayload.routes,
  '',
  routePayload.cliUsage,
  routePayload.plans,
)
assert(routeHtml.includes(`<div class="k">Codex (CLI)</div><div class="v">1 turns</div><div class="k">${dash}`), 'a route with no costed turns shows a dash for spend')

rmSync(root, { recursive: true, force: true })
rmSync(multi.root, { recursive: true, force: true })
rmSync(codex.root, { recursive: true, force: true })
rmSync(grok.root, { recursive: true, force: true })
console.log('ok  views.test')
