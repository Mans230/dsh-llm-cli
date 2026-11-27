/**
 * Per-model limit overrides.
 *
 * A route whose CLI publishes model ids but no limits (OpenCode is the shipped
 * one) can state one model's context window in the profile instead of accepting
 * the harness default for every model on the route.
 */
import { mount } from './_harness.mjs'
import { assertEqual } from './_assert.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { adapter, routes } = mount({
  cwd: process.cwd(),
  providers: {
    opencode: {
      bin: process.execPath,
      models: [
        'opencode/plain',
        { id: 'opencode/configured', name: 'Configured', contextWindow: 272000, maxOutputTokens: 64000 },
      ],
    },
    codex: false,
    grok: false,
  },
})

assertEqual(routes, ['opencode'], 'the configured route is registered')

const models = await adapter.listModels('opencode')
assertEqual(
  models.map((model) => model.id),
  ['opencode/plain', 'opencode/configured'],
  'a bare id and an object entry are both offered',
)
assertEqual(models[0].name, 'opencode/plain', 'a bare id keeps itself as the name')
assertEqual(models[1].name, 'Configured', 'an object entry carries its display name')

const plain = await adapter.resolveModel('opencode', 'opencode/plain')
assertEqual(plain.context.contextWindow, 200000, 'an entry without a window keeps the harness default')

const configured = await adapter.resolveModel('opencode', 'opencode/configured')
assertEqual(configured.context.contextWindow, 272000, 'a configured window wins over the default')
assertEqual(configured.name, 'Configured', 'resolved metadata preserves the configured display name')

const limits = adapter.limitsFor('opencode', 'opencode/configured')
assertEqual(limits.source, 'configured for this model', 'the dashboard says the window was configured')
assertEqual(limits.maxOutputTokens, 64000, 'max output tokens are reported')

const fallback = adapter.limitsFor('opencode', 'opencode/plain')
assertEqual(fallback.maxOutputTokens, undefined, 'a model without an override reports no max output')

const catalog = mount({ providers: { grok: false, codex: false, opencode: {
  bin: process.execPath, models: ['opencode/beam-free', 'opencode/deepseek-v4.1-flash-free', 'opencode/deepseek-v4.1-flash'],
} } })
const file = join(catalog.root, 'catalog.mjs')
const launches = join(catalog.root, 'catalog-launches')
writeFileSync(file, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(launches)}, '1')
console.log(${JSON.stringify(JSON.stringify({data:[
  {providerID:'opencode',id:'beam-free',limit:{context:1048576,output:131072}},
  {providerID:'opencode',id:'deepseek-v4.1-flash-free',limit:{context:200000,output:32000}},
  {providerID:'opencode',id:'deepseek-v4.1-flash',limit:{context:1000000,output:384000}},
]}))})`)
catalog.adapter.config.providers.opencode.modelInfoArgs = [file]
await Promise.all([
  catalog.adapter.listModels('opencode'),
  catalog.adapter.resolveModel('opencode','opencode/beam-free'),
  catalog.adapter.resolveModel('opencode','opencode/deepseek-v4.1-flash-free'),
])
assertEqual(readFileSync(launches,'utf8'),'1','concurrent cold model reads share one OpenCode catalog process')
catalog.adapter.invalidateCaches()
await catalog.adapter.listModels('opencode')
assertEqual(readFileSync(launches,'utf8'),'11','forced refresh starts a fresh catalog process')
assertEqual(catalog.adapter.limitsFor('opencode','opencode/beam-free').contextWindow,1048576,'million-context free models preserve their published capacity')
assertEqual(catalog.adapter.limitsFor('opencode','opencode/deepseek-v4.1-flash-free').contextWindow,200000,'a configured cap cannot inflate a smaller published capacity')
assertEqual(catalog.adapter.limitsFor('opencode','opencode/deepseek-v4.1-flash').contextWindow,500000,'other catalog models use the requested 500k cap')
assertEqual(catalog.adapter.limitsFor('opencode','opencode/deepseek-v4.1-flash').providerContextWindow,1000000,'the native OpenCode window remains available alongside the cap')
assertEqual(catalog.adapter.limitsFor('opencode','opencode/deepseek-v4.1-flash').maxOutputTokens,384000,'output limits retain the published value')
const codex = mount({ providers: { grok: false, opencode: false, codex: {
  bin: process.execPath, contextWindow: 200000,
  models: ['short', 'long', 'unknown', { id: 'override', contextWindow: 128000 }],
} } })
const codexCatalog = join(codex.root, 'models.json')
writeFileSync(codexCatalog, JSON.stringify({ models: [
  { slug: 'short', context_window: 272000, max_context_window: 872000 },
  { slug: 'long', context_window: 500000, effective_context_window_percent: 95 },
  { slug: 'override', context_window: 500000 },
] }))
codex.adapter.config.providers.codex.modelsCacheFile = codexCatalog
assertEqual((await codex.adapter.resolveModel('codex','short')).context.contextWindow,272000,'Codex uses the exact model effective window, not its maximum')
assertEqual(codex.adapter.limitsFor('codex','long').contextWindow,475000,'another model keeps its own window and CLI safety margin')
assertEqual(codex.adapter.limitsFor('codex','long').providerContextWindow,500000,'the nominal Codex window is reported separately')
assertEqual(codex.adapter.limitsFor('codex','long').source,'Codex model catalog','the source is identified')
assertEqual(codex.adapter.limitsFor('codex','unknown').contextWindow,200000,'an unlisted model uses the route fallback')
assertEqual(codex.adapter.limitsFor('codex','override').contextWindow,128000,'an explicit per-model override still wins')
const grok = mount({ providers: { codex:false, opencode:false, grok:{bin:process.execPath,
  models:[{id:'grok-4.7',contextWindow:192000}],
} } })
const grokCatalog = join(grok.root,'models.json')
writeFileSync(grokCatalog, JSON.stringify({models:{'grok-4.7':{info:{context_window:256000,context_windows:[256000,500000]}},unknown:{info:{context_windows:[500000]}}}}))
grok.adapter.config.providers.grok.modelsCacheFile = grokCatalog
assertEqual(grok.adapter.limitsFor('grok','grok-4.7').providerContextWindow,256000,'Grok uses its published default, not the optional 500k window')
assertEqual(grok.adapter.limitsFor('grok','grok-4.7').contextWindow,192000,'Grok retains the configured limit')
assertEqual(grok.adapter.limitsFor('grok','grok-4.7@500k').providerContextWindow,undefined,'an unlisted Grok alias does not inherit base metadata')
assertEqual(grok.adapter.limitsFor('grok','unknown').providerContextWindow,undefined,'optional windows alone do not establish the active provider window')
console.log('ok  model-limits.test')
