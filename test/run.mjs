/**
 * Test runner: runs every `test/*.test.mjs` in its own process (so module-level
 * state such as model caches cannot leak between suites) and reports a summary.
 *
 * Usage: npm test
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()

const failures = []
for (const file of files) {
  process.stdout.write(`\n--- ${file}\n`)
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failures.push(file)
}

process.stdout.write(`\n${files.length - failures.length}/${files.length} suites passed\n`)
if (failures.length > 0) {
  process.stdout.write(`failed: ${failures.join(', ')}\n`)
  process.exit(1)
}
