/**
 * Failure-path tests. Every case here used to end in a misleading success, a
 * misleading error, or a malformed stream.
 */
import { rmSync } from 'node:fs'
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

rmSync(root, { recursive: true, force: true })
rmSync(slow.root, { recursive: true, force: true })
rmSync(badCwd.root, { recursive: true, force: true })
console.log('ok  failures.test')
