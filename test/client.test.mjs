/**
 * Client test: loads the browser half through a tiny hook-capable React stub
 * and renders the page against a real host payload, then checks the dashboard
 * sections (including the Codex 5-hour/weekly gauges) actually appear.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, describeRoutes } from '../index.js'
import { assert, assertEqual } from './_assert.mjs'

const root = join(tmpdir(), `dsh-llm-cli-client-${process.pid}`)
rmSync(root, { recursive: true, force: true })

// A synthetic Codex rollout so the payload carries real-looking limits.
const rolloutDir = join(root, 'codex', 'sessions', '2026', '10', '17')
mkdirSync(rolloutDir, { recursive: true })
const at = new Date(Date.now() - 1800000).toISOString()
writeFileSync(
  join(rolloutDir, 'rollout-client-test.jsonl'),
  [
    JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: 'client-test', cwd: '/tmp', model: 'gpt-6.1-sol' } }),
    JSON.stringify({ timestamp: at, type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
    JSON.stringify({
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 12000, cached_input_tokens: 9000, output_tokens: 800, reasoning_output_tokens: 120, total_tokens: 12800 },
          last_token_usage: { input_tokens: 12000, cached_input_tokens: 9000, output_tokens: 800, reasoning_output_tokens: 120, total_tokens: 12800 },
          model_context_window: 475000,
        },
        rate_limits: {
          primary: { used_percent: 18, window_minutes: 300, resets_in_seconds: 3600 },
          secondary: { used_percent: 4, window_minutes: 10080, resets_in_seconds: 300000 },
        },
      },
    }),
  ].join('\n') + '\n',
  'utf8',
)

const ledger = join(root, 'ledger.json')
let adapter
apply(
  {
    logger: { info() {}, warn() {} },
    llm: { registerAdapter: (_routes, value) => { adapter = value } },
    inject: (_deps, cb) => cb({ tools: { register() {} }, webServer: { register: () => () => {} }, effect() {} }),
    effect() {},
  },
  {
    cwd: root,
    usageFile: ledger,
    codexUsageDir: join(root, 'codex', 'sessions'),
    plan: { grok: { weeklyPremium: { usedPercent: 1, resetAt: '2026-10-23T15:13:00Z' } } },
    providers: { grok: {} },
  },
)

const payload = await describeRoutes(adapter, adapter.ledger, 7)
assertEqual(payload.cliUsage.codex.available, true, 'the payload carries codex usage')
assertEqual(payload.cliUsage.codex.limits.primary.usedPercent, 18, 'the payload carries the 5-hour limit')
assertEqual(payload.plans.grokWeekly.usedPercent, 1, 'the payload carries the configured Grok weekly limit')

// Load client.js the way the harness does, with a React stub that records the tree.
const queue = [{ status: 'ready', data: payload }]
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter((child) => child != null && child !== false) }),
  useState: (initial) => (queue.length ? [queue.shift(), () => {}] : [initial, () => {}]),
  useEffect: () => {},
}
globalThis.window = { __ModuleLoader__: { load: (mod) => { globalThis.__loaded = mod } } }
await import('../client.js')
const loaded = globalThis.__loaded
assert(typeof loaded?.factory === 'function', 'client.js registers a module factory')
const exportsObj = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})
assert(typeof exportsObj.apply === 'function', 'the client exports apply')
assertEqual(exportsObj.inject, ['slots'], 'the client injects the slots service')

function render(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  const { type, props, children } = node
  const attrs = Object.entries(props ?? {})
    .filter(([key, value]) => key !== 'children' && typeof value !== 'object' && value != null)
    .map(([key, value]) => ` ${key}="${String(value).replace(/"/g, '')}"`)
    .join('')
  return `<${type}${attrs}>${children.map(render).join('')}</${type}>`
}

const html = render(React.createElement(exportsObj.LlmCliPage, { view: 'full' }))
const count = (re) => (html.match(re) ?? []).length
assert(count(/<svg/g) >= 4, `the page renders SVG charts (got ${count(/<svg/g)})`)
assert(count(/<table/g) >= 3, `the page renders usage tables (got ${count(/<table/g)})`)
assert(html.includes('\u2014'), 'a cost no CLI reported renders as a dash, not a zero')
for (const needle of [
  'Codex daily tokens',
  'Codex 5-hour limit',
  'Codex weekly limit',
  'Grok weekly premium limit',
  'gpt-6.1-sol',
  '5h',
  '7d',
]) {
  assert(html.includes(needle), `the rendered page contains "${needle}"`)
}

rmSync(root, { recursive: true, force: true })
console.log('ok  client.test')
