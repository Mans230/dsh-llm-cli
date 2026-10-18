// Executable audit probes. Every mount explicitly isolates its ledger.
import * as fs from 'node:fs'
import { join, dirname, delimiter, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { redPng } from './_image.mjs'
import assert from 'node:assert/strict'
import * as host from '../index.js'
import { mount, drain, turn, writeCli, textOf } from './_harness.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = process.env.AUDIT_DIR || join(tmpdir(), 'dsh-llm-cli-audit-20261017')
fs.mkdirSync(evidence, { recursive: true })
const live = join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'llm-cli-usage.json')
const mode = process.argv[2] || 'probes'
const log = (value) => { const line = typeof value === 'string' ? value : JSON.stringify(value); console.log(line); fs.appendFileSync(join(evidence, `${mode}.log`), line + '\n') }
const absent = () => { assert(!fs.existsSync(live), 'LIVE LEDGER MUST BE ABSENT'); log('LIVE LEDGER ABSENT') }
const scratch = () => fs.mkdtempSync(join(tmpdir(), 'dsh-audit-probe-'))
function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { cwd: repo, encoding: 'utf8', timeout: 180000, windowsHide: true, ...options })
  log({ command: [bin, ...args], cwd: options.cwd || repo, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr })
  return result
}
async function check(label, run) {
  try { const detail = await run(); log({ check: label, result: 'PASS', detail }) }
  catch (error) { log({ check: label, result: 'FAIL', error: error.stack }); process.exitCode = 1 }
}
absent()

if(mode === 'setup-real'){
  const root=scratch(),m=mount({cliInstallDir:join(root,'clis')})
  for(const provider of ['codex','opencode','grok']){
    const route=m.adapter.config.providers[provider]
    route.bin='missing-setup-probe-'+provider;route.binArgs=[];route.binExplicit=false;delete route.launchError
    await check('actual isolated installation and authentication: '+provider,async()=>{
      const installed=await m.adapter.setup.ensure(provider)
      const version=command(route.bin,[...route.binArgs,'--version'],{timeout:30000})
      assert.equal(version.status,0)
      const auth=await m.adapter.signIn.status(provider)
      return{installed:installed.installed,version:version.stdout.trim(),signedIn:auth.signedIn,credentialsReplaced:false}
    })
  }
}

if(mode === 'signin-real'){
  const m=mount(),profile=scratch()
  // This entire probe runs in its own process. No real credential file is moved.
  Object.assign(process.env,{USERPROFILE:profile,HOME:profile,CODEX_HOME:join(profile,'.codex'),XDG_DATA_HOME:join(profile,'data'),XDG_CONFIG_HOME:join(profile,'config'),XDG_CACHE_HOME:join(profile,'cache'),XDG_STATE_HOME:join(profile,'state')})
  fs.mkdirSync(process.env.CODEX_HOME,{recursive:true})
  for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','XAI_API_KEY','GROK_DEPLOYMENT_KEY'])delete process.env[key]
  for(const provider of ['codex','grok','opencode']){
    const route={...m.adapter.config.providers[provider]}
    if(provider==='opencode'){route.statusArgs=['auth','list','--standalone'];route.loginArgs=['auth','login','opencode','--method','device','--standalone']}
    const manager=new host.SignInManager({cwd:profile,signInTtlMs:30000,providers:{[provider]:route}})
    await check('real isolated device flow: '+provider,async()=>{
      const before=await manager.status(provider)
      if(before.signedIn)return{unverified:'CLI still sees an existing account; no reauthentication attempted'}
      try{
        const started=await manager.start(provider)
        assert(started.url&&started.code,'a real device URL and code are required')
        return{signedInBefore:false,urlHost:started.url?new URL(started.url).host:null,deviceCodePresent:!!started.code,browserApproval:'UNVERIFIED',credentialFilesCopied:false}
      }finally{const entry=manager.pending.get(provider);manager.cancel(provider);if(entry)await entry.done}
    })
  }
}

if(mode === 'runtime'){
  assert(process.env.DSH_RUNTIME_DIR,'set DSH_RUNTIME_DIR to an isolated install of the published DSH services')
  const req=createRequire(join(process.env.DSH_RUNTIME_DIR,'package.json'))
  const {Context}=await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const {LlmService}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href)
  const root=scratch(),ctx=new Context(),service=ctx.plugin(LlmService)
  const mounted=ctx.plugin(host,{cwd:root,usageFile:join(root,'ledger.json'),timeoutMs:45000})
  await new Promise(r=>setTimeout(r,100))
  try{
    for(const provider of ['opencode','grok','codex']){
      const models=await ctx.llm.listModels(provider)
      assert(models.length>0)
      const model=models[0].id,info=await ctx.llm.resolveModelInfo(provider,model)
      assert(info.context.contextWindow>0)
      const result=await drain(ctx.llm,turn(provider,model,'Reply exactly RUNTIME_OK. Do not use tools or inspect files.'))
      const usage=result.chunks.find(chunk=>chunk.type==='usage')?.usage
      if(provider==='codex'&&usage?.totalTokens)assert.equal(usage.totalTokens,usage.inputTokens+usage.outputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0))
      log({runtime:provider,models:models.length,selectedModel:model,contextWindow:info.context.contextWindow,error:result.error,text:textOf(result),usage,finish:result.chunks.at(-1)})
    }
    await mounted.dispose()
    const after=await drain(ctx.llm,turn('codex','fixture'))
    assert(after.error||after.chunks.at(-1)?.reason?.kind==='error')
    log({runtimeDisposed:true,unregistered:true})
  }finally{await mounted.dispose();await service.dispose()}
}

