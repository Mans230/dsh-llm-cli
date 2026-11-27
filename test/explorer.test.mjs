import { selectUsage, modelOptions, toChartSeries } from '../src/usage-data.js'
import { assertEqual, assert } from './_assert.mjs'
const now = Date.parse('2026-11-26T12:35:00Z')
const data = { generatedAt: now, routes: [{ id: 'codex', models: [{ id: 'unused' }] }], cliUsage: {
  codex: { available: true, totalTokens: 180, capabilities: { cost: false }, models: [{ id: 'same', totalTokens: 180 }], timelinePrecision: 'event', timeline: [
    { at: now - 8 * 3600000, model: 'same', totalTokens: 110 },
    { at: now - 3600000, model: 'same', totalTokens: 70 },
  ] },
  opencode: { available: true, totalTokens: 30, costUsd: 0.12, scopeDays: 1, capabilities: { cost: true }, models: [{ id: 'same', totalTokens: 30, costUsd: 0.12 }], daily: [] },
} }
assertEqual(selectUsage(data, { provider: 'codex', model: 'same', days: 7 / 24 }).series.reduce((sum, row) => sum + row.totalTokens, 0), 70, '7h history excludes older events')
assertEqual(selectUsage(data, { provider: 'codex', days: 1 }).series.reduce((sum, row) => sum + row.totalTokens, 0), 180, '24h retains both events')
assertEqual(selectUsage(data, { provider: 'opencode', model: 'same', days: 7 }).totals.totalTokens, 30, 'a model is scoped to its CLI')
assertEqual(selectUsage(data, { provider: 'codex', model: 'unused' }).hasData, false, 'unused models do not inherit provider totals')
assertEqual(modelOptions(data).filter(row => row.id === 'same').length, 2, 'identical model names across CLIs remain separate')
assert(selectUsage(data, { provider: 'opencode', days: 7 / 24 }).warnings.some(note => note.includes('full day')), 'coarse ranges explain their actual scope')
assertEqual(selectUsage(data).partialCost, true, 'combined cost identifies missing CLI costs')
assertEqual(selectUsage(data, { provider: 'codex' }).costAvailable, false, 'Codex cost stays unknown')
const point = toChartSeries([{ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5 }])[0]
assertEqual(point.inputTokens + point.outputTokens + point.cacheReadTokens, 120, 'chart stacks count cache once and keep reasoning inside output')
console.log('ok  explorer.test')
