/**
 * Dashboard tests: who may read it, and how the page refreshes.
 *
 * The two endpoints expose cost, model names and sign-in state, so a request
 * from another machine must present the configured token. The page also used to
 * reload from a meta tag, which threw the reader to the top every 20 seconds.
 */
import { rmSync } from 'node:fs'
import { mount } from './_harness.mjs'
import { assert, assertEqual, assertMatch } from './_assert.mjs'

const TOKEN = 'tok_3f9a1c7e5b2d4a80'
const { root, webRoutes, adapter, logs, usageFile } = mount({
  cwd: process.cwd(),
  dashboardToken: TOKEN,
  providers: {
    grok: { bin: process.execPath, statusArgs: ['-e', 'process.exit(0)'], models: ['grok-4.7'] },
    opencode: false,
    codex: false,
  },
})

const html = webRoutes.find((route) => route.path === '/llm-cli/usage')
assert(!logs.some((line) => line.includes(usageFile) || line.includes(process.cwd()) || line.includes(TOKEN)), 'mount logs contain no deployment path or dashboard token')
const json = webRoutes.find((route) => route.path === '/llm-cli/usage.json')
assert(html && json, 'both dashboard routes are registered')
const originalInvalidate=adapter.invalidateCaches.bind(adapter)
let invalidations=0
adapter.invalidateCaches=()=>{invalidations++;originalInvalidate()}

function fakeResponse() {
  return {
    status: null,
    body: '',
    headers: {},
    written: {},
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    setHeader(name, value) {
      this.written[name] = value
    },
    end(body) {
      this.body = String(body ?? '')
    },
  }
}

function fakeRequest(url, { address = '127.0.0.1', headers = {} } = {}) {
  return { url, headers, socket: { remoteAddress: address } }
}

async function call(route, request) {
  const response = fakeResponse()
  await route.handler(request, response)
  return response
}

// --- 1. This machine always reads the dashboard.
const local = await call(html, fakeRequest('/llm-cli/usage'))
assertEqual(local.status, 200, 'a loopback request is served')
assertMatch(local.headers['content-type'], /text\/html/, 'the page is html')
assert(local.body.includes('CLI provider usage'), 'the page renders')
await call(json,fakeRequest('/llm-cli/usage.json?force=1'))
assert(invalidations>0,'the JSON force query invalidates source caches')
const beforeHtml=invalidations
await call(html,fakeRequest('/llm-cli/usage?force=1'))
assert(invalidations>beforeHtml,'the HTML force query invalidates source caches')

const localV6 = await call(json, fakeRequest('/llm-cli/usage.json', { address: '::1' }))
assertEqual(localV6.status, 200, 'an IPv6 loopback request is served')
const mappedV4 = await call(json, fakeRequest('/llm-cli/usage.json', { address: '::ffff:127.0.0.1' }))
assertEqual(mappedV4.status, 200, 'a mapped IPv4 loopback request is served')

// --- 2. Another machine needs the token, and gets told so when it is missing.
const remote = await call(json, fakeRequest('/llm-cli/usage.json', { address: '192.168.1.20' }))
assertEqual(remote.status, 403, 'a remote request without a token is refused')
assertMatch(remote.body, /token is required/, 'the refusal explains how to present a token')
assert(!remote.body.includes('"routes"'), 'the refusal leaks no payload')

// With no token configured at all, the refusal names the config key instead.
const open = mount({
  providers: { grok: { bin: process.execPath, statusArgs: ['-e', 'process.exit(0)'], models: ['grok-4.7'] }, opencode: false, codex: false },
})
const openJson = open.webRoutes.find((route) => route.path === '/llm-cli/usage.json')
const openRemote = await call(openJson, fakeRequest('/llm-cli/usage.json', { address: '192.168.1.20' }))
assertEqual(openRemote.status, 403, 'remote access is refused when no token is configured')
assertMatch(openRemote.body, /dashboardToken/, 'that refusal names the config key')
assertEqual((await call(openJson, fakeRequest('/llm-cli/usage.json'))).status, 200, 'loopback still works with no token configured')

