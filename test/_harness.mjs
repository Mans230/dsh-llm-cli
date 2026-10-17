/**
 * Shared mount for suites that drive the adapter. Every mount gets its own
 * scratch directory and its own ledger, so a test run can never write into the
 * ledger a live harness is using.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

export function mount(config = {}, services = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-llm-cli-test-'))
  const usageFile = join(root, 'ledger.json')
  let adapter
  let routes
  const webRoutes = []
  const logs = []
  apply(
    {
      ...services,
      logger: { info(message) { logs.push(message) }, warn(message) { logs.push(message) } },
      llm: { registerAdapter: (names, value) => { routes = names; adapter = value } },
      inject: (_deps, cb) =>
        cb({
          tools: { register() {} },
          webServer: {
            register: (route) => {
              webRoutes.push(route)
              return () => {}
            },
          },
          effect() {},
        }),
      effect() {},
    },
    { cwd: root, usageFile, ...config },
  )
  return { adapter, routes, root, usageFile, webRoutes, logs }
}

/** Write a throwaway CLI and return its path. */
export function writeCli(root, name, source) {
  const file = join(root, name)
  writeFileSync(file, source, 'utf8')
  return file
}

/** Run one turn, collecting chunks and the thrown message if the turn failed. */
export async function drain(adapter, options) {
  const chunks = []
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    return { chunks, error: null }
  } catch (error) {
    return { chunks, error: error.message }
  }
}

/** The text a turn produced. */
export function textOf(result) {
  return result.chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
}

/** A one-message turn, the shape the harness sends. */
export function turn(provider, model, content = 'hello') {
  return { provider, model, messages: [{ role: 'user', content }] }
}
