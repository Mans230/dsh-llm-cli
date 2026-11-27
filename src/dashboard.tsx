import * as React from 'react'
import { BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Activity, ArrowUpRight, ChevronDown, RefreshCw, Search, Terminal, X } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardDescription, CardPanel } from './ui/card'
import { Button } from './ui/button'
import { Tabs, TabsList, TabsTab, TabsPanel } from './ui/tabs'
import { CLI_NAMES, WINDOWS, selectUsage, modelOptions, toChartSeries, compact, dollars, number } from './usage-data'

const colors = { inputTokens: 'var(--du-blue)', outputTokens: 'var(--du-teal)', cacheReadTokens: 'var(--du-cache)', totalTokens: 'var(--du-blue)', costUsd: 'var(--du-blue)', turns: 'var(--du-blue)', steps: 'var(--du-blue)' }
const labels = { inputTokens: 'Uncached input', outputTokens: 'Output', cacheReadTokens: 'Cache read', totalTokens: 'Tokens', costUsd: 'Reported cost', turns: 'Usage events', steps: 'OpenCode steps' }
const stamp = at => at ? new Date(at).toLocaleString() : 'Unknown'
const fmt = (key, value) => key === 'costUsd' ? dollars(value) : compact(value)

function Empty({ children }) { return <div className="du-empty"><Activity size={22} strokeWidth={1.5}/><p>{children}</p></div> }
function Stat({ label, value, detail }) { return <div className="du-stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div> }
function Panel({ title, description, children, action = null }) {
  return <Card className="du-panel"><CardHeader className="du-panel-heading"><div><CardTitle>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div>{action}</CardHeader><CardPanel>{children}</CardPanel></Card>
}
function Mix({ usage, provider }) {
  const cache = number(usage.cacheReadTokens)
  const input = Math.max(0, number(usage.inputTokens) - (provider === 'opencode' ? 0 : cache))
  const parts = [{ label: 'Uncached input', value: input, color: colors.inputTokens }, { label: 'Output', value: number(usage.outputTokens), color: colors.outputTokens }, { label: 'Cache read', value: cache, color: colors.cacheReadTokens }]
  const total = parts.reduce((sum, row) => sum + row.value, 0)
  return <div className="du-mix"><div className="du-mix-track" role="img" aria-label={parts.map(row => `${row.label}: ${compact(row.value)}`).join(', ')}>{parts.map(row => <span key={row.label} style={{ width: `${total ? row.value / total * 100 : 0}%`, background: row.color }}/>)}</div><div className="du-mix-legend">{parts.map(row => <div key={row.label}><i style={{ background: row.color }}/><span>{row.label}</span><b>{compact(row.value)}</b></div>)}</div>{number(usage.reasoningTokens) > 0 && <p className="du-help">{compact(usage.reasoningTokens)} reasoning tokens included in output.</p>}</div>
}
function History({ view, metric, provider, model }) {
  const mixed = metric === 'totalTokens'
  const openOnly = view.sources.every(source => source.id === 'opencode')
  const unsupported = (openOnly && (metric !== 'steps' || view.hourly || model !== 'all')) || (metric === 'costUsd' && !view.costAvailable) || (metric === 'steps' && (view.hourly || model !== 'all' || provider === 'codex' || provider === 'grok'))
  if (unsupported) return <Empty>This CLI does not report {labels[metric].toLowerCase()} history for this scope.</Empty>
  if (!view.hasData) return <Empty>No recorded usage for this selection. Choose another model or time range.</Empty>
  const series = toChartSeries(view.series)
  const keys = mixed ? ['inputTokens', 'outputTokens', 'cacheReadTokens'] : [metric]
  const hasHistory = series.some(row => keys.some(key => row[key] > 0))
  if (!hasHistory) return <Empty>No timestamped {labels[metric].toLowerCase()} recorded in this range.</Empty>
  return <><div className="du-chart" aria-label={`${labels[metric]} history in UTC`}><ResponsiveContainer width="100%" height={260}><BarChart data={series} margin={{ top: 12, right: 8, left: 0, bottom: 0 }} accessibilityLayer>
    <CartesianGrid vertical={false} stroke="var(--du-border)" strokeDasharray="3 5"/>
    <XAxis dataKey="at" axisLine={false} tickLine={false} minTickGap={32} tick={{ fill: 'var(--du-muted)', fontSize: 11 }} tickFormatter={at => new Date(at).toLocaleString('en', view.hourly ? { hour: '2-digit', hour12: false, timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })}/>
    <YAxis width={50} axisLine={false} tickLine={false} tick={{ fill: 'var(--du-muted)', fontSize: 11 }} tickFormatter={value => fmt(metric, value)}/>
    <Tooltip cursor={{ fill: 'var(--du-hover)' }} contentStyle={{ background: 'var(--du-surface)', border: '1px solid var(--du-border)', borderRadius: 8, color: 'var(--du-text)', fontSize: 12 }} labelFormatter={at => `${new Date(Number(at)).toLocaleString('en', { timeZone: 'UTC' })} UTC`} formatter={(value, key) => [fmt(metric, value), labels[key] ?? key]}/>
    {keys.map(key => <Bar key={key} dataKey={key} stackId="usage" fill={colors[key]} maxBarSize={36} isAnimationActive={false} />)}
  </BarChart></ResponsiveContainer></div><div className="du-chart-footer"><div className="du-legend">{keys.map(key => <span key={key}><i style={{ background: colors[key] }}/>{labels[key]}</span>)}</div><span>UTC · {view.hourly ? 'hourly' : 'daily / grouped'} buckets</span></div>
  {view.sources.some(source => source.id === 'opencode' && source.measured) && metric !== 'steps' && <p className="du-help">OpenCode totals are included above; its token history is unavailable and is excluded from this chart.</p>}</>
}
function Limit({ title, used, detail, note }) {
  const percentage = Math.max(0, Math.min(100, number(used)))
  return <div className="du-limit"><div className="du-row"><strong>{title}</strong><span>{Math.round(percentage)}% used</span></div><div className="du-limit-track" role="meter" aria-label={title} aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percentage}%`, background: percentage >= 90 ? 'var(--du-danger)' : percentage >= 70 ? 'var(--du-warning)' : 'var(--du-blue)' }}/></div><p>{detail}</p>{note && <p>{note}</p>}</div>
}

export function UsageExplorer({ data, days = 7, onDaysChange, refreshing = false, onRefresh, auto = true, onAutoChange, providerStatus = [] }) {
  const [provider, setProvider] = React.useState('all')
  const [model, setModel] = React.useState('all')
  const [metric, setMetric] = React.useState('totalTokens')
  const [query, setQuery] = React.useState('')
  const [tab, setTab] = React.useState('overview')
  // Keep the displayed totals labelled with the loaded snapshot while a new
  // range is loading; a failed refresh must never relabel old totals as new.
  const loadedDays = data.windowDays ?? days
  const view = selectUsage(data, { provider, model, days: loadedDays })
  const options = modelOptions(data, provider)
  const name = model !== 'all' ? model : provider === 'all' ? 'All CLIs' : CLI_NAMES[provider]
  const setScope = id => { setProvider(id); setModel('all') }
  const inspect = row => { setProvider(row.provider); setModel(row.id); setTab('overview') }
  const period = WINDOWS.find(window => window.value === loadedDays)?.label ?? `${loadedDays}d`
  const filteredModels = view.models.filter(row => `${row.id} ${CLI_NAMES[row.provider]}`.toLowerCase().includes(query.toLowerCase()))
  const recent = (data.recent ?? []).filter(row => (provider === 'all' || row.provider === provider) && (model === 'all' || row.model === model) && (!(loadedDays > 0) || row.at >= data.generatedAt - loadedDays * 86400000))
  const routes = (data.routes ?? []).filter(route => provider === 'all' || route.id === provider)
  const latestByModel = new Map()
  for (const entry of data.recent ?? []) {
    const key = `${entry.provider}:${entry.model}`
    if (!latestByModel.has(key)) latestByModel.set(key, entry)
  }
  const freeLimitFailures = [...latestByModel.values()].filter(entry => entry.provider === 'opencode' && !entry.ok && /free usage limit reached/i.test(entry.error ?? ''))
  const chartActions = <label className="du-select du-metric"><span className="du-sr-only">Chart metric</span><select aria-label="Chart metric" value={metric} onChange={event => setMetric(event.target.value)}>{['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'costUsd', 'turns', 'steps'].map(key => <option key={key} value={key}>{labels[key]}</option>)}</select><ChevronDown size={13}/></label>
  return <div className="du-explorer" data-ui>
    <header className="du-header"><div><div className="du-product"><Terminal size={15}/>DeepSeek Harness / CLI analytics</div><h1>Usage, in focus.</h1><p>Explore your CLIs, models, and recorded usage.</p></div><Button variant="outline" onClick={onRefresh} disabled={refreshing} aria-label="Refresh usage"><RefreshCw size={14} className={refreshing ? 'du-spinning' : ''}/>{refreshing ? 'Refreshing…' : 'Refresh'}</Button></header>
    <section className="du-readiness" aria-label="Provider status">{(data.routes ?? []).map(route => {
      const installed = providerStatus.find(item => item.id === route.id)?.installed
      const status = installed === false ? 'CLI not installed' : route.signedIn === true ? 'Signed in' : route.signInOptional ? 'Free models need no sign-in' : route.signedIn === false ? 'Signed out' : 'Sign-in status unknown'
      return <div key={route.id}><strong>{route.displayName || CLI_NAMES[route.id]}</strong><span>{status}</span>{installed === false ? <small>Install the CLI under Host management.</small> : route.signedIn === false && !route.signInOptional ? <small>Sign in on the Harness host under Host management.</small> : null}</div>
    })}</section>
    {freeLimitFailures.map(entry => <p className="du-scope-warning" key={entry.model}>{entry.model} hit its free usage limit on its last recorded request ({stamp(entry.at)}). Choose another model if it still fails.{entry.retryAt > Date.now() ? ` Provider retry time: ${stamp(entry.retryAt)}.` : ''}</p>)}
    <div className="du-filterbar"><div className="du-scope-tabs" role="group" aria-label="CLI filter">{['all', 'codex', 'opencode', 'grok'].map(id => <Button key={id} variant="ghost" size="sm" aria-pressed={provider === id} onClick={() => setScope(id)}>{id === 'all' ? 'All CLIs' : CLI_NAMES[id]}</Button>)}</div><div className="du-periods" role="group" aria-label="Time range">{WINDOWS.map(window => <Button key={window.label} variant="ghost" size="sm" aria-pressed={days === window.value} onClick={() => onDaysChange?.(window.value)}>{window.label}</Button>)}</div></div>
    <div className="du-context"><label className="du-select"><span>Model</span><select aria-label="Model filter" value={model === 'all' ? 'all' : `${provider}:${model}`} onChange={event => { const selected = options.find(row => `${row.provider}:${row.id}` === event.target.value); if (selected) { setProvider(selected.provider); setModel(selected.id) } else setModel('all') }}><option value="all">All models</option>{options.map(row => <option key={`${row.provider}:${row.id}`} value={`${row.provider}:${row.id}`}>{row.id}{provider === 'all' ? ` · ${CLI_NAMES[row.provider]}` : ''}</option>)}</select><ChevronDown size={13}/></label>{model !== 'all' && <Button variant="ghost" size="sm" onClick={() => setModel('all')}><X size={13}/>Clear model</Button>}<span className="du-freshness">Updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<label><input type="checkbox" checked={auto} onChange={event => onAutoChange?.(event.target.checked)}/>Live · 30s</label></span></div>
    <Tabs value={tab} onValueChange={setTab} className="du-main-tabs"><TabsList variant="underline" aria-label="Dashboard view"><TabsTab value="overview">Overview</TabsTab><TabsTab value="models">Models <span className="du-count">{view.models.length}</span></TabsTab><TabsTab value="activity">Harness activity</TabsTab><TabsTab value="limits">Limits & budgets</TabsTab></TabsList>
      <TabsPanel value="overview"><section className="du-stat-strip" aria-label={`${name} usage in ${period}`}><Stat label="Recorded tokens" value={view.hasData ? compact(view.totals.totalTokens) : '—'} detail={`${name} · ${period}`}/><Stat label="Output tokens" value={view.hasData ? compact(view.totals.outputTokens) : '—'} detail="Includes reasoning"/><Stat label="Cache reads" value={view.hasData ? compact(view.totals.cacheReadTokens) : '—'} detail="Reused input tokens"/><Stat label="Reported cost" value={view.costAvailable ? dollars(view.totals.costUsd) : '—'} detail={view.partialCost ? 'Partial · excludes unreported costs' : view.costAvailable ? 'As recorded by the CLI' : 'This CLI does not report cost'}/></section>
        <Panel title={`${name} · ${labels[metric].toLowerCase()}`} description={`${period} · CLI-recorded accounting`} action={chartActions}><History view={view} metric={metric} provider={provider} model={model}/>{view.sources.some(source => source.measured && (source.usage.timelinePrecision === 'session' || source.usage.timelinePrecision === 'mixed')) && <p className="du-help">Session history is grouped by last activity, rather than exact turn timestamps.</p>}</Panel>
        <div className="du-two-column"><Panel title={model === 'all' ? 'Usage by CLI' : 'Model token mix'} description={model === 'all' ? 'Select a CLI to inspect its models' : `${CLI_NAMES[provider]} · ${model}`}>
          {provider === 'all' ? <div className="du-cli-list">{view.sources.map(source => <button className="du-cli-row" key={source.id} onClick={() => setScope(source.id)}><span className="du-cli-name"><Terminal size={15}/>{source.name}</span><span>{source.available ? compact(source.totals.totalTokens) : '—'}<ArrowUpRight size={14}/></span><div className="du-cli-track"><span style={{ width: `${view.totals.totalTokens ? number(source.totals.totalTokens) / view.totals.totalTokens * 100 : 0}%` }}/></div><small>{source.available ? `${compact(source.totals.turns || source.totals.steps)} ${source.id === 'opencode' ? 'steps' : source.id === 'codex' ? 'usage events' : 'turns'}` : source.usage?.note || 'Not configured'}</small></button>)}</div> : view.hasData ? <Mix usage={view.totals} provider={provider}/> : <Empty>No usage recorded for this model.</Empty>}
        </Panel><Panel title="Most used models" description="Ranked by recorded tokens" action={<Button variant="ghost" size="sm" onClick={() => setTab('models')}>View all<ArrowUpRight size={13}/></Button>}>{view.models.length ? <div className="du-ranking">{view.models.slice(0, 5).map(row => <button key={`${row.provider}:${row.id}`} onClick={() => inspect(row)}><span><strong>{row.id}</strong><small>{CLI_NAMES[row.provider]}</small></span><span>{compact(row.totalTokens)}<ArrowUpRight size={13}/></span></button>)}</div> : <Empty>No model usage in this range.</Empty>}</Panel></div>
      </TabsPanel>
      <TabsPanel value="models"><Panel title="Model explorer" description={`${filteredModels.length} models · ${period}`} action={<label className="du-search"><Search size={14}/><input aria-label="Search models" placeholder="Search models…" value={query} onChange={event => setQuery(event.target.value)}/></label>}><div className="du-table-wrap"><table><thead><tr><th>Model / CLI</th><th>Tokens</th><th>Input</th><th>Output</th><th>Cache read</th><th>Reported cost</th><th><span className="du-sr-only">Action</span></th></tr></thead><tbody>{filteredModels.map(row => <tr key={`${row.provider}:${row.id}`}><td><strong>{row.id}</strong><small>{CLI_NAMES[row.provider]}</small></td><td>{compact(row.totalTokens)}</td><td>{compact(row.inputTokens)}</td><td>{compact(row.outputTokens)}</td><td>{compact(row.cacheReadTokens)}</td><td>{row.costAvailable ? dollars(row.costUsd) : '—'}</td><td><Button variant="ghost" size="sm" aria-label={`Inspect ${CLI_NAMES[row.provider]} ${row.id}`} onClick={() => inspect(row)}>Inspect<ArrowUpRight size={13}/></Button></td></tr>)}</tbody></table></div>{!filteredModels.length && <Empty>No models match this selection.</Empty>}</Panel></TabsPanel>
      <TabsPanel value="activity"><Panel title="Recent Harness turns" description={`Latest retained Harness turns ? ${period}. This list is separate from CLI-wide accounting and may not cover the full selected range.`}><div className="du-table-wrap"><table><thead><tr><th>Model / CLI</th><th>When</th><th>Input / output</th><th>First text</th><th>Total time</th><th>Result</th></tr></thead><tbody>{recent.map((row, index) => <tr key={index}><td><strong>{row.model}</strong><small>{CLI_NAMES[row.provider] ?? row.provider}</small></td><td>{stamp(row.at)}</td><td>{Number.isFinite(row.inputTokens) ? compact(row.inputTokens) : '?'} / {Number.isFinite(row.outputTokens) ? compact(row.outputTokens) : '?'}</td><td>{Number.isFinite(row.firstTextMs) ? `${(row.firstTextMs / 1000).toFixed(2)}s` : '?'}</td><td>{(number(row.ms) / 1000).toFixed(2)}s</td><td><span className={row.ok ? 'du-status' : 'du-status du-failed'}>{row.ok ? 'Completed' : `${row.error || 'Failed'}${row.retryAt > Date.now() ? ` ? Retry after ${stamp(row.retryAt)}` : ''}`}</span></td></tr>)}</tbody></table></div>{!recent.length && <Empty>No retained Harness turns for this selection.</Empty>}</Panel></TabsPanel>
      <TabsPanel value="limits"><Panel title="Subscription limits & budgets" description="Account and billing windows are independent of the selected usage range or model.">
        {provider === 'all' || provider === 'codex' ? ['primary', 'secondary'].map(key => { const usage = data.cliUsage?.codex; const limit = usage?.limits?.[key]; return limit ? <Limit key={key} title={key === 'primary' ? 'Codex 5-hour limit' : 'Codex weekly limit'} used={limit.usedPercent} detail={`Resets ${stamp(limit.resetsAt)}`} note={`${usage.limitsSource === 'live' ? 'Live quota checked:' : 'Recorded snapshot:'} ${stamp(usage.limitsObservedAt?.[key])}${usage.limitsStale?.[key] ? ' (stale)' : ''}. ${usage.limitsSource === 'live' ? 'Refresh queries Codex account quota.' : 'Live quota unavailable; showing the recorded CLI snapshot.'}`}/> : null }) : null}
        {(provider === 'all' || provider === 'grok') && data.plans?.grokWeekly && <Limit title="Grok weekly premium limit" used={data.plans.grokWeekly.usedPercent} detail={`Resets ${stamp(data.plans.grokWeekly.resetsAt)} · ${data.plans.grokWeekly.source || 'configured budget'}`}/>}
        {['grok', 'opencode'].filter(id => provider === 'all' || provider === id).map(id => { const plan = data.plans?.[id]; return plan ? <Limit key={id} title={`${CLI_NAMES[id]} usage budget`} used={number(plan.percent) * 100} detail={plan.metric === 'tokens' ? `${compact(plan.usedTokens)} / ${compact(plan.budgetTokens)} tokens` : `${dollars(plan.usedUsd)} / ${dollars(plan.budgetUsd)}`} note={`Billing reset day ${plan.resetDay}`}/> : null })}
        {!((provider === 'all' || provider === 'codex') && Object.values(data.cliUsage?.codex?.limits ?? {}).some(Boolean)) && !Object.keys(data.plans ?? {}).some(key => provider === 'all' || key.startsWith(provider)) && <Empty>No subscription quota or configured budget is available for this selection.</Empty>}
      </Panel><Panel title="Published model limits" description="Limits reported by each CLI, with the source shown for fallback values."><div className="du-table-wrap"><table><thead><tr><th>Model / CLI</th><th>Harness context</th><th>Provider context</th><th>Max output</th><th>Source</th></tr></thead><tbody>{routes.flatMap(route => (route.models ?? []).filter(row => model === 'all' || row.id === model).map(row => <tr key={`${route.id}:${row.id}`}><td><strong>{row.id}</strong><small>{route.displayName}</small></td><td>{row.contextWindow ? compact(row.contextWindow) : '—'}</td><td>{row.maxOutputTokens ? compact(row.maxOutputTokens) : '—'}</td><td>{row.source || 'Not reported'}</td></tr>))}</tbody></table></div></Panel></TabsPanel>
    </Tabs>
    {view.warnings.length > 0 && <details className="du-notes"><summary>Data coverage · {view.warnings.length} {view.warnings.length === 1 ? 'note' : 'notes'}</summary>{view.warnings.map(note => <p key={note}>{note}</p>)}</details>}
    {view.sources.some(source => source.id === 'opencode' && source.measured && source.usage.scopeDays > days && days > 0) && <p className="du-scope-warning">OpenCode totals cover {view.sources.find(source => source.id === 'opencode').usage.scopeDays} full day(s); an exact {period} breakdown is unavailable.</p>}
    <footer className="du-footer"><span>CLI-recorded usage · source availability varies</span><a href={`/llm-cli/usage.json?days=${days || 'all'}`} target="_blank" rel="noreferrer">View JSON<ArrowUpRight size={12}/></a></footer>
  </div>
}