if(mode === 'hardening'){
  await check('actual denied-read ACL is handled without throwing',()=>{
    if(process.platform!=='win32')throw new Error('UNVERIFIED: this ACL probe requires Windows icacls')
    const root=scratch(),dir=join(root,'workspace','session');fs.mkdirSync(dir,{recursive:true})
    const file=join(dir,'usage.json');fs.writeFileSync(file,JSON.stringify({session:{inputTokens:1,totalTokens:1}}))
    const identity=command('whoami.exe',['/user','/fo','csv','/nh'])
    const sid=/S-1-[0-9-]+/.exec(identity.stdout)?.[0];assert(sid)
    assert.equal(command('icacls.exe',[file,'/deny',`*${sid}:(R)`]).status,0)
    try{
      assert.throws(()=>fs.readFileSync(file),/EACCES|EPERM/)
      assert.equal(host.readGrokCliUsage(root).available,false)
      return{deniedReadConfirmed:true,readerSurvived:true}
    }finally{assert.equal(command('icacls.exe',[file,'/remove:d',`*${sid}`]).status,0)}
  })
  await check('scheduled checks use the effective local source and stop on disposal',async()=>{
    const root=scratch(),effects=[],hits=[],started=Date.now()
    const server=createServer((_q,res)=>{hits.push(Date.now()-started);res.setHeader('content-type','application/json');res.end(JSON.stringify({version:'99.0.0'}))})
    await new Promise(r=>server.listen(0,'127.0.0.1',r))
    const source=`http://127.0.0.1:${server.address().port}/package.json`
    try{
      host.apply({logger:{info(){},warn(){}},llm:{registerAdapter(){return()=>{}}},inject(){},effect(fn){effects.push(fn())}},
        {cwd:root,usageFile:join(root,'ledger.json'),autoUpdate:'check',updateIntervalMs:60000,updateSource:source,providers:{grok:false,codex:false,opencode:{bin:process.execPath}}})
      const deadline=Date.now()+65000
      while(hits.length<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,200))
      assert.equal(hits.length,2,'both initial and repeating checks execute')
      effects.forEach(dispose=>dispose?.())
      const count=hits.length;await new Promise(r=>setTimeout(r,600))
      assert.equal(hits.length,count)
      return{source:'isolated loopback HTTP',observedAtMs:hits,disposed:true,installationChanged:false}
    }finally{effects.forEach(dispose=>dispose?.());await new Promise(r=>server.close(r))}
  })
}

if (mode === 'inventory') {
  for (const args of [['status','--short'],['branch','--show-current'],['log','-5','--oneline'],['remote','-v']]) command('git', args)
  command(process.execPath, ['--version'])
  const npm = host.resolveWindowsShim(join(process.env.APPDATA, 'npm', 'npm.cmd'))
  // npm itself may be installed beside node rather than under APPDATA.
  const npmTarget = npm || host.resolveWindowsShim(join(dirname(process.execPath), 'npm.cmd'))
  assert(npmTarget); command(npmTarget.bin, [...npmTarget.prefix, '--version'])
  command(process.execPath, ['--check','index.js']); command(process.execPath, ['--check','client.js'])
  command(npmTarget.bin, [...npmTarget.prefix, 'pack','--dry-run','--json'])
  const pkg = JSON.parse(fs.readFileSync(join(repo,'package.json')))
  log({ manifest: pkg, exports: Object.fromEntries(Object.entries(host).map(([key,value])=>[key,typeof value])), patch: fs.readFileSync(join(repo,'cordis.patch.yml'),'utf8') })
  for (const dir of ['.dsh','.grok/sessions','.codex/sessions']) {
    const path = join(process.env.USERPROFILE, dir)
    log({ directory: dir, exists: fs.existsSync(path), entries: fs.existsSync(path) ? fs.readdirSync(path) : [] })
  }
  log({ grokCachePresent: fs.existsSync(join(process.env.USERPROFILE,'.grok','models_cache.json')) })
  const mounted = mount()
  for (const [id,route] of Object.entries(mounted.adapter.config.providers)) command(route.bin,[...route.binArgs,'--version'],{timeout:30000})
  log({ cliLaunches: Object.fromEntries(Object.entries(mounted.adapter.config.providers).map(([id,r])=>[id,{bin:r.bin,prefix:r.binArgs,launchError:r.launchError}])) })
  const dsh = command('where.exe',['dsh']); log({ dshRuntimeOnPath: dsh.status === 0 })
}

if (mode === 'suites') {
  // Hide only the Grok catalog by using a scratch profile; CLI binaries still resolve on PATH.
  // Copy the host catalog for the second run. Never rename the real cache.
  const profile = scratch()
  fs.mkdirSync(join(profile,'.grok'))
  const env = { ...process.env, USERPROFILE: profile, HOME: profile }
  for (const variant of ['empty-cache','host-cache','master-default']) {
    if (variant === 'host-cache') {
      const cache = join(process.env.USERPROFILE,'.grok','models_cache.json')
      if (!fs.existsSync(cache)) { log('UNVERIFIED host-cache run: host catalog absent'); continue }
      fs.copyFileSync(cache,join(profile,'.grok','models_cache.json'))
    }
    const runEnv = variant === 'master-default' ? {...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'init.defaultBranch',GIT_CONFIG_VALUE_0:'master'} : env
    log(`VARIANT ${variant}`)
    const result = command(process.execPath,['test/run.mjs'],{env:runEnv})
    assert.equal(result.status,0)
    assert(!fs.existsSync(join(profile,'.dsh','llm-cli-usage.json')))
    absent()
  }
}

