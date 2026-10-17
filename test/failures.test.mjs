/**
 * Failure-path tests. Every case here used to end in a misleading success, a
 * misleading error, or a malformed stream.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { resolveWindowsShim } from '../index.js'
import { mount, drain, textOf, turn, writeCli } from './_harness.mjs'
import { assert, assertEqual, assertMatch } from './_assert.mjs'

const { adapter, root } = mount({
  providers: {
    opencode: { bin: process.execPath, buildArgs: () => [`${root}/opencode.mjs`] },
    grok: { bin: process.execPath, buildArgs: () => [`${root}/grok.mjs`] },
    codex: false,
  },
})
// Each case rewrites one of these two CLIs, then runs a turn.
const setCli = (name, source) => writeCli(root, name, source)

// --- 1. OpenCode reports provider failures as an error event and exits 0.
setCli(
  'opencode.mjs',
  `process.stdout.write(JSON.stringify({
     type: 'error',
     error: { type: 'provider.quota', message: 'Rate limit exceeded. Please try again later.', status: 429 },
   }) + '\\n')
   process.exit(0)`,
)
const quota = await drain(adapter, turn('opencode', 'opencode/free'))
assertMatch(quota.error ?? '', /Rate limit exceeded/, 'the provider message reaches the caller')
assertMatch(quota.error ?? '', /HTTP 429/, 'the HTTP status reaches the caller')
assertEqual(textOf(quota), '', 'an error event is not passed off as a reply')
assertEqual(adapter.ledger.summary().recent[0].ok, false, 'the failed turn is ledgered as a failure')

// --- 2. The same shape on the Grok route.
setCli('grok.mjs', `process.stdout.write(JSON.stringify({ type: 'error', message: 'weekly limit reached (HTTP 429)' }) + '\\n')`)
const grokError = await drain(adapter, turn('grok', 'grok-4.7'))
assertMatch(grokError.error ?? '', /weekly limit reached/, 'a grok error event is surfaced')

// --- 3. A CLI that streams text and then hangs must not read as a finished answer.
setCli(
  'opencode.mjs',
  `process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'PARTIAL' } }) + '\\n')
   setTimeout(() => {}, 60000)`,
)
const slow = mount({
  providers: {
    opencode: { bin: process.execPath, timeoutMs: 400, buildArgs: () => [`${slow.root}/slow.mjs`] },
    grok: false,
    codex: false,
  },
})
writeCli(slow.root, 'slow.mjs', `process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'PARTIAL' } }) + '\\n');setTimeout(() => {}, 60000)`)
const timedOut = await drain(slow.adapter, turn('opencode', 'm'))
assertMatch(timedOut.error ?? '', /timed out after 400 ms/, 'a timeout is reported as a timeout')
assertEqual(
  timedOut.chunks.filter((chunk) => chunk.type === 'finish').length,
  0,
  'a timed-out turn does not finish as a stop',
)
assertEqual(slow.adapter.ledger.summary().recent[0].ok, false, 'the timed-out turn is ledgered as a failure')

// --- 4. A CLI that ignores the JSON flag still gets its answer through.
setCli('opencode.mjs', `process.stdout.write('Plain text answer\\nsecond line\\n');process.exit(0)`)
const plain = await drain(adapter, turn('opencode', 'm'))
assertEqual(textOf(plain), 'Plain text answer\nsecond line', 'plain stdout is recovered as the answer')
assertEqual(plain.error, null, 'the recovered answer is not an error')

// --- 5. The same for an answer written to stderr, on a route that lists models.
setCli('grok.mjs', `process.stderr.write('an answer written to stderr\\n');process.exit(0)`)
const onStderr = await drain(adapter, turn('grok', 'grok-4.7'))
assertEqual(textOf(onStderr), 'an answer written to stderr', 'a stderr-only answer is recovered')

// --- 6. Structured output with no text stays an error rather than leaking JSON.
setCli('opencode.mjs', `process.stdout.write(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1 } } }) + '\\n')`)
const noText = await drain(adapter, turn('opencode', 'm'))
assertMatch(noText.error ?? '', /produced no reply/, 'structured output without text is reported as no reply')

// --- 7. A bad cwd names the cwd, not the binary.
const badCwd = mount({
  cwd: `${root}/does-not-exist`,
  providers: { grok: { bin: process.execPath, buildArgs: () => ['never-runs'] }, opencode: false, codex: false },
})
const missing = await drain(badCwd.adapter, turn('grok', 'grok-4.7'))
assertMatch(missing.error ?? '', /configured cwd is not a directory/, 'a bad cwd says so')
assert(!/ENOENT/.test(missing.error ?? ''), 'a bad cwd is not reported as a missing binary')
assertEqual(badCwd.adapter.ledger.summary().turns, 1, 'the bad-cwd turn is ledgered once')

// --- 8. Block indices never collide, whichever block type comes first.
setCli(
  'grok.mjs',
  `process.stdout.write([
     JSON.stringify({ type: 'text', data: 'A' }),
     JSON.stringify({ type: 'reasoning', data: 'think' }),
     JSON.stringify({ type: 'text', data: 'B' }),
   ].join('\\n') + '\\n')`,
)
const lateReasoning = await drain(adapter, turn('grok', 'grok-4.7'))
const blocks = lateReasoning.chunks.filter((chunk) => chunk.type.startsWith('block'))
const starts = blocks.filter((chunk) => chunk.type === 'block-start')
const ends = blocks.filter((chunk) => chunk.type === 'block-end')
assertEqual(starts.map((chunk) => chunk.index).sort(), [0, 1], 'each block gets its own index')
assertEqual(
  starts.map((chunk) => `${chunk.index}:${chunk.blockType}`).sort(),
  ['0:text', '1:reasoning'],
  'text keeps the index it started with when reasoning arrives late',
)
assertEqual(ends.map((chunk) => chunk.index).sort(), [0, 1], 'every block that starts also ends')
assertEqual(
  ends.find((chunk) => chunk.index === 1)?.block.text,
  'think',
  'the reasoning block ends with the text it streamed',
)
assertEqual(textOf(lateReasoning), 'AB', 'late reasoning does not reorder or duplicate text')

// --- 9. Reasoning first still numbers text after it.
setCli(
  'grok.mjs',
  `process.stdout.write([
     JSON.stringify({ type: 'reasoning', data: 'think' }),
     JSON.stringify({ type: 'text', data: 'answer' }),
   ].join('\\n') + '\\n')`,
)
const reasoningFirst = await drain(adapter, turn('grok', 'grok-4.7'))
assertEqual(
  reasoningFirst.chunks
    .filter((chunk) => chunk.type === 'block-start')
    .map((chunk) => `${chunk.index}:${chunk.blockType}`),
  ['0:reasoning', '1:text'],
  'reasoning first keeps its index and text follows',
)

// --- 10. A Windows CLI installed only as a .cmd shim still launches, without a
// shell, so a prompt containing `&` cannot become a command.
if (process.platform === 'win32') {
  const shimDir = join(root, 'shim')
  mkdirSync(shimDir, { recursive: true })
  const inner = join(shimDir, 'inner.mjs')
  writeFileSync(
    inner,
    `process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'SHIM-' + process.argv[2] } }) + '\\n')\nprocess.exit(0)`,
  )
  const shim = join(shimDir, 'mytool.cmd')
  writeFileSync(shim, `@echo off\r\n"%dp0%\\inner.mjs" %*\r\n`)

  const resolved = resolveWindowsShim(shim)
  assertEqual(resolved.bin, process.execPath, 'a shim to a script resolves to node')
  assertEqual(resolved.prefix, [inner], 'the script is passed before the CLI arguments')

  // npm's own shim assigns its node and its script to variables first. The
  // script it runs last is the target, not the node it assigns first.
  const assignedShim = join(shimDir, 'assigned.cmd')
  writeFileSync(
    assignedShim,
    `@ECHO off\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nSET "PREFIX_JS=%~dp0\\inner.mjs"\r\nSET "CLI_JS=%~dp0\\inner.mjs"\r\n"%NODE_EXE%" "%CLI_JS%" %*\r\n`,
  )
  const assignedResolved = resolveWindowsShim(assignedShim)
  assertEqual(assignedResolved.prefix, [inner], 'an assigned script is the target, not the assigned node')
  assertEqual(assignedResolved.bin, process.execPath, 'an assigned script runs under node')

  // A bare name must be found on PATH the way a shell would find it.
  const savedPath = process.env.PATH
  process.env.PATH = `${shimDir}${delimiter}${savedPath}`
  try {
    const shimmed = mount({
      providers: { opencode: { bin: 'mytool', buildArgs: () => ['ARGS & echo injected'] }, grok: false, codex: false },
    })
    const shimTurn = await drain(shimmed.adapter, turn('opencode', 'm'))
    assertEqual(textOf(shimTurn), 'SHIM-ARGS & echo injected', 'the whole prompt reaches the CLI as one argument')
    assertEqual(shimTurn.error, null, 'a shimmed turn does not fail')
    assertEqual(shimmed.adapter.ledger.summary().recent[0].ok, true, 'the shimmed turn is ledgered')
  } finally {
    process.env.PATH = savedPath
  }
} else {
  assertEqual(resolveWindowsShim('/usr/bin/env'), { bin: '/usr/bin/env', prefix: [] }, 'a non-Windows path is left alone')
}

// Text already emitted does not turn a subsequent process/provider failure into success.
for (const [label, tail] of [
  ['exit', "process.stderr.write('late failure');process.exit(7)"],
  ['event', "console.log(JSON.stringify({type:'error',message:'late failure'}))"],
]) {
  setCli('opencode.mjs', `console.log(JSON.stringify({type:'text',part:{text:'partial'}}));${tail}`)
  const failed = await drain(adapter, turn('opencode', 'm'))
  assertMatch(failed.error ?? '', /late failure/, `partial text cannot hide a late ${label} failure`)
  assertEqual(adapter.ledger.summary().recent[0].ok, false, `late ${label} failure is ledgered`)
}

// An already-cancelled call must never start a CLI, and cancellation is ledgered.
const controller = new AbortController()
controller.abort()
let resolvedAfterAbort=false
adapter.config.resolveCwd=()=>{resolvedAfterAbort=true;return root}
const preAborted = await drain(adapter, { ...turn('opencode', 'm'), signal: controller.signal })
assertEqual(resolvedAfterAbort,false,'an already aborted call does not resolve a workspace')
adapter.config.resolveCwd=undefined
assertEqual(preAborted.chunks.at(-1)?.reason?.kind, 'aborted', 'an already aborted call finishes aborted')
assertEqual(textOf(preAborted), '', 'an already aborted call runs no CLI')
assertEqual(adapter.ledger.summary().recent[0].ok, false, 'an already aborted call is ledgered as failed')

const during = new AbortController()
const turnsBeforeCancel = adapter.ledger.summary().turns
setCli('opencode.mjs', "console.log(JSON.stringify({type:'text',part:{text:'partial'}}));setTimeout(()=>{},60000)")
setTimeout(() => during.abort(), 250)
const cancelled = await drain(adapter, { ...turn('opencode', 'm'), signal: during.signal })
assertEqual(cancelled.chunks.at(-1)?.reason?.kind, 'aborted', 'a running call can be cancelled')
assertEqual(adapter.ledger.summary().turns, turnsBeforeCancel + 1, 'running cancellation creates its own ledger entry')
assertEqual(adapter.ledger.summary().recent[0].error, 'the request was aborted', 'running cancellation records its reason')

setCli('opencode.mjs', "console.log(JSON.stringify({type:'text',part:{text:'partial'}}));setTimeout(()=>{},1000)")
const bounded = mount({ timeoutMs: 200, providers: {
  opencode: { bin: process.execPath, timeoutMs: 0, buildArgs: () => [join(root, 'opencode.mjs')] }, grok: false, codex: false,
} })
const invalidTimeout = await drain(bounded.adapter, turn('opencode', 'm'))
assertMatch(invalidTimeout.error ?? '', /timed out after 200 ms/, 'an invalid route timeout falls back to the finite mount timeout')
const invalidMount = mount({ timeoutMs: 0, providers: { grok: false, codex: false } })
assert(invalidMount.adapter.config.timeoutMs > 0, 'zero cannot disable the mount timeout')
rmSync(bounded.root, { recursive: true, force: true })
rmSync(invalidMount.root, { recursive: true, force: true })

rmSync(root, { recursive: true, force: true })
rmSync(slow.root, { recursive: true, force: true })
rmSync(badCwd.root, { recursive: true, force: true })
console.log('ok  failures.test')
