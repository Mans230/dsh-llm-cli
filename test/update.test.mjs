/**
 * Update tests. Nothing here reaches the network: the version source is a local
 * server, and the install command is a stub binary or a real local git remote.
 */
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { UpdateManager, compareVersions, detectInstall, updateCommand } from '../index.js'
import { mount } from './_harness.mjs'
import { assert, assertEqual, assertMatch } from './_assert.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-llm-cli-update-'))

// --- 1. Version comparison.
assertEqual(compareVersions('0.7.0', '0.6.0'), 1, 'a higher minor version is newer')
assertEqual(compareVersions('0.6.0', '0.6.0'), 0, 'equal versions match')
assertEqual(compareVersions('0.6.0', '0.6.1'), -1, 'a higher patch is newer')
assertEqual(compareVersions('1.0.0', '0.9.9'), 1, 'the major version dominates')
assertEqual(compareVersions('0.6.0-beta.1', '0.6.0'), 0, 'a suffix does not make a version newer')

// --- 2. How this copy was installed decides how it can be updated.
const profileDir = join(root, 'profile')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify({ name: 'dsh-profile-x', dsh: { profile: { bundles: ['dsh-llm-cli'] } }, dependencies: { 'dsh-llm-cli': 'github:Mans230/dsh-llm-cli' } }),
)
const asDependency = detectInstall(join(profileDir, 'node_modules', 'dsh-llm-cli'), profileDir)
assertEqual(asDependency.method, 'npm', 'a profile dependency is updated with npm')
assertEqual(asDependency.spec, 'github:Mans230/dsh-llm-cli', 'the spec the profile declares is reused')
assertEqual(updateCommand(asDependency).args[0], 'install', 'the npm command installs')

const bareProfile = join(root, 'profile-bare')
mkdirSync(join(bareProfile, 'node_modules'), { recursive: true })
writeFileSync(join(bareProfile, 'package.json'), JSON.stringify({ dsh: { profile: {} } }))
assertEqual(detectInstall(join(bareProfile, 'node_modules', 'dsh-llm-cli'), bareProfile).method, 'unknown', 'a profile with no dependency and no link is unknown')

const looseCheckout = join(root, 'checkout')
mkdirSync(join(looseCheckout, '.git'), { recursive: true })
assertEqual(detectInstall(looseCheckout, root).method, 'git', 'a git checkout is updated with git')
assertEqual(updateCommand({ method: 'git', dir: looseCheckout }).args.slice(0, 3).join(' '), `-C ${looseCheckout} pull`, 'the git command pulls')
assertEqual(updateCommand({ method: 'unknown' }), null, 'an unknown install has no command')

