// Optional real React DOM probe; dependencies are downloaded only into temp HTML.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir=process.env.AUDIT_DIR||tmpdir()
const scripts=await Promise.all(['react','react-dom'].map(async name=>{
  const response=await fetch(`https://unpkg.com/${name}@18.3.1/umd/${name}.production.min.js`)
  if(!response.ok)throw new Error(`React fixture download: HTTP ${response.status}`)
  return response.text()
}))
const payload=readFileSync(join(dir,'real-payload.json'),'utf8').replaceAll('<','\\u003c')
const client=readFileSync(new URL('../client.js',import.meta.url),'utf8')
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#111;color:white;font:14px Arial}*{box-sizing:border-box}</style></head><body><div id="summary"></div><div id="full"></div>
<script>${scripts.join('\n')}</script><script>
const payload=${payload};const requests=[];
const immediate=value=>({then(fn){return immediate(fn(value))},catch(){return this}});
window.fetch=(url)=>{requests.push(String(url));return immediate({ok:true,json:()=>String(url).includes('update')?{current:'0.7.1',latest:'0.7.1',updateAvailable:false}:payload})};
window.__ModuleLoader__={load(m){window.client=m.factory(()=>React)}};
</script><script>${client}</script><script>
ReactDOM.flushSync(()=>{ReactDOM.createRoot(document.getElementById('summary')).render(React.createElement(client.LlmCliPage,{view:'summary'}));
ReactDOM.createRoot(document.getElementById('full')).render(React.createElement(client.LlmCliPage,{view:'full'}));});
const tick=async()=>{for(let n=0;n<8;n++)await Promise.resolve();ReactDOM.flushSync(()=>{});};
const button=name=>[...document.querySelectorAll('#full button')].find(b=>b.textContent.trim()===name);
const assert=(v,label)=>{if(!v)throw new Error(label)};
const run=async()=>{
 assert(button('Refresh'),'full view loaded');
 ReactDOM.flushSync(()=>button('Refresh').click());await tick();assert(requests.some(u=>u.includes('force=1')),'manual refresh forces source reread');
 ReactDOM.flushSync(()=>button('30d').click());await tick();assert(requests.some(u=>u.includes('days=30')),'window click changes request');
 ReactDOM.flushSync(()=>button('Check for updates').click());await tick();assert(requests.some(u=>u.includes('update.json')),'update check click executes');
 const auto=document.querySelector('#full input[type="checkbox"]');assert(auto?.checked,'auto refresh initially enabled');
 ReactDOM.flushSync(()=>auto.click());assert(!auto.checked,'pause disables auto refresh');
 ReactDOM.flushSync(()=>auto.click());assert(auto.checked,'resume enables auto refresh');
 const summary=document.getElementById('summary');assert(!summary.querySelector('svg,table'),'summary contains no charts or tables');
 assert(document.querySelectorAll('#full svg').length>0,'full charts render');
 assert(!/undefined|NaN/.test(document.body.innerText),'text has no invalid values');
 console.log(JSON.stringify({realReactDom:true,http:'isolated fixture',summary:true,manualRefresh:true,windowClick:true,updateClick:true,pauseResume:true,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,charts:document.querySelectorAll('#full svg').length,buttons:[...document.querySelectorAll('#full button')].map(b=>b.textContent)}));
};
const observer=new MutationObserver(()=>{if(button('Refresh')){observer.disconnect();run().catch(e=>console.error(e.stack))}});
observer.observe(document.getElementById('full'),{childList:true,subtree:true});
if(button('Refresh')){observer.disconnect();run().catch(e=>console.error(e.stack))}
</script></body></html>`
writeFileSync(join(dir,'react-browser.html'),html)
console.log('React DOM probe HTML written')