if (mode === 'probes') {
  await check('exported billing period and plan calculators',async()=>{
    const now=new Date(2026,9,17,12).getTime(),start=new Date(2026,9,1).getTime()
    assert.deepEqual(host.periodWindow(1,now),{start,end:now})
    assert.equal(host.periodWindow(28,now).start,new Date(2026,8,28).getTime())
    const plans=await host.computePlans({grok:{monthlyBudgetUsd:20,resetDay:1,weeklyPremium:{usedPercent:42}},opencode:{monthlyBudgetTokens:1000}}, {grok:{sessions:[{endedAt:now,costUsd:5,totalTokens:200,turns:2}]},opencode:{totalTokens:100,costUsd:1}}, null,now)
    assert.equal(plans.grok.usedUsd,5);assert.equal(plans.grok.percent,.25);assert.equal(plans.grokWeekly.usedPercent,42);assert.equal(plans.opencode.usedTokens,100)
  })
  await check('executed HTML refresh script restores scroll and saves position before reload; paused HTML has no timer',()=>{
    const payload=JSON.parse(fs.readFileSync(join(evidence,'real-payload.json')))
    const html=host.renderUsageHtml(payload,Date.now(),payload.routes,'',payload.cliUsage,payload.plans,{autoRefresh:true})
    const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);assert.equal(scripts.length,1)
    const state=new Map([['llm-cli:scroll','640']]);let scrolled,reloaded=false,timer
    vm.runInNewContext(scripts[0],{sessionStorage:{getItem:k=>state.get(k)??null,removeItem:k=>state.delete(k),setItem:(k,v)=>state.set(k,v)},window:{scrollTo:(_x,y)=>scrolled=y,scrollY:960},location:{reload:()=>{reloaded=true}},setTimeout:(fn,ms)=>timer={fn,ms}})
    assert.equal(scrolled,640);assert.equal(timer.ms,20000);timer.fn();assert.equal(state.get('llm-cli:scroll'),'960');assert(reloaded)
    const paused=host.renderUsageHtml(payload,Date.now(),payload.routes,'',payload.cliUsage,payload.plans,{autoRefresh:false});assert(!paused.includes('sessionStorage.setItem'));assert(paused.includes('resume auto-refresh'))
    return {restoredY:scrolled,savedY:state.get('llm-cli:scroll'),reloadCalled:reloaded,timerMs:timer.ms}
  })
  await check('removed wire fields absent recursively; dashboard text has no undefined or NaN',()=>{
    const payload=JSON.parse(fs.readFileSync(join(evidence,'real-payload.json'))),gone=new Set(['recentSessions','signInText','signInNote','subagents','streak','contextWindows'])
    function visit(value){if(!value||typeof value!=='object')return;for(const [key,entry] of Object.entries(value)){assert(!gone.has(key),`removed field ${key}`);visit(entry)}}visit(payload)
    const html=host.renderUsageHtml(payload,Date.now(),payload.routes,'',payload.cliUsage,payload.plans,{autoRefresh:false})
    assert(!/undefined|NaN/.test(html));return {removedKeysChecked:[...gone],undefinedOrNaN:false}
  })
  await check('registration, web disposal, hook calls, route overrides and model TTL', async () => {
    const root=scratch(), effects=[], web=new Set(), tools=[]
    let adapter, names, reads=0
    host.apply({logger:{info(){},warn(){}},llm:{registerAdapter(n,a){names=n;adapter=a}},effect(fn){effects.push(fn())},inject(deps,cb){cb({effect(fn){effects.push(fn())},tools:{register(t){tools.push(t)}},webServer:{register(route){web.add(route);return()=>web.delete(route)}}})}},
      {cwd:root,usageFile:join(root,'ledger.json'),providers:{opencode:{bin:process.execPath,models:['configured']},grok:false,codex:false}})
    assert.deepEqual(names,['opencode']);assert.equal(web.size,6);assert.equal(tools.length,2)
    assert.deepEqual((await adapter.listModels('opencode')).map(m=>m.id),['configured'])
    assert.equal(adapter.providerInfo('opencode').name,'OpenCode (CLI)')
    assert.equal(adapter.providerRetryPolicy(),undefined);assert.equal(adapter.imageRequestPricing(),undefined)
    const prepared=await adapter.prepareCall('opencode','configured');assert.equal(prepared.model.id,'configured');assert.equal(typeof prepared.stream,'function')
    adapter.config.providers.opencode.models=[]
    adapter.config.providers.opencode.readModels=()=>{reads++;return ['dynamic']}
    await adapter.listModels('opencode');await adapter.listModels('opencode');assert.equal(reads,1)
    adapter.listCache.get('opencode').at=0;await adapter.listModels('opencode');assert.equal(reads,2)
    adapter.config.providers.opencode.readModels=()=>[];adapter.listCache.clear()
    assert.equal((await adapter.listModels('opencode'))[0].id,adapter.config.providers.opencode.defaultModel)
    const loginFile=join(root,'waiting-login.mjs')
    fs.writeFileSync(loginFile,"console.log('Open https://example.test/device?user_code=WAIT-1234');setTimeout(()=>{},60000)")
    adapter.config.providers.opencode.statusArgs=['-e','process.exit(1)']
    adapter.config.providers.opencode.loginArgs=[loginFile]
    assert.match(await tools[0].execute({provider:'OPENCODE'}),/WAIT-1234/)
    const pending=adapter.signIn.pending.get('opencode');assert(pending)
    for(const dispose of effects) dispose?.()
    await pending.done
    assert(pending.child.killed);assert.equal(adapter.signIn.pending.size,0)
    assert.equal(web.size,0)
    return {webRoutesDisposed:6,activeLoginKilledOnDispose:true,hooks:'called against mock host in this probe',adapterUnregister:'this mock returns no disposer; real service disposal requires a separate runtime probe'}
  })
  await check('CLI list parser, broken shim, POSIX PATH lookup', async()=>{
    const root=scratch(),file=join(root,'models.mjs')
    fs.writeFileSync(file,"console.log('opencode/a\\nopencode/b')")
    const m=mount({providers:{opencode:{bin:process.execPath,listArgs:[file]},grok:false,codex:false}})
    assert.deepEqual((await m.adapter.listModels('opencode')).map(x=>x.id),['opencode/a','opencode/b'])
    const broken=join(root,'broken.cmd');fs.writeFileSync(broken,'@echo off\r\necho no target\r\n')
    const b=mount({providers:{opencode:{bin:broken},grok:false,codex:false}})
    assert.match(b.adapter.config.providers.opencode.launchError,/cannot launch/)
    const result=await drain(b.adapter,turn('opencode','m'));assert.match(result.error,/cannot launch/)
    const shim=join(root,'audit-tool.cmd');fs.writeFileSync(shim,'@echo off\r\nnode "%~dp0models.mjs" %*\r\n')
    const saved=process.env.PATH
    try{for(const prefix of ['/c/','/mnt/c/']){process.env.PATH=prefix+root.slice(3).replaceAll('\\','/')+delimiter+saved;const p=mount({providers:{opencode:{bin:'audit-tool'},grok:false,codex:false}});assert.deepEqual(p.adapter.config.providers.opencode.binArgs,[file])}}finally{process.env.PATH=saved}
  })
  await check('malformed NDJSON and tool events preserve text; prompt metacharacters remain literal',async()=>{
    const m=mount({providers:{opencode:{bin:process.execPath,buildArgs:(_m,p)=>[join(m.root,'cli.mjs'),p]},grok:false,codex:false}})
    writeCli(m.root,'cli.mjs',`console.log(JSON.stringify({type:'text',part:{text:process.argv[2]}}));console.log('{broken');console.log(JSON.stringify({type:'tool_use',name:'ignored'}));console.log(JSON.stringify({type:'text',part:{text:'END'}}))`)
    const r=await drain(m.adapter,turn('opencode','m','literal & echo INJECTED | whoami'))
    assert.equal(r.error,null);assert.match(textOf(r),/literal & echo INJECTED \| whoami/);assert(textOf(r).endsWith('END'))
  })
  await check('Grok unreadable/malformed/empty inputs and absent Codex catalog',()=>{
    const root=scratch();assert.equal(host.readGrokCliUsage(root).available,false)
    const session=join(root,'workspace','session');fs.mkdirSync(session,{recursive:true});fs.mkdirSync(join(session,'usage.json'))
    assert.equal(host.readGrokCliUsage(root).available,false)
    fs.rmdirSync(join(session,'usage.json'));fs.writeFileSync(join(session,'usage.json'),'{broken')
    assert.equal(host.readGrokCliUsage(root).available,false)
    assert.deepEqual(host.readCodexModelList(join(root,'missing')),[])
    assert.equal(host.readGrokCliUsage(join(root,'absent')).available,false)
  })
  await check('Grok catalog primary/list fallback and no-cache branch',()=>{
    const root=scratch(),saved=process.env.USERPROFILE;fs.mkdirSync(join(root,'.grok'))
    process.env.USERPROFILE=root
    try{assert.deepEqual(host.readGrokModelLimits(),{});fs.writeFileSync(join(root,'.grok','models_cache.json'),JSON.stringify({models:{primary:{info:{context_window:8192,context_windows:[16384]}},fallback:{info:{context_windows:[32768]}}}}));const limits=host.readGrokModelLimits();assert.equal(limits.primary.contextWindow,8192);assert.equal(limits.fallback.contextWindow,32768)}finally{process.env.USERPROFILE=saved}
  })
  await check('Codex malformed rollout line, window labels, and OpenCode scope',()=>{
    const root=scratch();fs.writeFileSync(join(root,'rollout-broken.jsonl'),'{broken\n')
    assert.equal(host.readCodexCliUsage(root).available,false)
    const empty=host.readGrokCliUsage(root)
    for(const days of [7,5/24,30]){const w=host.windowGrokUsage(empty,Date.now()-days*86400000,days);assert(!/\d{5,} days/.test(w.note));assert.equal(w.available,false)}
    const stats=host.toOpencodeCliUsage({tokens:{input:10,output:2,cache:{read:4}}},['stats','--days','1'],1)
    assert.equal(stats.scopeDays,1);assert.equal(stats.totalTokens,16)
  })
  await check('two spawned concurrent ledger writers retain all unique turns',async()=>{
    const root=scratch(),file=join(root,'shared.json'),worker=join(root,'writer.mjs')
    fs.writeFileSync(worker,`import {UsageLedger} from ${JSON.stringify(pathToFileURL(join(repo,'index.js')).href)};const ledger=new UsageLedger(process.argv[2]);for(let i=0;i<40;i++)ledger.record({provider:process.argv[3],model:'m',inputTokens:1,ok:true});ledger.flush();if(ledger.pending.length)process.exit(2)`)
    const run=(id)=>new Promise((ok,fail)=>{const c=spawn(process.execPath,[worker,file,id],{windowsHide:true});c.on('error',fail);c.on('exit',code=>code===0?ok():fail(Error(`writer ${id} exit ${code}`)))})
    await Promise.all([run('one'),run('two')]);const ledger=new host.UsageLedger(file),summary=ledger.summary()
    assert.equal(summary.turns,80);assert.equal(new Set(summary.recent.map(x=>x.id)).size,60)
    const stored=JSON.parse(fs.readFileSync(file));assert.equal(stored.entries.length,80);assert.equal(new Set(stored.entries.map(x=>x.id)).size,80);assert(!fs.existsSync(file+'.lock'))
    return {turns:summary.turns,uniqueStored:80,lockReleased:true}
  })
  await check('stale lock recovery, bounded pending queue, version 1 rewrite, free vs unreported',()=>{
    const root=scratch(),file=join(root,'ledger.json');fs.writeFileSync(file,JSON.stringify({version:1,entries:[{id:'v1',provider:'old',model:'m',inputTokens:5,ok:true}]}))
    fs.writeFileSync(file+'.lock','');const old=new Date(Date.now()-20000);fs.utimesSync(file+'.lock',old,old)
    const ledger=new host.UsageLedger(file,3);ledger.record({provider:'free',model:'m',costUsd:0,ok:true});ledger.record({provider:'unknown',model:'m',ok:true})
    assert.equal(ledger.summary().turns,3);assert.equal(ledger.summary().providers.find(x=>x.key==='free').costTurns,1);assert.equal(ledger.summary().providers.find(x=>x.key==='unknown').costTurns,0)
    assert.equal(JSON.parse(fs.readFileSync(file)).version,2);assert(!fs.existsSync(file+'.lock'))
    const blocked=new host.UsageLedger(join(root,'directory','ledger.json'),3);fs.writeFileSync(join(root,'directory'),'cannot mkdir')
    for(let i=0;i<10;i++)blocked.record({provider:'p',model:'m',ok:true})
    assert.equal(blocked.pending.length,3);assert.equal(blocked.entries.length,3)
  })
  await check('device parser and tool handlers execute with normalized arguments and unknown provider',async()=>{
    assert.deepEqual(host.parseDeviceInfo('Open https://auth.openai.com/codex/device and enter ABCD-1234'),{url:'https://auth.openai.com/codex/device',code:'ABCD-1234'})
    const calls=[],manager={async status(p){calls.push(['status',p]);if(p==='unknown')throw Error('unknown provider');return{signedIn:false}},async start(p){calls.push(['start',p]);return{url:'https://example.test/device',code:'TEST-1234'}},async settle(p){calls.push(['settle',p]);return{pending:true,code:'TEST-1234'}}}
    const [signin,status]=host.buildTools(manager)
    assert.match(await signin.execute({provider:'GROK'}),/Open: https:\/\/example.test\/device/);assert.match(await status.execute({provider:'GROK'}),/TEST-1234/)
    await assert.rejects(()=>signin.execute({provider:'unknown'}),/unknown/)
    assert.deepEqual(signin.output.render({},'value'),[{type:'text',text:'value'}]);assert.deepEqual(calls.slice(0,3),[['status','grok'],['start','grok'],['settle','grok']])
  })
  await check('update TTL, force bypass, malformed source errors and junction realpath',async()=>{
    let hits=0;const server=createServer((_q,r)=>{hits++;r.end('{"version":"9.9.9"}')});await new Promise(r=>server.listen(0,'127.0.0.1',r))
    try{const manager=new host.UpdateManager({updateSource:`http://127.0.0.1:${server.address().port}`});await manager.check();await manager.check();assert.equal(hits,1);await manager.check({force:true});assert.equal(hits,2)}finally{server.closeAllConnections();server.close()}
    const broken=new host.UpdateManager({updateSource:'not a valid URL'});assert((await broken.check()).error)
    const root=scratch(),checkout=join(root,'checkout'),profile=join(root,'profile'),link=join(profile,'node_modules','dsh-llm-cli');fs.mkdirSync(join(checkout,'.git'),{recursive:true});fs.mkdirSync(dirname(link),{recursive:true});fs.writeFileSync(join(profile,'package.json'),JSON.stringify({dsh:{profile:{}}}));fs.symlinkSync(checkout,link,'junction')
    assert.equal(host.detectInstall(link,profile).method,'git');assert.equal(host.detectInstall(link,profile).dir,fs.realpathSync(checkout))
  })
  await check('HTTP routes listen on actual loopback server; HTML escapes hostile model/error; no action token remotely',async()=>{
    const m=mount({updateSource:'not a valid URL',dashboardToken:'audit-token-123456789',providers:{grok:{bin:process.execPath,models:['<script>"hostile"</script>'],statusArgs:['-e','process.exit(0)']},opencode:false,codex:false}})
    m.adapter.ledger.record({provider:'grok',model:'<script>"hostile"</script>',error:'<script>"error"</script>',ok:false,at:Date.now()})
    const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;const route=m.webRoutes.find(r=>r.path===path);if(route)route.handler(req,res).catch(e=>{res.statusCode=500;res.end(e.message)});else{res.statusCode=404;res.end()}})
    await new Promise(r=>server.listen(0,'0.0.0.0',r));const base=`http://127.0.0.1:${server.address().port}`
    try{
      const html=await(await fetch(base+'/llm-cli/usage?refresh=off')).text();assert(html.includes('<svg'));assert(!html.includes('<script>"hostile"'));assert(!html.includes('<script>"error"'));assert(html.includes('&lt;script&gt;&quot;hostile&quot;'));assert(!html.includes('NaN'));fs.writeFileSync(join(evidence,'probe-dashboard.html'),html)
      const response=await fetch(base+'/llm-cli/usage.json');assert.equal(response.status,200);assert((await response.json()).routes)
      const local=await(await fetch(base+'/llm-cli/update.json')).json();assert(local.actionToken)
      const fake={status:0,body:'',writeHead(s){this.status=s},end(b){this.body=b},setHeader(){}}
      await m.webRoutes.find(r=>r.path==='/llm-cli/usage').handler({url:'/llm-cli/usage',headers:{'x-llm-cli-token':'audit-token-123456789'},socket:{remoteAddress:'192.0.2.1'}},fake)
      assert.equal(fake.status,200);assert(!fake.body.includes(local.actionToken))
    }finally{server.closeAllConnections();server.close()}
    return {actualHttp:true,htmlEscaped:true,remoteActionTokenAbsent:true}
  })
}

