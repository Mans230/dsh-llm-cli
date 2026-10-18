import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mount, drain, turn, textOf } from './_harness.mjs'
import { assert, assertEqual, assertMatch } from './_assert.mjs'

const m = mount({ providers: { grok: false, opencode: false, codex: { bin: process.execPath, appServer: true } } })
const stub = join(m.root, 'rpc.mjs'), marker = join(m.root, 'before-complete')
writeFileSync(stub, `
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
const send = p => console.log(JSON.stringify(p))
for await (const line of createInterface({input:process.stdin})) {
 const p=JSON.parse(line)
 if(p.method==='initialize')send({id:p.id,result:{}})
 if(p.method==='account/rateLimits/read')send({id:p.id,result:{rateLimits:{primary:{usedPercent:27,windowDurationMins:300,resetsAt:2000000000},secondary:null}}})
 if(p.method==='thread/start') {
   if(p.params.sandbox!=='read-only'||p.params.approvalPolicy!=='never') throw Error('unsafe policy')
   send({id:p.id,result:{thread:{id:'thread'}}})
 }
 if(p.method==='turn/start') {
   send({id:p.id,result:{turn:{id:'turn'}}})
   send({method:'item/agentMessage/delta',params:{itemId:'a',delta:'FIRST'}})
   setTimeout(()=>{
     if(!existsSync(${JSON.stringify(marker)}))throw Error('consumer did not receive delta before completion')
     send({method:'item/agentMessage/delta',params:{itemId:'a',delta:' SECOND'}})
     send({method:'item/completed',params:{item:{id:'a',type:'agentMessage',text:'FIRST SECOND'}}})
     send({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:100,cachedInputTokens:40,outputTokens:12,totalTokens:112}}}})
     send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}})
   },250)
 }
}
`)
const route=m.adapter.config.providers.codex
route.appServerArgs=[stub]
const chunks=[]
for await(const chunk of m.adapter.stream(turn('codex','m'))) {
 chunks.push(chunk)
 if(chunk.type==='text-delta'&&chunk.text==='FIRST')writeFileSync(marker,'received')
}
assertEqual(textOf({chunks}),'FIRST SECOND','deltas arrive before completion without duplicate completed text')
assertEqual(chunks.find(c=>c.type==='usage').usage.inputTokens,60,'cached input is disjoint')
assertEqual(chunks.at(-1).reason.kind,'stop','completion succeeds even though app-server needs shutdown')
const quota=await m.adapter.cliUsage(7,{force:true})
assertEqual(quota.codex.limits.primary.usedPercent,27,'live quota works without historical turns')
assertEqual(quota.codex.limits.primary.resetsAt,2000000000000,'quota timestamps use milliseconds')
assertEqual(quota.codex.limitsSource,'live','source survives usage window filtering')
assertEqual(quota.codex.limitsStale.primary,false,'fresh quota is identified')
writeFileSync(stub,`console.log(JSON.stringify({error:{message:'not signed in'}}))`)
const fallback=await m.adapter.cliUsage(0,{force:true})
assertEqual(fallback.codex.limitsSource,'recorded','failed live request falls back to files')
assertMatch(fallback.codex.liveQuotaError,/not signed in/,'fallback preserves the reason')
for(const status of ['failed','interrupted','early-exit']) {
 writeFileSync(stub,`import {createInterface} from 'node:readline';for await(const l of createInterface({input:process.stdin})){const p=JSON.parse(l);if(p.id===1)console.log(JSON.stringify({id:1,result:{}}));if(p.id===2)console.log(JSON.stringify({id:2,result:{thread:{id:'thread'}}}));if(p.id===3){console.log(JSON.stringify({id:3,result:{turn:{id:'turn'}}}));console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'partial'}}));${status==='early-exit'?"process.exit(0)":`console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn',status:'${status}',error:{message:'turn ${status}'}}}}))`}}}`)
 const result=await drain(m.adapter,turn('codex','m'))
 assert(result.error,`${status} must fail after partial output`)
 assert(!result.chunks.some(c=>c.type==='finish'),`${status} cannot signal success`)
}
// A server that remains open after initialization must obey timeout and abort.
writeFileSync(stub, `import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const p=JSON.parse(line);if(p.id===1)console.log(JSON.stringify({id:1,result:{}}))}`)
route.timeoutMs=250
const timedOut=await drain(m.adapter,turn('codex','m'))
assertMatch(timedOut.error,/timed out/,'app-server cannot wait forever')
route.timeoutMs=5000
const controller=new AbortController()
const timer=setTimeout(()=>controller.abort(),250)
const aborted=await drain(m.adapter,{...turn('codex','m'),signal:controller.signal})
clearTimeout(timer)
assertEqual(aborted.chunks.at(-1).reason.kind,'aborted','abort ends a waiting app-server')
rmSync(m.root,{recursive:true,force:true})
console.log('Codex app-server streaming and quota checks passed')
