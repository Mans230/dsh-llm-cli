export const WINDOWS = [
  { label: '5h', value: 5 / 24 }, { label: '7h', value: 7 / 24 },
  { label: '24h', value: 1 }, { label: '7d', value: 7 },
  { label: '30d', value: 30 }, { label: '90d', value: 90 }, { label: 'All time', value: 0 },
]
export const CLI_NAMES = { codex: 'Codex', opencode: 'OpenCode', grok: 'Grok' }
export const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens', 'totalTokens', 'costUsd', 'turns', 'steps']
export const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
export const compact = value => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(number(value))
export const dollars = value => new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(number(value))
// Timestamped sources (Codex/Grok) include cache reads inside input. Reasoning
// stays inside output; it is never another stacked series.
export const toChartSeries = rows => rows.map(row => ({ ...row, inputTokens: Math.max(0, number(row.inputTokens) - number(row.cacheReadTokens)) }))
const empty = () => Object.fromEntries(FIELDS.map(key => [key, 0]))
const add = (target, row) => { FIELDS.forEach(key => { target[key] += number(row[key]) }); return target }

// Keys include the provider: two CLIs can record the same model independently.
export function modelOptions(data, provider = 'all') {
  const choices = new Map()
  for (const id of Object.keys(CLI_NAMES)) {
    if (provider !== 'all' && provider !== id) continue
    for (const model of data.cliUsage?.[id]?.models ?? []) choices.set(`${id}:${model.id}`, { provider: id, id: model.id })
    for (const route of data.routes ?? []) if (route.id === id) {
      for (const model of route.models ?? []) choices.set(`${id}:${model.id}`, { provider: id, id: model.id })
    }
  }
  return [...choices.values()].sort((a, b) => a.id.localeCompare(b.id) || a.provider.localeCompare(b.provider))
}

export function selectUsage(data, { provider = 'all', model = 'all', days = 7 } = {}) {
  const now = number(data.generatedAt) || Date.now()
  const since = days > 0 ? now - days * 86400000 : 0
  const ids = Object.keys(CLI_NAMES).filter(id => provider === 'all' || id === provider)
  const sources = ids.map(id => {
    const usage = data.cliUsage?.[id]
    const matching = (usage?.models ?? []).filter(row => model === 'all' || row.id === model)
    const totals = model === 'all' ? { ...empty(), ...usage } : matching.reduce(add, empty())
    const events = (usage?.timeline ?? []).filter(row => row.at >= since && row.at <= now && (model === 'all' || row.model === model))
    return { id, name: CLI_NAMES[id], usage, totals, events, available: usage?.available === true, measured: usage?.available === true && (model === 'all' || matching.length > 0) }
  })
  const measured = sources.filter(source => source.measured)
  const totals = measured.reduce((sum, source) => add(sum, source.totals), empty())
  const reportedCost = measured.filter(source => source.usage.capabilities?.cost !== false)
  totals.costUsd = reportedCost.reduce((sum, source) => sum + number(source.totals.costUsd), 0)
  const events = sources.flatMap(source => source.events.map(row => ({ ...row, provider: source.id })))
  const hourly = days > 0 && days <= 1
  const bucketMs = hourly ? 3600000 : 86400000
  const times = events.map(row => row.at).concat(sources.flatMap(source => (source.usage?.daily ?? []).map(row => Date.parse(`${row.date}T00:00:00Z`)).filter(Number.isFinite)))
  const earliest = times.length ? times.reduce((min, at) => Math.min(min, at), now) : now - 6 * 86400000
  const start = Math.floor((since || earliest) / bucketMs) * bucketMs
  const end = Math.floor(now / bucketMs) * bucketMs
  // Lifetime is grouped into larger buckets when needed, without dropping data.
  const stride = Math.max(1, Math.ceil((end - start + bucketMs) / bucketMs / 120))
  const interval = stride * bucketMs
  const buckets = new Map()
  for (let at = start; at <= end; at += interval) buckets.set(at, { at, ...empty() })
  for (const event of events) {
    const at = start + Math.floor((event.at - start) / interval) * interval
    if (buckets.has(at)) add(buckets.get(at), event)
  }
  // OpenCode activity has steps per day, not daily token or cost counters.
  for (const source of measured) if (source.id === 'opencode' && model === 'all' && !hourly) {
    for (const day of source.usage.daily ?? []) {
      const time = Date.parse(`${day.date}T00:00:00Z`)
      const at = start + Math.floor((time - start) / interval) * interval
      if (buckets.has(at)) buckets.get(at).steps += number(day.steps)
    }
  }
  const models = sources.flatMap(source => (source.usage?.models ?? []).filter(row => model === 'all' || row.id === model).map(row => ({ ...row, provider: source.id, costAvailable: source.usage.capabilities?.cost !== false })))
    .sort((a, b) => number(b.totalTokens) - number(a.totalTokens))
  const warnings = sources.flatMap(source => {
    if (!source.usage) return [`${source.name}: no usage source is configured.`]
    if (!source.available) return [`${source.name}: ${source.usage.note || 'no recorded usage in this range'}.`]
    const notes = []
    if (source.id === 'opencode') notes.push(`OpenCode provides whole-day totals and daily steps. Hourly and per-model token history are unavailable.${source.usage.scopeDays > days && days > 0 ? ` Totals cover ${source.usage.scopeDays} full day(s).` : ''}`)
    if (source.usage.timelinePrecision === 'session') notes.push(`${source.name} history groups session totals by last activity; this is not exact turn timing.`)
    return notes
  })
  return { sources, totals, models, series: [...buckets.values()], hourly, hasData: measured.length > 0, costAvailable: reportedCost.length > 0, partialCost: reportedCost.length < measured.length, warnings }
}
