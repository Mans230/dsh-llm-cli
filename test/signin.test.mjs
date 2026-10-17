/**
 * Sign-in test: unit-checks the device-code parser, then drives the real
 * SignInManager against a stub CLI that mimics `grok login --device-auth`, and
 * checks that a signed-out route surfaces the device code through the turn
 * error instead of just failing.
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SignInManager, parseDeviceInfo } from '../index.js'
import { mount } from './_harness.mjs'
import { assert, assertEqual, assertMatch } from './_assert.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const stub = join(here, 'stubs', 'stub-cli.mjs')

// A failed status command must not become a positive OpenCode sign-in result.
const missingCli = new SignInManager({ cwd: here, providers: {
  opencode: { bin: join(here, 'definitely-missing-auth-cli.exe') },
} })
assertEqual((await missingCli.status('opencode')).signedIn, false, 'a missing OpenCode CLI cannot report signed in')
const failedProbe = new SignInManager({ cwd: here, providers: {
  opencode: { bin: process.execPath, statusArgs: ['-e', "console.error('status probe failed');process.exit(1)"] },
} })
assertEqual((await failedProbe.status('opencode')).signedIn, false, 'a failed OpenCode status probe cannot report signed in')

const flag = join(tmpdir(), `dsh-llm-cli-stub-flag-${process.pid}`)
process.env.STUB_FLAG = flag
rmSync(flag, { force: true })

const parsed = parseDeviceInfo(
  'To sign in, open this URL in your browser:\n  https://accounts.x.ai/oauth2/device?user_code=BRT7-Y2BB\nConfirm this code in your browser:\n  BRT7-Y2BB',
)
assertEqual(parsed.url, 'https://accounts.x.ai/oauth2/device?user_code=BRT7-Y2BB', 'device URL is parsed')
assertEqual(parsed.code, 'BRT7-Y2BB', 'device code is parsed')

const manager = new SignInManager({
  cwd: here,
  providers: {
    grok: { bin: process.execPath, loginArgs: [stub, 'login'], statusArgs: [stub, 'models'] },
  },
})

assertEqual((await manager.status('grok')).signedIn, false, 'starts signed out')
const started = await manager.start('grok')
assertMatch(started.code ?? started.url ?? '', /TEST-1234/, 'start returns the device code')
assertEqual((await manager.settle('grok', 500)).pending, true, 'settle reports pending before approval')
const settled = await manager.settle('grok', 15000)
assertEqual(settled.pending, false, 'settle completes after approval')
assertEqual((await manager.status('grok')).signedIn, true, 'ends signed in')

// Auto sign-in: a route whose CLI is signed out must surface the device code
// through the turn's error instead of just failing.
rmSync(flag, { force: true })
const { adapter: captured } = mount({
  cwd: here,
  providers: {
    opencode: {
      bin: process.execPath,
      statusArgs: [stub, 'models'],
      loginArgs: [stub, 'login'],
      signedIn: (out) => /logged in/i.test(out) && !/not authenticated/i.test(out),
      buildArgs: () => [stub, 'fail'],
    },
    grok: false,
  },
})

let autoError
try {
  for await (const _chunk of captured.stream({
    provider: 'opencode',
    model: 'stub',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })) {
    /* no chunks expected */
  }
} catch (error) {
  autoError = error.message
}
assert(/sign in|https?:\/\//i.test(autoError ?? ''), `a signed-out turn offers a sign-in path (got: ${autoError})`)

// A sign-in nobody comes back to must not leave the CLI waiting forever. The
// device code expires anyway, so the manager closes its own window.
const ttl = new SignInManager({
  cwd: here,
  signInTtlMs: 300,
  providers: { grok: { bin: process.execPath, loginArgs: [stub, 'login'], statusArgs: [stub, 'models'] } },
})
rmSync(flag, { force: true })
const waiting = await ttl.start('grok')
assert(waiting.code ?? waiting.url, 'the device instruction is returned')
assertEqual(ttl.pending.size, 1, 'the sign-in waits for a human')
await new Promise((resolve) => setTimeout(resolve, 700))
assertEqual(ttl.pending.size, 0, 'the waiting sign-in is closed after its TTL')
const restarted = await ttl.start('grok')
assert(!restarted.resumed, 'a closed sign-in can be started again')
await new Promise((resolve) => setTimeout(resolve, 700))
assertEqual(ttl.pending.size, 0, 'the restarted sign-in is closed the same way')
rmSync(flag, { force: true })

// Completion/cancellation must release a session even when nobody calls settle.
const unattended = new SignInManager({
  cwd: here,
  signInTtlMs: 10000,
  providers: { grok: { bin: process.execPath, loginArgs: [stub, 'login'], statusArgs: [stub, 'models'] } },
})
await unattended.start('grok')
const finished = unattended.pending.get('grok')
await finished.done
await new Promise((resolve) => setTimeout(resolve, 0))
assertEqual(unattended.pending.size, 0, 'a completed sign-in releases its pending entry without polling')
rmSync(flag, { force: true })
await unattended.start('grok')
const cancelled = unattended.pending.get('grok')
assertEqual(unattended.cancel('grok'), true, 'cancel closes a waiting sign-in')
await cancelled.done
assertEqual(unattended.pending.size, 0, 'cancel releases its pending entry')
const aborted = new AbortController()
aborted.abort()
let abortError
try { await unattended.start('grok', aborted.signal) } catch (error) { abortError = error.message }
assertMatch(abortError ?? '', /aborted/, 'a pre-aborted sign-in does not spawn')

rmSync(flag, { force: true })
console.log('ok  signin.test')