if(mode === 'source-scan'){
  command('rg',['-n','providerRetryPolicy|imageRequestPricing|prepareCall|capabilities|rateLimits|perStep','index.js','client.js','test','README.md','CHANGELOG.md'])
  const source=fs.readFileSync(join(repo,'client.js'),'utf8')
  for(const match of source.matchAll(/function\s+(\w+)\s*\(/g)){const id=match[1];log({componentOrFunction:id,references:(source.match(new RegExp('\\b'+id+'\\b','g'))||[]).length})}
  for(const match of source.matchAll(/const \[\w+, (\w+)\] = React.useState/g)){const id=match[1];log({setter:id,references:(source.match(new RegExp('\\b'+id+'\\b','g'))||[]).length})}
  command('rg',['-n','shell:|spawn\\(|spawnCommand\\(|timeoutMs|setTimeout|logger','index.js'])
  command('rg',['-n','cwd|usageFile|providers|timeoutMs|plan|grokUsageDir|codexUsageDir|codexModelsCache|opencodeStats|includeSystemPrompt|dashboardToken|signInTtlMs|autoUpdate|updateIntervalMs|updateSource|updateInstall','README.md','index.js'])
  command('gh',['run','list','--limit','3','--json','databaseId,headSha,status,conclusion'])
  const head = command('git',['rev-parse','HEAD']).stdout.trim()
  const recent = command('gh',['run','list','--limit','20','--json','databaseId,headSha,status,conclusion'])
  if (recent.status === 0) {
    const run = JSON.parse(recent.stdout).find((entry) => entry.headSha === head)
    if (run) command('gh',['run','view',String(run.databaseId),'--json','headSha,conclusion,jobs'])
    else log({ ci: 'UNVERIFIED', reason: 'No recent run matches HEAD', head })
  }
}

if (mode === 'snapshot') {
  const m=mount({timeoutMs:45000})
  const payload=await host.describeRoutes(m.adapter,m.adapter.ledger,0,{force:true})
  fs.writeFileSync(join(evidence,'real-payload.json'),JSON.stringify(payload,null,2))
  fs.writeFileSync(join(evidence,'real-dashboard.html'),host.renderUsageHtml(payload,Date.now(),payload.routes,payload.limitsNotice,payload.cliUsage,payload.plans,{autoRefresh:false}))
  log({snapshotWritten:true,routes:payload.routes.map(r=>r.id)})
}
if (mode === 'real') {
  const m=mount({timeoutMs:45000})
  const payload=await host.describeRoutes(m.adapter,m.adapter.ledger,0)
  fs.writeFileSync(join(evidence,'real-payload.json'),JSON.stringify(payload,null,2))
  fs.writeFileSync(join(evidence,'real-dashboard.html'),host.renderUsageHtml(payload,Date.now(),payload.routes,payload.limitsNotice,payload.cliUsage,payload.plans,{autoRefresh:false}))
  for(const id of ['grok','codex','opencode']){const v=payload.cliUsage[id];log({route:id,available:v?.available,source:v?.source,note:v?.note,input:v?.inputTokens,output:v?.outputTokens,cacheRead:v?.cacheReadTokens,reasoning:v?.reasoningTokens,total:v?.totalTokens,costUsd:v?.costUsd,sessions:v?.sessionCount??v?.sessions,steps:v?.steps,limits:v?.limits,mix:v?.mix})}
  const opencode=m.adapter.config.providers.opencode
  command(opencode.bin,[...opencode.binArgs,'stats','--json','--all','--models','--cost'],{timeout:45000})
  for(const id of ['grok','codex']){const r=m.adapter.config.providers[id];command(r.bin,[...r.binArgs,...(id==='codex'?['login','status']:['models'])],{timeout:30000})}
  // Real minimal inference in an empty scratch cwd. No repository files are available to agent tools.
  for(const id of ['opencode','grok','codex']){
    m.adapter.config.cwd=scratch()
    const model=m.adapter.config.providers[id].defaultModel
    const result=await drain(m.adapter,turn(id,model,'Reply exactly AUDIT_OK. Do not use tools or inspect files.'))
    log({realTurn:id,model,error:result.error,chunks:result.chunks})
  }
}

if(mode === 'real-capabilities'){
  const data=redPng(),ref={attachmentId:'audit-red',mediaType:'image/png',bytes:data.length,width:32,height:32}
  const attachments={async readImage(){return{ref,data}}}
  const m=mount({timeoutMs:45000},{attachments})
  await m.adapter.loadOpencodeModelInfo()
  log({catalogSource:'OpenCode api GET /api/model',models:Object.keys(m.adapter.opencodeModelInfo.byModel).length,
    limits:['opencode/beam-free','opencode/deepseek-v4.1-flash-free','opencode/deepseek-v4.1-flash'].map(id=>({id,...m.adapter.limitsFor('opencode',id)}))})
  log({grokModels:(await m.adapter.listModels('grok')).map(model=>model.id)})
  for(const provider of ['codex','grok','opencode']){
    const model=m.adapter.config.providers[provider].defaultModel
    m.adapter.config.cwd=scratch()
    const result=await drain(m.adapter,{provider,model,messages:[{role:'user',content:[{type:'text',text:'Name the dominant color of the supplied image in one word. Do not use tools.'},{type:'image',attachment:ref}]}]})
    log({vision:provider,error:result.error,text:textOf(result),finish:result.chunks.at(-1),expectedColor:'red'})
  }
  for(const provider of ['codex','grok']){
    const model=m.adapter.config.providers[provider].defaultModel
    m.adapter.config.cwd=scratch()
    const tools=[{name:'audit_echo',description:'Return the provided value',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}]
    const request=await drain(m.adapter,{...turn(provider,model,'Call the DSH audit_echo tool with value "bridge". Request the tool; do not simulate its result.'),tools})
    const call=request.chunks.find(chunk=>chunk.type==='block-end'&&chunk.block.type==='tool-call')?.block
    log({toolRequest:provider,error:request.error,call,finish:request.chunks.at(-1)})
    if(call?.name==='audit_echo'){
      const args=JSON.parse(call.arguments),value='REAL_HOST_RESULT_'+args.value
      const reply=await drain(m.adapter,{provider,model,tools,messages:[{role:'assistant',content:[call]},{role:'user',source:{kind:'tool',callId:call.id},content:[{type:'tool-result',toolCallId:call.id,content:[{type:'text',text:value}]}]},{role:'user',content:[{type:'text',text:'Reply with the tool result exactly. Do not request another tool.'}]}]})
      log({toolResult:provider,error:reply.error,text:textOf(reply),expected:value})
    }
  }
  m.adapter.config.cwd=scratch()
  m.adapter.config.providers.codex.sandbox='workspace-write'
  const written=await drain(m.adapter,turn('codex',m.adapter.config.providers.codex.defaultModel,'Create audit-write.txt in the current working directory containing exactly CHECK_OK. Then reply AUDIT_WRITE_OK.'))
  const file=join(m.adapter.config.cwd,'audit-write.txt')
  log({workspaceWrite:'codex',error:written.error,text:textOf(written),fileExists:fs.existsSync(file),contents:fs.existsSync(file)?fs.readFileSync(file,'utf8'):null})
}

if(mode === 'real-sanity'){
  const profile=process.env.USERPROFILE
  function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)])}
  const grokFiles=files(join(profile,'.grok','sessions')).filter(f=>f.endsWith('usage.json'))
  const grokRaw=grokFiles.map(f=>JSON.parse(fs.readFileSync(f)).session).filter(Boolean)
  const grok=host.readGrokCliUsage(join(profile,'.grok','sessions'))
  for(const [source,target] of [['inputTokens','inputTokens'],['outputTokens','outputTokens'],['cachedReadTokens','cacheReadTokens'],['totalTokens','totalTokens']])assert.equal(grok[target],grokRaw.reduce((sum,s)=>sum+(s[source]||0),0))
  log({independentGrokFileSum:{files:grokRaw.length,input:grok.inputTokens,output:grok.outputTokens,cache:grok.cacheReadTokens,total:grok.totalTokens},matches:true})
  let raw={input_tokens:0,output_tokens:0,cached_input_tokens:0},rollouts=0
  for(const file of files(join(profile,'.codex','sessions')).filter(f=>/rollout-.*\.jsonl$/.test(f))){let last;for(const line of fs.readFileSync(file,'utf8').split('\n')){try{const e=JSON.parse(line);if(e.type==='event_msg'&&e.payload?.type==='token_count'&&e.payload.info?.total_token_usage)last=e.payload.info.total_token_usage}catch{}}if(last){rollouts++;for(const k of Object.keys(raw))raw[k]+=last[k]||0}}
  const codex=host.readCodexCliUsage(join(profile,'.codex','sessions'));assert.equal(codex.inputTokens,raw.input_tokens);assert.equal(codex.outputTokens,raw.output_tokens);assert.equal(codex.cacheReadTokens,raw.cached_input_tokens)
  log({independentCodexLastCumulativeSum:{rollouts,...raw},matches:true})
  const m=mount({providers:{opencode:false,grok:false,codex:{}}}),route=m.adapter.config.providers.codex
  const result=command(route.bin,[...route.binArgs,...route.buildArgs(route.defaultModel,'Reply exactly AUDIT_RAW_OK. Do not use tools or inspect files.')],{cwd:scratch(),timeout:45000})
  const events=(result.stdout||'').split('\n').flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}})
  log({rawCodexExit:result.status,eventTypes:events.map(e=>e.type),usage:events.find(e=>e.type==='turn.completed')?.usage})
}