// --- 3. A real pull updates a real checkout, offline.
const remoteDir = join(root, 'remote.git')
const sourceDir = join(root, 'source')
const workDir = join(root, 'work')
execFileSync('git', ['init', '--bare', '-b', 'main', remoteDir], { stdio: 'pipe' })
execFileSync('git', ['init', '-b', 'main', sourceDir], { stdio: 'pipe' })
execFileSync('git', ['-C', sourceDir, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' })
execFileSync('git', ['-C', sourceDir, 'config', 'user.name', 'test'], { stdio: 'pipe' })
writeFileSync(join(sourceDir, 'version.txt'), '0.6.0')
execFileSync('git', ['-C', sourceDir, 'add', '.'], { stdio: 'pipe' })
execFileSync('git', ['-C', sourceDir, 'commit', '-m', 'first'], { stdio: 'pipe' })
execFileSync('git', ['-C', sourceDir, 'branch', '-M', 'main'], { stdio: 'pipe' })
execFileSync('git', ['-C', sourceDir, 'remote', 'add', 'origin', remoteDir], { stdio: 'pipe' })
execFileSync('git', ['-C', sourceDir, 'push', '-u', 'origin', 'main'], { stdio: 'pipe' })
execFileSync('git', ['clone', remoteDir, workDir], { stdio: 'pipe' })
assertEqual(readFileSync(join(workDir, 'version.txt'), 'utf8'), '0.6.0', 'the checkout starts at the old version')

writeFileSync(join(sourceDir, 'version.txt'), '0.7.0')
execFileSync('git', ['-C', sourceDir, 'commit', '-am', 'bump'], { stdio: 'pipe' })
execFileSync('git', ['-C', sourceDir, 'push'], { stdio: 'pipe' })

const pulled = await new UpdateManager(
  { updateSource: 'http://127.0.0.1:1/none', autoUpdate: false },
  { install: { method: 'git', dir: workDir } },
).apply()
assertEqual(pulled.ok, true, `the git update succeeds (got: ${pulled.output})`)
assertEqual(readFileSync(join(workDir, 'version.txt'), 'utf8'), '0.7.0', 'the checkout is at the new version')

// --- 4. The npm command runs and its output is captured, with a stub npm. The
// stub fails twice so the fallback chain is exercised, and succeeds on the
// tarball, which is what a host without a GitHub key needs.
const binDir = join(root, 'bin')
mkdirSync(binDir, { recursive: true })
const marker = join(root, 'npm-args.txt')
writeFileSync(
  join(binDir, 'stub-npm.mjs'),
  `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2).join(' ')
appendFileSync(process.env.STUB_MARKER, args + '\\n')
process.stdout.write('stub npm ran: ' + args + '\\n')
process.exit(args.includes('tarball') ? 0 : 1)
`,
)
writeFileSync(join(binDir, 'npm.cmd'), '@echo off\r\nnode "%~dp0stub-npm.mjs" %*\r\n')
writeFileSync(join(binDir, 'npm'), '#!/bin/sh\nexec node "$(dirname "$0")/stub-npm.mjs" "$@"\n')
chmodSync(join(binDir, 'npm'), 0o755)

const savedPath = process.env.PATH
const savedMarker = process.env.STUB_MARKER
process.env.PATH = `${binDir}${delimiter}${savedPath}`
process.env.STUB_MARKER = marker
try {
  const npmRun = await new UpdateManager(
    { updateSource: 'http://127.0.0.1:1/none', autoUpdate: false },
    { install: { method: 'npm', dir: profileDir, spec: 'github:Mans230/dsh-llm-cli' } },
  ).apply()
  assertEqual(npmRun.ok, true, `the npm update succeeds on the tarball attempt (got: ${npmRun.output})`)
  const attempts = readFileSync(marker, 'utf8').trim().split('\n')
  assertEqual(attempts.length, 3, 'three attempts are made before giving up on git')
  assertMatch(attempts[0], /^install github:Mans230\/dsh-llm-cli$/, 'the declared spec is tried first')
  assertMatch(attempts[1], /^install git\+https:\/\/github\.com\/Mans230\/dsh-llm-cli\.git$/, 'then the https git URL')
  assertMatch(attempts[2], /^install https:\/\/github\.com\/Mans230\/dsh-llm-cli\/tarball\/HEAD$/, 'then the tarball, which needs no git')
  assertMatch(npmRun.command, /tarball/, 'the reported command names what worked')
  assertMatch(npmRun.output, /stub npm ran/, 'the command output is captured for the page')
} finally {
  process.env.PATH = savedPath
  process.env.STUB_MARKER = savedMarker
}

// --- 5. A check reads a version from a real server and compares it.
const versionServer = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ version: '9.9.9' }))
})
await new Promise((resolve) => versionServer.listen(0, '127.0.0.1', resolve))
const source = `http://127.0.0.1:${versionServer.address().port}/package.json`

const overriddenSource = new UpdateManager({}, { source, install: { method: 'unknown', dir: root } })
const overriddenCheck = await overriddenSource.check()
assertEqual(overriddenCheck.source, source, 'update status identifies the source actually fetched')
assertEqual(overriddenCheck.latest, '9.9.9', 'the source option is actually fetched')
let defaultSource
try { defaultSource = new UpdateManager().status().source } catch { /* asserted below */ }
assertEqual(typeof defaultSource, 'string', 'a default update manager exposes its effective source')

const manager = new UpdateManager({ updateSource: source, autoUpdate: false }, { install: { method: 'unknown', dir: root } })
const checked = await manager.check({ force: true })
assertEqual(checked.latest, '9.9.9', 'the published version is read')
assertEqual(checked.updateAvailable, true, 'a newer version is offered')
assertEqual(checked.canApply, false, 'an unknown install cannot be updated in place')
assertMatch(checked.note, /by hand/, 'the status says what to do instead')
assertEqual(manager.status().checkedAt > 0, true, 'the check records when it ran')

