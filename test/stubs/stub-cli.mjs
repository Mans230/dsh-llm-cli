/**
 * A fake agent CLI for the test suite. It mimics the shapes the adapter parses,
 * so the tests never need a real CLI, a network, or an account.
 *
 * Commands:
 *   login    device-code prompt, then "approves" after 5s (writes the flag)
 *   models   reports signed-in/out based on the flag (Grok-shaped output)
 *   stream   one OpenCode-shaped NDJSON turn
 *   codex    one Codex-shaped JSONL turn
 *   fail     a non-zero exit with an auth error on stderr
 */
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const flag = process.env.STUB_FLAG ?? join(here, '.stub-signed-in')
const cmd = process.argv[2]

if (cmd === 'login') {
  process.stderr.write(
    '\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=TEST-1234\n\nConfirm this code in your browser:\n\n  TEST-1234\n\nWaiting for authorization...\n',
  )
  setTimeout(() => {
    writeFileSync(flag, '1')
    process.exit(0)
  }, 5000)
} else if (cmd === 'stream') {
  process.stdout.write(
    [
      '{"type":"step_start","part":{"id":"s1"}}',
      '{"type":"text","part":{"text":"LEDGER-OK"}}',
      '{"type":"step_finish","part":{"tokens":{"input":1000,"output":20,"reasoning":7,"cache":{"read":500,"write":0}},"cost":0.0012}}',
    ].join('\n') + '\n',
  )
  process.exit(0)
} else if (cmd === 'codex') {
  process.stdout.write(
    [
      '{"type":"thread.started","thread_id":"stub"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"CODEX-OK"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":500,"output_tokens":20,"reasoning_output_tokens":7}}',
    ].join('\n') + '\n',
  )
  process.exit(0)
} else if (cmd === 'fail') {
  process.stderr.write('Error: not authenticated. Run grok login to continue.\n')
  process.exit(1)
} else if (cmd === 'models') {
  if (existsSync(flag)) {
    process.stdout.write('You are logged in with grok.com.\n\nDefault model: grok-4.7\n')
    process.exit(0)
  }
  process.stdout.write('You are not authenticated.\n\nDefault model: grok-4.6\n')
  process.exit(1)
} else {
  process.stderr.write(`stub: unknown command ${cmd}\n`)
  process.exit(2)
}