if(mode === 'clone'){
  const root=scratch(),clone=join(root,'clone');assert.equal(command('git',['clone','--depth','1','--branch','main','https://github.com/Mans230/dsh-llm-cli',clone]).status,0)
  command('git',['rev-parse','HEAD'],{cwd:clone});log({cloneVersion:JSON.parse(fs.readFileSync(join(clone,'package.json'))).version})
  assert.equal(command(process.execPath,['test/run.mjs'],{cwd:clone}).status,0)
  // client.test includes recursive model contextWindows and removed Codex view-field assertions.
  log('Fresh clone payload assertions executed by client.test.mjs; all suite results above.')
}

if(mode === 'serve'){
  const payload=JSON.parse(fs.readFileSync(join(evidence,'real-payload.json')))
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','text/html; charset=utf-8')
    res.end(host.renderUsageHtml(payload,Date.now(),payload.routes,payload.limitsNotice,payload.cliUsage,payload.plans,{autoRefresh:!req.url.includes('refresh=off')}))
  })
  server.listen(18793,'127.0.0.1',()=>log('Browser audit server http://127.0.0.1:18793/llm-cli/usage'))
}

if(mode === 'mutations'){
  const root=scratch(),copy=join(root,'repo');fs.mkdirSync(copy)
  for(const file of ['index.js','client.js','package.json','README.md','CHANGELOG.md','LICENSE','cordis.patch.yml'])fs.copyFileSync(join(repo,file),join(copy,file))
  fs.cpSync(join(repo,'test'),join(copy,'test'),{recursive:true})
  const cases=[
    ['request-origin','index.js', "if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip'].some(key => headers[key] !== undefined)) return false", "/* regress: trust local proxy socket */"],
    ['client','client.js', 'inputTokens: Math.max(0, (day?.inputTokens ?? 0) - (day?.cacheReadTokens ?? 0)),', 'inputTokens: day?.inputTokens,'],
    ['client','client.js', "route.signInOptional ? 'Sign-in optional (free models need no sign-in)' : 'Not signed in'", "'Not signed in'"],
    ['client','client.js', 'next[route.id] = { ...next[route.id], signedIn: route.signedIn }', 'next[route.id] = { ...next[route.id] }'],
    ['codex-server','index.js', 'cached_input_tokens: u.cachedInputTokens', 'cached_input_tokens: 0'],
    ['setup','index.js','if (this.pending.has(provider)) return this.pending.get(provider)','if (false) return this.pending.get(provider)'],
    ['signin','index.js','if (settled.code !== 0) throw new Error','if (false) throw new Error'],
    ['signin','index.js','code === 0 && signedIn(text)','code === 0'],
    ['adapter','index.js','Math.max(0, mapped.inputTokens - mapped.cacheReadTokens)','mapped.inputTokens'],
    ['model-limits','index.js','Math.min(cap, nativeContext)','nativeContext'],
    ['execution','index.js','includeSystemPrompt: config.includeSystemPrompt !== false','includeSystemPrompt: config.includeSystemPrompt === true'],
    ['execution','index.js','return session.header.cwd','return this.config.cwd'],
    ['capabilities','index.js',"toolBridge: config.toolBridge === false ? false : 'json'","toolBridge: false"],
    ['capabilities','index.js',"if (promptDir) { try { rmSync(promptDir, { recursive: true, force: true }) }", "if (false) { try { rmSync(promptDir, { recursive: true, force: true }) }"],
    ['usage','index.js','if (force) this.invalidateCaches()','if (false) this.invalidateCaches()'],
    ['usage','index.js','    rolloutCache.clear()','    /* retain parsed rollout cache */'],
    ['adapter','index.js',"name: this.config.providers[provider]?.displayName ?? provider","name: 'BROKEN'"],
    ['adapter','index.js',"if (id === 'codex' && typeof override?.readModels !== 'function') {","if (id === 'codex' && !Array.isArray(merged.models)) {"],
    ['adapter','index.js',"if (id === 'codex' && typeof override?.readModels !== 'function') {","if (id === 'codex' && typeof override?.readModels !== 'function' && !Array.isArray(merged.models)) {"],
    ['client','client.js',"const inject = ['slots']","const inject = []"],
    ['contract','index.js',"export const name = 'llm-cli'","export const name = 'BROKEN'"],
    ['dashboard','index.js',"if (!auth.ok) {","if (false) {"],
    ['failures','index.js',"if (cliError || (text.length > 0 && exit?.code !== 0)) {","if (false) {"],
    ['failures','index.js',"if (cliError || (text.length > 0 && exit?.code !== 0)) {","if (text.length > 0 && exit?.code !== 0) {"],
    ['failures','index.js',"if (options.signal?.aborted) {","if (false) {"],
    ['failures','index.js',"if (aborted) {\n        this.recordFailure(provider, options.model, turnStartedAt, 'the request was aborted')","if (aborted) {"],
    ['failures','index.js',"const timeoutMs = Number.isFinite(route.timeoutMs) && route.timeoutMs > 0\n      ? route.timeoutMs\n      : this.config.timeoutMs","const timeoutMs = route.timeoutMs ?? this.config.timeoutMs"],
    ['ledger','index.js',"this.totals = readTotals(parsed?.totals) ?? totalsFrom(parsed?.entries)","this.totals = totalsFrom(parsed?.entries)"],
    ['signin','index.js',"const code = fromUrl ?? /\\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\\b/.exec(text)?.[1]","const code = undefined"],
    ['signin','index.js','if (info.url && info.code) break','if (info.url || info.code) break'],
    ['signin','index.js',"signedIn: code === 0 && signedIn(text)","signedIn: signedIn(text)"],
    ['signin','index.js',"if (this.pending.get(provider) === entry) this.pending.delete(provider)","/* retain a completed pending entry */"],
    ['dashboard','index.js',"ctx.logger?.info?.('llm-cli: usage dashboard at /llm-cli/usage')","ctx.logger?.info?.('llm-cli: usage dashboard at /llm-cli/usage ' + normalized.usageFile)"],
    ['views','index.js',"if (code !== 0) {\n    throw new Error((stderr || text)","if (false) {\n    throw new Error((stderr || text)"],
    ['views','index.js',"if (!stats?.tokens || !Number.isFinite(stats.tokens.input) || !Number.isFinite(stats.tokens.output)) {","if (false) {"],
    ['contract','index.js',"  UpdateManager,\n  readCodexModelList,","  readCodexModelList,"],
    ['update','index.js',"if (difference !== 0) return difference > 0 ? 1 : -1","if (difference !== 0) return difference > 0 ? -1 : 1"],
    ['update','index.js',"source: this.source,","source: this.config.updateSource,"],
    ['update','index.js',"constructor(config = {}, options = {}) {","constructor(config, options = {}) {"],
    ['usage','index.js',"contextWindow: lastContextWindow,","contextWindow: undefined,"],
    ['views','index.js',"usage = parsed.usageDelta ? addUsage(usage ?? {}, parsed.usage) : parsed.usage","usage = parsed.usage"],
  ]
  for(const [suite,file,from,to] of cases){
    const path=join(copy,file),original=fs.readFileSync(path,'utf8').replaceAll('\r\n','\n')
    if(!original.includes(from)){log({suite,result:'UNVERIFIED',reason:`mutation target missing: ${from}`});process.exitCode=1;continue}
    try{fs.writeFileSync(path,original.replace(from,to));const result=command(process.execPath,[`test/${suite}.test.mjs`],{cwd:copy,timeout:90000});assert.notEqual(result.status,0);assert.match((result.stderr||'')+(result.stdout||''),/assertion failed/);log({suite,mutation:from,result:'DETECTED'})}finally{fs.writeFileSync(path,original)}
    absent()
  }
}
absent()
log({evidenceDirectory:evidence})
