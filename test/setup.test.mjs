import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount, turn, drain, textOf } from './_harness.mjs'
import { assert, assertEqual, assertMatch } from './_assert.mjs'

const m=mount({providers:{grok:false,codex:false,opencode:{bin:'missing-test-cli'}}})
const cli=join(m.root,'installed.mjs'),installer=join(m.root,'installer.mjs'),count=join(m.root,'installs')
writeFileSync(installer,`import{writeFileSync,appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(count)},'1');writeFileSync(${JSON.stringify(cli)},${JSON.stringify("if(process.argv.includes('--version'))console.log('fixture 1.0');else if(process.argv.includes('status'))console.log('logged in');else console.log(JSON.stringify({type:'text',part:{text:'INSTALLED_OK'}}))")})`)
m.adapter.config.providers.opencode.installCommand={bin:process.execPath,args:[installer],binPath:process.execPath,binArgs:[cli]}
m.adapter.config.providers.opencode.buildArgs=()=>[]
m.adapter.config.providers.opencode.statusArgs=['status']
m.adapter.config.providers.opencode.signedIn=t=>t.includes('logged in')
assertEqual(m.adapter.setup.status('opencode').installed,false,'a missing CLI is reported accurately')
await Promise.all([m.adapter.setup.ensure('opencode'),m.adapter.setup.ensure('opencode')])
assert(existsSync(cli),'installation really creates the executable entrypoint')
assertEqual(m.adapter.setup.status('opencode').installed,true,'the installed launch target is adopted')
assertEqual((await m.adapter.signIn.status('opencode')).signedIn,true,'authentication uses the installed launch target')
assertEqual(textOf(await drain(m.adapter,turn('opencode','m'))),'INSTALLED_OK','the route works immediately without restarting')
const {readFileSync}=await import('node:fs')
assertEqual(readFileSync(count,'utf8'),'1','concurrent requests share one install')

const refused=mount({autoInstall:false,providers:{grok:false,codex:false,opencode:{bin:'missing-test-cli'}}})
assertMatch((await drain(refused.adapter,turn('opencode','m'))).error,/not installed|autoInstall/,'disabled automatic installation fails explicitly')
assertEqual(existsSync(join(refused.root,'ledger.json')),true,'a refused turn records failure in the isolated ledger')

const setup=m.webRoutes.find(r=>r.path==='/llm-cli/setup.json'),action=m.webRoutes.find(r=>r.path==='/llm-cli/setup')
assert(setup&&action,'setup status and actions are registered')
async function call(route,{address='127.0.0.1',method='GET',body='',token}={}){
 const response={status:0,body:'',writeHead(code){this.status=code},end(value){this.body=String(value)}}
 await route.handler({url:route.path,method,body,headers:{'x-llm-cli-setup':token},socket:{remoteAddress:address}},response)
 return response
}
const local=await call(setup),view=JSON.parse(local.body)
assertEqual(local.status,200,'local setup status is available')
assert(view.actionToken,'setup actions have a token')
assertEqual((await call(setup,{address:'192.0.2.2'})).status,403,'remote readers cannot obtain the action token')
assertEqual((await call(action,{method:'POST',body:JSON.stringify({provider:'opencode',action:'signin'})})).status,403,'actions without a token are refused')
assertEqual((await call(action,{method:'POST',token:view.actionToken,body:JSON.stringify({provider:'opencode',action:'signin'})})).status,200,'an authenticated account is reused')
assertEqual((await call(action,{method:'POST',token:view.actionToken,body:JSON.stringify({provider:'unknown',action:'install'})})).status,400,'unknown providers fail without installing anything')
assertEqual((await call(action,{method:'POST',address:'192.0.2.2',token:view.actionToken,body:JSON.stringify({provider:'opencode',action:'install'})})).status,403,'a remote action is refused even with a token')
assertEqual((await call(action,{token:view.actionToken})).status,405,'setup changes require POST')
assertEqual((await call(action,{method:'POST',token:view.actionToken,body:JSON.stringify({provider:'__proto__',action:'install'})})).status,400,'prototype keys cannot select installer routes')

const broken=mount({providers:{grok:false,codex:false,opencode:{bin:'missing-test-cli',installCommand:{bin:process.execPath,args:['-e','process.exit(9)'],binPath:process.execPath}}}})
let error
try{await broken.adapter.setup.ensure('opencode')}catch(e){error=e.message}
assertMatch(error,/installation failed.*9/,'installation refusal is reported accurately')
assertEqual(broken.adapter.setup.status('opencode').installed,false,'a failed installer does not mark the CLI installed')
assertEqual(broken.adapter.setup.pending.size,0,'a failed install releases its in-flight slot')

const invalidVersion=join(m.root,'invalid-version.mjs')
writeFileSync(invalidVersion,'process.exit(2)')
const invalid=mount({providers:{grok:false,codex:false,opencode:{bin:'missing-test-cli',installCommand:{bin:process.execPath,args:['-e','process.exit(0)'],binPath:process.execPath,binArgs:[invalidVersion]}}}})
try{await invalid.adapter.setup.ensure('opencode')}catch(e){error=e.message}
assertMatch(error,/version check/,'a failed post-install version check is surfaced')
assertEqual(invalid.adapter.setup.status('opencode').installed,false,'an unusable new binary is rolled back')
console.log('ok  setup.test')