const cached = await manager.check()
assertEqual(cached.latest, '9.9.9', 'a recent result is reused')

const failing = new UpdateManager({ updateSource: 'http://127.0.0.1:1/none', autoUpdate: false }, { install: { method: 'unknown', dir: root } })
const failed = await failing.check({ force: true })
assertEqual(failed.latest, null, 'an unreachable source yields no version')
assert(failed.error.length > 0, 'the failure is reported rather than swallowed')

// --- 6. The endpoints answer this machine only, and need a token to update.
// The install is a second local clone, so the accepted POST performs a real
// pull without touching this repository or the network.
const applyDir = join(root, 'apply-here')
execFileSync('git', ['clone', remoteDir, applyDir], { stdio: 'pipe' })
writeFileSync(join(sourceDir, 'version.txt'), '0.8.0')
execFileSync('git', ['-C', sourceDir, 'commit', '-am', 'bump again'], { stdio: 'pipe' })
execFileSync('git', ['-C', sourceDir, 'push'], { stdio: 'pipe' })

const { root: mountRoot, webRoutes } = mount({
  cwd: root,
  updateSource: source,
  updateInstall: { method: 'git', dir: applyDir },
  providers: { grok: { bin: process.execPath, statusArgs: ['-e', 'process.exit(0)'], models: ['grok-4.7'] }, opencode: false, codex: false },
})
const updateRoutes = webRoutes.filter((route) => route.path.startsWith('/llm-cli/update'))
assertEqual(updateRoutes.length, 2, 'both update routes are registered')

function fakeResponse() {
  return {
    status: null,
    body: '',
    written: {},
    writeHead(status) {
      this.status = status
    },
    setHeader(name, value) {
      this.written[name] = value
    },
    end(body) {
      this.body = String(body ?? '')
    },
  }
}
const call = async (route, request) => {
  const response = fakeResponse()
  await route.handler(request, response)
  return response
}
const statusRoute = updateRoutes.find((route) => route.path === '/llm-cli/update.json')
const applyRoute = updateRoutes.find((route) => route.path === '/llm-cli/update')
const request = (url, { address = '127.0.0.1', method = 'GET', headers = {}, body } = {}) => ({
  url,
  method,
  headers,
  body,
  socket: { remoteAddress: address },
})

const rejected = await call(statusRoute, request('/llm-cli/update.json', { address: '10.0.0.9' }))
assertEqual(rejected.status, 403, 'the update status never answers another machine')

const status = await call(statusRoute, request('/llm-cli/update.json?force=1'))
assertEqual(status.status, 200, 'a loopback status request is served')
const payload = JSON.parse(status.body)
assertEqual(payload.latest, '9.9.9', 'the status carries the published version')
assert(payload.actionToken, 'the status carries an action token')

const noMethod = await call(applyRoute, request('/llm-cli/update'))
assertEqual(noMethod.status, 405, 'a GET cannot update')

const wrongToken = await call(applyRoute, request('/llm-cli/update', { method: 'POST', headers: { accept: 'application/json' }, body: 'token=wrong' }))
assertEqual(wrongToken.status, 403, 'a form post without the token is refused')

const remoteApply = await call(
  applyRoute,
  request('/llm-cli/update', {
    address: '10.0.0.9',
    method: 'POST',
    headers: { accept: 'application/json', 'x-llm-cli-update': payload.actionToken },
    body: '',
  }),
)
assertEqual(remoteApply.status, 403, 'even the right token does not let another machine update')

const applied = await call(
  applyRoute,
  request('/llm-cli/update', { method: 'POST', headers: { accept: 'application/json', 'x-llm-cli-update': payload.actionToken }, body: '' }),
)
assertEqual(applied.status, 200, 'a loopback update with the token is accepted')
const appliedBody = JSON.parse(applied.body)
assertEqual(appliedBody.ok, true, `the update ran (got: ${appliedBody.output})`)
assertEqual(appliedBody.restartRequired, true, 'the caller is told a restart is needed')
assertEqual(readFileSync(join(applyDir, 'version.txt'), 'utf8'), '0.8.0', 'the configured install was actually updated')
assertEqual(appliedBody.status.checkedAt, 0, 'the cached version is dropped after an update')

versionServer.close()
rmSync(root, { recursive: true, force: true })
rmSync(mountRoot, { recursive: true, force: true })
console.log('ok  update.test')
