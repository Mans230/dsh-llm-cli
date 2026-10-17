import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount, drain, turn } from './_harness.mjs'
import { assert, assertMatch } from './_assert.mjs'

const m=mount({timeoutMs:800,providers:{grok:false,codex:false,opencode:{bin:process.execPath,buildArgs:()=>[join(m.root,'parent.mjs')]}}})
const pidFile=join(m.root,'descendant.pid')
writeFileSync(join(m.root,'parent.mjs'),`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));console.log(JSON.stringify({type:'text',part:{text:'READY'}}));setInterval(()=>{},1000)`)
const alive=(pid)=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}}
let pid
try {
  const result=await drain(m.adapter,turn('opencode','m'))
  assertMatch(result.error,/timed out/,'a timed-out process tree records failure')
  assert(existsSync(pidFile),'the child really spawned a descendant')
  pid=Number(readFileSync(pidFile,'utf8'))
  assert(Number.isInteger(pid)&&pid>0,'the descendant has a real process id')
  for(let n=0;n<20&&alive(pid);n++)await new Promise(r=>setTimeout(r,100))
  assert(!alive(pid),'timeout terminates the descendant process too')
} finally {
  if(pid&&alive(pid)){
    if(process.platform==='win32')await new Promise(r=>spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true}).on('close',r))
    else process.kill(pid,'SIGKILL')
  }
}
console.log('ok  descendant cleanup probe on '+process.platform)