const wrong = await call(json, fakeRequest('/llm-cli/usage.json?token=nope-nope-nope-nope', { address: '192.168.1.20' }))
assertEqual(wrong.status, 403, 'a remote request with a wrong token is refused')

// --- 3. A correct token is accepted from a header, a query, or a cookie.
const viaHeader = await call(json, fakeRequest('/llm-cli/usage.json', { address: '192.168.1.20', headers: { 'x-llm-cli-token': TOKEN } }))
assertEqual(viaHeader.status, 200, 'a token in the header is accepted')
assert(JSON.parse(viaHeader.body).routes, 'the json payload is served')

const viaQuery = await call(json, fakeRequest(`/llm-cli/usage.json?token=${TOKEN}`, { address: '192.168.1.20' }))
assertEqual(viaQuery.status, 200, 'a token in the query is accepted')
assertMatch(String(viaQuery.written['set-cookie'] ?? ''), /llm_cli_token=/, 'a query token becomes a cookie for the page links')
assertMatch(String(viaQuery.written['set-cookie'] ?? ''), /HttpOnly/, 'the cookie is not readable from script')

const viaCookie = await call(html, fakeRequest('/llm-cli/usage', { address: '192.168.1.20', headers: { cookie: `llm_cli_token=${TOKEN}` } }))
assertEqual(viaCookie.status, 200, 'a token in the cookie is accepted')
assert(!viaCookie.written['set-cookie'], 'a cookie already held is not set again')

// --- 4. A token too short to be a secret does not unlock remote access.
const weak = mount({
  dashboardToken: 'short',
  providers: { grok: { bin: process.execPath, statusArgs: ['-e', 'process.exit(0)'], models: ['grok-4.7'] }, opencode: false, codex: false },
})
const weakJson = weak.webRoutes.find((route) => route.path === '/llm-cli/usage.json')
const weakRemote = await call(weakJson, fakeRequest('/llm-cli/usage.json?token=short', { address: '10.0.0.5' }))
assertEqual(weakRemote.status, 403, 'a short token is refused rather than treated as configured')
const weakLocal = await call(weakJson, fakeRequest('/llm-cli/usage.json'))
assertEqual(weakLocal.status, 200, 'a short token still leaves loopback working')

// --- 5. The page refreshes without resetting the reader's position.
assert(!local.body.includes('http-equiv="refresh"'), 'the meta refresh is gone')
assert(local.body.includes('llm-cli:scroll'), 'the page remembers the scroll position')
assert(local.body.includes('sessionStorage.setItem'), 'the page saves the position before reloading')
assert(local.body.includes('pause auto-refresh'), 'the page offers a way to stop refreshing')

const paused = await call(html, fakeRequest('/llm-cli/usage?refresh=off'))
assert(!paused.body.includes('sessionStorage.setItem'), 'a paused page schedules no reload')
assert(paused.body.includes('auto-refresh is off'), 'the paused page says so')
assert(paused.body.includes('resume auto-refresh'), 'the paused page offers to resume')

// --- 6. The recent-turns table marks both outcomes, escapes the error, and
// labels a turn-counting table as turns rather than steps.
adapter.ledger.record({ at: Date.now() - 2000, ms: 900, provider: 'grok', model: 'grok-4.7', inputTokens: 100, outputTokens: 10, ok: true })
adapter.ledger.record({ at: Date.now() - 1000, ms: 300, provider: 'grok', model: 'grok-4.7', inputTokens: 0, outputTokens: 0, ok: false, error: 'rate <limited>' })
const withTurns = await call(html, fakeRequest('/llm-cli/usage'))
assert(withTurns.body.includes('<span class="ok">ok</span>'), 'a finished turn is marked ok rather than bare text')
assert(withTurns.body.includes('<span class="bad">rate &lt;limited&gt;</span>'), 'a failed turn is marked and its error escaped')
assert(withTurns.body.includes('<th>Turns</th>'), 'a table that counts turns says "turns", not "steps"')

rmSync(root, { recursive: true, force: true })
rmSync(open.root, { recursive: true, force: true })
rmSync(weak.root, { recursive: true, force: true })
console.log('ok  dashboard.test')
