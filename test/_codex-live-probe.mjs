// Optional real Codex probe. Uses an isolated test ledger, never the live ledger.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mount } from './_harness.mjs'
const m=mount(),route=m.adapter.config.providers.codex,cwd=mkdtempSync(join(tmpdir(),'dsh-codex-live-'))
if (process.argv.includes('--adapter')) {
 const started=Date.now()
 const quota=await m.adapter.cliUsage(0,{force:true})
 console.log({quotaSource:quota.codex?.limitsSource,quota:quota.codex?.limits,quotaError:quota.codex?.liveQuotaError})
 let firstDeltaMs=null,deltas=0,characters=0,finish
 const turnAt=Date.now()
 for await(const chunk of m.adapter.stream({provider:'codex',model:route.defaultModel,messages:[{role:'user',content:'Write a numbered list of 30 short, distinct ways to organize a desk. Do not use tools or inspect files.'}]})) {
  if(chunk.type==='text-delta'){firstDeltaMs??=Date.now()-turnAt;deltas++;characters+=chunk.text.length}
  if(chunk.type==='finish')finish=chunk.reason.kind
 }
 console.log({firstDeltaMs,completedMs:Date.now()-turnAt,deltas,characters,finish,totalMs:Date.now()-started})
 rmSync(m.root,{recursive:true,force:true});rmSync(cwd,{recursive:true,force:true})
 process.exit(0)
}
const child=spawn(route.bin,[...route.binArgs,'app-server','--listen','stdio://'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']})
const send=x=>child.stdin.write(JSON.stringify(x)+'\n'),at=Date.now()
let firstDelta=null,deltas=0,characters=0
const timer=setTimeout(()=>{console.log({timeout:true});child.kill()},45000)
child.stderr.on('data',()=>{})
child.stdin.on('error',()=>{})
send({id:1,method:'initialize',params:{clientInfo:{name:'dsh_cli_audit',version:'0.7.1'}}})
for await(const line of createInterface({input:child.stdout})){
 let q;try{q=JSON.parse(line)}catch{continue}
 if(q.error){console.log({rpcError:q.error});child.kill();break}
 if(q.id===1){send({method:'initialized',params:{}});send({id:2,method:'account/rateLimits/read'})}
 if(q.id===2){const r=q.result;console.log({liveQuota:r.rateLimits,hasBuckets:!!r.rateLimitsByLimitId,elapsedMs:Date.now()-at});
  if(process.argv.includes('--turn'))send({id:3,method:'thread/start',params:{model:route.defaultModel,cwd,sandbox:'read-only',approvalPolicy:'never',ephemeral:true}})
  else {child.kill();break}
 }
 if(q.id===3)send({id:4,method:'turn/start',params:{threadId:q.result.thread.id,input:[{type:'text',text:'Write a numbered list of 30 short, distinct ways to organize a desk. Do not use tools or inspect files.'}]}})
 if(q.method==='item/agentMessage/delta'){firstDelta??=Date.now()-at;deltas++;characters+=q.params.delta.length}
 if(q.method==='thread/tokenUsage/updated')console.log({usage:q.params.tokenUsage})
 if(q.method==='turn/completed'){console.log({firstDeltaMs:firstDelta,completedMs:Date.now()-at,deltas,characters,turnStatus:q.params.turn.status,error:q.params.turn.error});child.kill();break}
}
clearTimeout(timer)

rmSync(m.root,{recursive:true,force:true});rmSync(cwd,{recursive:true,force:true})
