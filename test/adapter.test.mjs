/**
 * Adapter test: registration, the Codex model catalog reader, and a real
 * `codex exec --json` turn parsed from a stub CLI (no account, no network).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { assert, assertEqual } from './_assert.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const stub = join(here, 'stubs', 'stub-cli.mjs')
const scratch = join(tmpdir(), `dsh-llm-cli-adapter-${process.pid}`)
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

// A synthetic Codex catalog: three offered models, one hidden from the picker.
const cache = join(scratch, 'models_cache.json')
writeFileSync(
  cache,
  JSON.stringify({
    models: [
      { slug: 'gpt-6.1-sol', visibility: 'list', display_name: 'GPT-6.1-Sol' },
      { slug: 'gpt-6-astra', visibility: 'list', display_name: 'GPT-6-Astra' },
      { slug: 'gpt-5.6-luna', visibility: 'list', display_name: 'GPT-5.6-Luna' },
      { slug: 'codex-auto-review', visibility: 'hide', display_name: 'Codex Auto Review' },
    ],
  }),
  'utf8',
)

let adapter
let routeNames
apply(
  {
    logger: { info() {}, warn() {} },
    llm: { registerAdapter: (routes, value) => { routeNames = routes; adapter = value } },
    inject: (_deps, cb) => cb({ tools: { register() {} }, webServer: { register: () => () => {} }, effect() {} }),
    effect() {},
  },
  {
    cwd: here,
    providers: {
      codex: { bin: process.execPath, buildArgs: () => [stub, 'codex'], modelsCacheFile: cache },
      grok: false,
      opencode: false,
    },
  },
)

assertEqual(routeNames, ['codex'], 'only the configured route is registered')
assertEqual(adapter.providerInfo('codex').name, 'Codex (CLI)', 'provider info carries the display name')

assertEqual(
  (await adapter.listModels('codex')).map((model) => model.id),
  ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-luna'],
  'the Codex catalog is read and hidden entries are skipped',
)

const resolved = await adapter.resolveModel('codex', 'gpt-6.1-sol')
assert(resolved && typeof resolved === 'object', 'resolveModel returns metadata')

const chunks = []
for await (const chunk of adapter.stream({
  provider: 'codex',
  model: 'gpt-6.1-sol',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
})) {
  chunks.push(chunk)
}
assertEqual(
  chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
  'CODEX-OK',
  'a codex --json turn is parsed into text',
)
assertEqual(
  chunks.find((c) => c.type === 'usage')?.usage,
  { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 0, reasoningTokens: 7, totalTokens: 1020 },
  'codex usage is mapped onto the harness vocabulary',
)

rmSync(scratch, { recursive: true, force: true })
console.log('ok  adapter.test')
