import { mount } from './_harness.mjs'
import { assert, assertEqual } from './_assert.mjs'
const m=mount({dashboardToken:'audit-token-valid-12345',providers:{opencode:{bin:process.execPath,models:['fixture'],modelInfoArgs:false},grok:false,codex:false}})
async function call(path,headers={},address='127.0.0.1',method='GET') {
 const response={status:0,body:'',writeHead(code){this.status=code},setHeader(){},end(body){this.body=String(body)}}
 await m.webRoutes.find(r=>r.path===path).handler({url:path,headers,socket:{remoteAddress:address},method,body:'{}'},response)
 return response
}
const local=await call('/llm-cli/setup.json',{host:'127.0.0.1:8080'})
assertEqual(local.status,200,'direct local setup remains usable')
const actionToken=JSON.parse(local.body).actionToken
const proxies=[{'x-forwarded-for':'203.0.113.10'},{forwarded:'for=203.0.113.10;proto=https'},{'cf-connecting-ip':'203.0.113.10'},{'x-forwarded-host':'external.example'},{host:'external.example'},{host:'localhost.evil.example'}]
for(const headers of proxies) {
 for(const path of ['/llm-cli/setup.json','/llm-cli/update.json','/llm-cli/usage.json']) {
  const r=await call(path,headers)
  assertEqual(r.status,403,`proxy ${Object.keys(headers)[0]} cannot read ${path} as loopback`)
  assert(!r.body.includes(actionToken),'refusal never returns the action token')
 }
 for(const [path,key] of [['/llm-cli/setup','x-llm-cli-setup'],['/llm-cli/update','x-llm-cli-update']]) {
  const r=await call(path,{...headers,[key]:actionToken},'127.0.0.1','POST')
  assertEqual(r.status,403,'proxy cannot run host actions even with a valid token')
 }
}
const remoteRead=await call('/llm-cli/usage.json',{'x-forwarded-for':'203.0.113.10','x-llm-cli-token':'audit-token-valid-12345'})
assertEqual(remoteRead.status,200,'forwarded dashboard readers can use the explicit read token')
const malformed=await call('/llm-cli/usage.json',{cookie:'llm_cli_token=%ZZ'},'192.0.2.4')
assertEqual(malformed.status,403,'malformed cookies are refused without throwing')
console.log('ok  request-origin.test')
