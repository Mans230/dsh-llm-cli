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
import { SignInManager, apply, parseDeviceInfo } from '../index.js'
import { assert, assertEqual, assertMatch } from './_assert.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const stub = join(here, 'stubs', 'stub-cli.mjs')
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
let captured
apply(
  {
    logger: { info() {}, warn() {} },
    llm: { registerAdapter: (_routes, adapter) => { captured = adapter } },
    inject: (_deps, cb) => cb({ tools: { register() {} }, webServer: { register: () => () => {} }, effect() {} }),
    effect() {},
  },
  {
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
  },
)

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

rmSync(flag, { force: true })
console.log('ok  signin.test')
