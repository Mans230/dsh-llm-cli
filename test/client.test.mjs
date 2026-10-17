/**
 * Client test: loads the browser half through a tiny hook-capable React stub
 * and renders the page against a real host payload, then checks the dashboard
 * sections (including the Codex 5-hour/weekly gauges) actually appear.
 *
 * The stub keeps state per hook slot and returns a real setter, so a click can
 * be driven and its effect on the view read back.
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

// Fields nothing in either half reads are gone from the served view.
for (const gone of ['recentSessions', 'signInText', 'signInNote', 'subagents', 'streak']) {
  assert(!(gone in payload.cliUsage.codex), `the codex view does not carry the unused "${gone}" field`)
}
assert(
  payload.routes.every((route) => route.models.every((model) => !('contextWindows' in model))),
  'model limits carry one context window, not an unused list',
)

// Load client.js the way the harness does, with a React stub that records the
// tree and keeps each hook's state so a click can be followed.
globalThis.window = { __ModuleLoader__: { load: (mod) => { globalThis.__loaded = mod } } }
await import('../client.js')
const loaded = globalThis.__loaded
assert(typeof loaded?.factory === 'function', 'client.js registers a module factory')

/** A fresh React stub; `overrides` seeds hook slots by index. */
function makeReact(overrides = {}) {
  const cells = new Map()
  let slot = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter((child) => child != null && child !== false) }),
    useState: (initial) => {
      const key = slot++
      if (!cells.has(key)) cells.set(key, { value: key in overrides ? overrides[key] : initial })
      const cell = cells.get(key)
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next
        },
      ]
    },
    useEffect: () => {},
  }
  return { React, cells, reset: () => { slot = 0 } }
}

function loadClient(overrides) {
  const stub = makeReact(overrides)
  const exportsObj = loaded.factory((id) => {
    if (id === 'react') return stub.React
    throw new Error(`unexpected require: ${id}`)
  })
  return { exportsObj, cells: stub.cells, reset: stub.reset }
}

const first = loadClient({ 0: { status: 'ready', data: payload } })
assert(typeof first.exportsObj.apply === 'function', 'the client exports apply')
assertEqual(first.exportsObj.inject, ['slots'], 'the client injects the slots service')

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

const tree = (client) => {
  client.reset()
  return client.exportsObj.LlmCliPage({ view: 'full' })
}
const pageOf = (client) => render(tree(client))
const walk = (node, found = []) => {
  if (node == null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) walk(child, found)
    return found
  }
  found.push(node)
  walk(node.children, found)
  return found
}
const buttonNamed = (node, label) => walk(node).find((element) => element.type === 'button' && element.children.includes(label))

const html = pageOf(first)
const count = (re) => (html.match(re) ?? []).length
assert(count(/<svg/g) >= 4, `the page renders SVG charts (got ${count(/<svg/g)})`)
assert(count(/<table/g) >= 3, `the page renders usage tables (got ${count(/<table/g)})`)
for (const needle of [
  'Codex daily tokens',
  'Codex 5-hour limit',
  'Codex weekly limit',
  'Grok weekly premium limit',
  'gpt-6.1-sol',
  'Turns / steps',
  '5h',
  '7d',
]) {
  assert(html.includes(needle), `the rendered page contains "${needle}"`)
}

// --- The update action is offered only where it can actually run. A remote
// reader gets the version check without the token, so the button must not
// appear and then do nothing.
const updateView = (overrides) => ({
  status: 'ready',
  data: {
    current: '0.7.0',
    latest: '0.8.0',
    updateAvailable: true,
    canApply: true,
    install: { method: 'git', detail: '/tmp/checkout' },
    autoUpdate: false,
    restartRequired: false,
    lastResult: null,
    ...overrides,
  },
})

const remote = loadClient({ 0: { status: 'ready', data: payload }, 4: updateView({ actionToken: '' }) })
const remoteHtml = pageOf(remote)
assert(remoteHtml.includes('Check for updates'), 'the version check is offered to a remote reader')
assert(!remoteHtml.includes('Update now'), 'a reader without the action token is not offered the update button')

const local = loadClient({ 0: { status: 'ready', data: payload }, 4: updateView({ actionToken: 'tok-1234' }) })
const localTree = tree(local)
assert(render(localTree).includes('Update now'), 'a loopback reader is offered the update button')
assertEqual(local.cells.get(4).value.status, 'ready', 'the update view starts ready')

// A refused action surfaces as an error instead of being stored as a result.
const savedFetch = globalThis.fetch
try {
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) })
  buttonNamed(localTree, 'Update now').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assertEqual(local.cells.get(4).value.status, 'error', 'a refused update becomes an error, not a result')
  assert(/HTTP 403/.test(local.cells.get(4).value.error), `the error names the status (got: ${local.cells.get(4).value.error})`)

  // A successful action records what ran and asks for a restart.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, command: 'npm install x', output: 'added 1 package', restartRequired: true, status: { current: '0.8.0', canApply: true } }),
  })
  buttonNamed(localTree, 'Update now').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const done = local.cells.get(4).value
  assertEqual(done.status, 'ready', 'a successful update returns to ready')
  assertEqual(done.data.restartRequired, true, 'the view asks for a restart')
  assertEqual(done.data.lastResult.ok, true, 'the result records that the command worked')
  assertEqual(done.data.current, '0.8.0', 'the host status is merged back in')
} finally {
  globalThis.fetch = savedFetch
}

rmSync(root, { recursive: true, force: true })
console.log('ok  client.test')
