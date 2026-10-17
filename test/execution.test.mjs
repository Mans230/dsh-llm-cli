import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount, drain, turn, textOf } from './_harness.mjs'
import { assert, assertEqual, assertMatch } from './_assert.mjs'

const probe = mount({providers:{grok:false,opencode:false,codex:{bin:process.execPath}}})
const route = probe.adapter.config.providers.codex
for (const sandbox of ['read-only','workspace-write']) {
  const args = route.buildArgs('m','hello',undefined,{sandbox})
  assertEqual(args[args.indexOf('-s')+1],sandbox,'sandbox reaches the real default argument builder')
  const fileArgs=route.buildArgs('m','hello','transcript.txt',{sandbox})
  assertEqual(fileArgs[fileArgs.indexOf('-s')+1],sandbox,'file prompts retain the sandbox')
}
assertMatch((()=>{try{mount({providers:{codex:{sandbox:'danger-full-access'}}})}catch(e){return e.message}})(),/sandbox/,'unsupported sandbox values are rejected')

const first=join(probe.root,'first'),second=join(probe.root,'second')
mkdirSync(first);mkdirSync(second)
const file=join(probe.root,'cli.mjs')
writeFileSync(file,`import {writeFileSync} from 'node:fs';writeFileSync('created.txt','ok');console.log(JSON.stringify({type:'text',part:{text:process.cwd()+'|'+process.argv[2]}}))`)
const sessions={get:(id)=>id==='a'?{header:{cwd:first}}:id==='b'?{header:{cwd:second}}:undefined}
const m=mount({providers:{opencode:{bin:process.execPath,buildArgs:(_m,p)=>[file,p]},grok:false,codex:false}}, {sessions})
const [a,b]=await Promise.all(['a','b'].map(sessionId=>drain(m.adapter,{...turn('opencode','m'),sessionId})))
assert(textOf(a).startsWith(first+'|'),'first session uses its own workspace')
assert(textOf(b).startsWith(second+'|'),'second session uses its own workspace')
assert(existsSync(join(first,'created.txt'))&&existsSync(join(second,'created.txt')),'children write in separate session workspaces')
assert(!existsSync(join(m.root,'created.txt')),'session calls do not write in the global fallback')
const unknown=await drain(m.adapter,{...turn('opencode','m'),sessionId:'missing'})
assertMatch(unknown.error,/workspace is unavailable/,'an unknown session does not silently use global cwd')

const instructions='DSH_SYSTEM_SENTINEL'
const forwarded=await drain(m.adapter,{...turn('opencode','m'),sessionId:'a',system:instructions})
assert(textOf(forwarded).includes(instructions),'system instructions are forwarded by default')
const optedOut=mount({includeSystemPrompt:false,providers:{opencode:{bin:process.execPath,buildArgs:(_m,p)=>[file,p]},grok:false,codex:false}})
assert(!textOf(await drain(optedOut.adapter,{...turn('opencode','m'),system:instructions})).includes(instructions),'explicit system opt-out is respected')

// Leave the child running after its first delta; awaiting that delta must finish
// before the child exits. This detects buffering in the adapter, without timing guesses.
const liveFile=join(m.root,'live.mjs')
const marker=join(m.root,'exited.txt')
writeFileSync(liveFile,`import {writeFileSync} from 'node:fs';console.log(JSON.stringify({type:'text',part:{text:'FIRST'}}));setTimeout(()=>{writeFileSync(${JSON.stringify(marker)},'exited');process.exit(0)},2000)`)
m.adapter.config.providers.opencode.buildArgs=()=>[liveFile]
let sawEarly=false
for await (const chunk of m.adapter.stream(turn('opencode','m'))) {
  if(chunk.type==='text-delta'){sawEarly=!existsSync(marker);assertEqual(chunk.text,'FIRST','first delta is intact')}
}
assert(sawEarly,'a text delta arrives before the child exits')
assertEqual(readFileSync(marker,'utf8'),'exited','the child subsequently exited')
console.log('ok  execution.test')
