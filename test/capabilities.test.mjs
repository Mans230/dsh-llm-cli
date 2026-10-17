import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount, drain, turn, textOf } from './_harness.mjs'
import { assert, assertEqual, assertMatch } from './_assert.mjs'
import { redPng } from './_image.mjs'

const m=mount({providers:{opencode:{bin:process.execPath},grok:false,codex:false}})
const cli=join(m.root,'cli.mjs')
m.adapter.config.providers.opencode.buildArgs=(_m,p)=>[cli,p]
const tools=[{name:'sum',description:'Add two integers',parameters:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b']}}]
writeFileSync(cli,`console.log(JSON.stringify({type:'text',part:{text:'DSH_TOOL_CALLS [{"name":"sum","arguments":{"a":2,"b":3}}]'}}))`)
const requested=await drain(m.adapter,{...turn('opencode','m'),tools})
assertEqual(requested.error,null,'valid bridge request succeeds')
assertEqual(textOf(requested),'','tool JSON is not exposed as an assistant answer')
assertEqual(requested.chunks.at(-1).reason.kind,'tool-calls','the host is asked to execute tools')
const call=requested.chunks.find(c=>c.type==='block-end'&&c.block.type==='tool-call').block
assertEqual(call.name,'sum','the offered tool is requested')
assertEqual(JSON.parse(call.arguments),{a:2,b:3},'arguments retain their JSON types')
assertEqual(requested.chunks.find(c=>c.type==='tool-call-delta').argumentsDelta,call.arguments,'tool delta matches the assembled block')
// Simulate the host's tool executor, then return the correlated DSH result.
const args=JSON.parse(call.arguments),result=args.a+args.b
writeFileSync(cli,`const p=process.argv[2];console.log(JSON.stringify({type:'text',part:{text:p.includes(${JSON.stringify(call.id)})&&p.includes('RESULT_5')?'BRIDGE_OK':'MISSING_RESULT'}}))`)
const answered=await drain(m.adapter,{...turn('opencode','m'),tools,messages:[
  {role:'assistant',content:[call]},
  {role:'user',source:{kind:'tool',callId:call.id},content:[{type:'tool-result',toolCallId:call.id,content:[{type:'text',text:'RESULT_'+result}]}]},
]})
assertEqual(textOf(answered),'BRIDGE_OK','a host tool result returns to the CLI with its correlation id')
for(const reply of ['DSH_TOOL_CALLS [{"name":"not_offered","arguments":{}}]','DSH_TOOL_CALLS {bad']){
  writeFileSync(cli,`console.log(JSON.stringify({type:'text',part:{text:${JSON.stringify(reply)}}}))`)
  const invalid=await drain(m.adapter,{...turn('opencode','m'),tools})
  assertMatch(invalid.error,/invalid DSH tool request/,'invalid or unoffered tools are refused')
  assertEqual(m.adapter.ledger.summary().recent[0].ok,false,'a refused tool request is ledgered')
}

// Immutable attachment service seam from @deepseek-ai/dsh-attachment rc.1.
const data=redPng()
const ref={attachmentId:'fixture',mediaType:'image/png',bytes:data.length,width:32,height:32}
const attachments={async readImage(value){assertEqual(value,ref,'the original attachment reference is resolved');return{ref,data}}}
const imageTurn=(provider)=>({...turn(provider,'vision-model'),messages:[{role:'user',content:[{type:'text',text:'describe'},{type:'image',attachment:ref}]}]})
for(const provider of ['opencode','codex']){
  let imageFile
  const image=mount({providers:{opencode:false,codex:false,grok:false,[provider]:{bin:process.execPath,buildArgs:(_m,_p,_f,execution)=>{
    imageFile=execution.images[0]
    assertEqual(readFileSync(imageFile).toString('base64'),data.toString('base64'),'exact verified image bytes reach the CLI file')
    return[cli,imageFile]
  }}}},{attachments})
  writeFileSync(cli,`console.log(JSON.stringify(${JSON.stringify(provider==='codex'?{type:'item.completed',item:{type:'agent_message',text:'IMAGE_OK'}}:{type:'text',part:{text:'IMAGE_OK'}})}))`)
  const response=await drain(image.adapter,imageTurn(provider))
  assertEqual(response.error,null,'an image turn succeeds on '+provider)
  assertEqual(textOf(response),'IMAGE_OK','the CLI answer is parsed')
  assert(!existsSync(imageFile),'temporary image bytes are removed after the turn')
  const defaults=mount({providers:{grok:false,[provider==='codex'?'opencode':'codex']:false,[provider]:{bin:process.execPath}}}).adapter.config.providers[provider]
  const built=defaults.buildArgs('m','prompt',undefined,{images:['image.png']})
  assertEqual(built[built.indexOf(provider==='codex'?'--image':'--file')+1],'image.png','the default CLI builder passes an actual image flag')
}
const noStore=await drain(m.adapter,imageTurn('opencode'))
assertMatch(noStore.error,/attachment service/,'images without an attachment service are rejected instead of silently flattened')
let failedImage
const badBuilder=mount({providers:{grok:false,codex:false,opencode:{bin:process.execPath,buildArgs:(_m,_p,_f,execution)=>{failedImage=execution.images[0];throw new Error('builder failed')}}}},{attachments})
assertMatch((await drain(badBuilder.adapter,imageTurn('opencode'))).error,/builder failed/,'image preparation failures propagate')
assert(!existsSync(failedImage),'temporary image bytes are removed when argument construction fails')

// Grok's ACP transport carries large image blocks on stdin, not the Windows command line.
const acp=join(m.root,'acp.mjs'),captured=join(m.root,'acp-prompt.json')
writeFileSync(acp,`import {createInterface} from 'node:readline';import{writeFileSync}from'node:fs';
const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));
for await(const line of createInterface({input:process.stdin})) {const q=JSON.parse(line);
 if(q.method==='initialize')send({id:q.id,result:{protocolVersion:1}});
 if(q.method==='session/new'){writeFileSync(${JSON.stringify(captured+'.new')},JSON.stringify(q.params));send({id:q.id,result:{sessionId:'test-session'}})}
 if(q.method==='session/prompt'){writeFileSync(${JSON.stringify(captured)},JSON.stringify(q.params));send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP_IMAGE_OK'}}}});send({id:q.id,result:{stopReason:'end_turn'}})}
}`)
const grok=mount({providers:{opencode:false,codex:false,grok:{bin:process.execPath,buildArgs:()=>[acp]}}},{attachments})
const grokImage=await drain(grok.adapter,imageTurn('grok'))
assertEqual(grokImage.error,null,'the ACP image turn completes')
assertEqual(textOf(grokImage),'ACP_IMAGE_OK','ACP updates reach the stream')
const prompt=JSON.parse(readFileSync(captured))
assertEqual(prompt.prompt.find(b=>b.type==='image').data,data.toString('base64'),'ACP receives the image bytes in its image block')
// cwd belongs to session/new, not session/prompt, in the published ACP protocol.
assertEqual(JSON.parse(readFileSync(captured+'.new')).cwd,grok.root,'ACP session initialization uses the selected workspace')
writeFileSync(acp,"process.exit(0)")
assertMatch((await drain(grok.adapter,imageTurn('grok'))).error,/before completing/,'an early successful process exit is still a failed ACP turn')
console.log('ok  capabilities.test')
