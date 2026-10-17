/**
 * Contract test: the package manifest and both halves' public surface, so a
 * rename or a dropped export fails loudly instead of only in the harness.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as host from '../index.js'
import { assert, assertEqual } from './_assert.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

assertEqual(pkg.name, 'dsh-llm-cli', 'package name')
assertEqual(pkg.type, 'module', 'package is ESM')
assertEqual(pkg.license, 'MIT', 'license')
assertEqual(pkg.main, 'index.js', 'main entry')
assertEqual(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'bundle patch is declared')
assertEqual(pkg.dsh?.client?.platform, 'web', 'client half is declared for the web platform')
assertEqual(pkg.exports?.['./client'], './client.js', 'client export is declared')

for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  assert(existsSync(join(root, file)), `${file} is present`)
}

assertEqual(host.name, 'llm-cli', 'host plugin name')
assertEqual(host.inject, ['llm'], 'host injects the llm service')
for (const symbol of [
  'apply',
  'buildTools',
  'SignInManager',
  'UsageLedger',
  'parseDeviceInfo',
  'readGrokCliUsage',
  'readGrokModelLimits',
  'readCodexCliUsage',
  'readCodexModelList',
  'windowCliUsage',
  'windowGrokUsage',
  'renderUsageHtml',
]) {
  assertEqual(typeof host[symbol], 'function', `host exports ${symbol}()`)
}

console.log('ok  contract.test')
