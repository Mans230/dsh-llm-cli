// Browser half of dsh-llm-cli: the plugin's own page on the Web client.
//
// It renders the model routes this plugin serves (the OpenCode and Grok CLIs
// installed on the host), the per-model limits each CLI publishes, and two
// independent usage views:
//   * "this harness" — the turns this DSH instance recorded (the /llm-cli
//     ledger), and
//   * "CLI-recorded" — what the CLIs themselves account for: the Grok CLI's
//     persisted per-session token/cost files and `opencode stats`.
// The page is registered twice: as a card in the Plugins panel and as a page
// in Settings. Charts are hand-rolled SVG so the page needs no chart library.
//
// Loaded by the web client's module loader through this package's
// `dsh.client` manifest and `./client` export.
window.__ModuleLoader__.load({
  id: 'dsh-llm-cli',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const h = (...args) => React.createElement(...args)

    // Accent palette. These read on both light and dark themes, and the rest of
    // the page leans on currentColor so it follows the app theme.
    const COLOR = {
      input: '#5b9dff',
      output: '#46c98b',
      cache: '#a97bff',
      reasoning: '#e9a15a',
      cost: '#e46c8f',
      warn: '#e9b34a',
      bad: '#e46c6c',
    }
    const HAIR = '1px solid rgba(128,128,128,.32)'
    /** The trailing windows the page can request, defaulting to 7 days. */
    const WINDOWS = [
      { label: '5h', value: 5 / 24 },
      { label: '7d', value: 7 },
      { label: '30d', value: 30 },
      { label: '90d', value: 90 },
      { label: 'all', value: 0 },
    ]

    const S = {
      lead: { fontSize: '13px', lineHeight: 1.55, opacity: 0.78, margin: '0 0 4px', maxWidth: '80ch' },
      note: { fontSize: '12px', lineHeight: 1.55, opacity: 0.65, margin: '10px 0 0', maxWidth: '80ch' },
      heading: { fontSize: '12px', fontWeight: 650, margin: '22px 0 8px', textTransform: 'uppercase', letterSpacing: '.06em', opacity: 0.6 },
      subheading: { fontSize: '12px', fontWeight: 600, opacity: 0.7, margin: '2px 0 6px' },
      cards: { display: 'flex', flexWrap: 'wrap', gap: '10px' },
      card: { border: HAIR, borderRadius: '10px', padding: '10px 14px', minWidth: '168px', flex: '0 1 220px' },
      k: { fontSize: '11px', opacity: 0.6 },
      v: { fontSize: '20px', fontWeight: 650, marginTop: '2px' },
      wrap: { overflowX: 'auto', border: HAIR, borderRadius: '10px' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
      th: { textAlign: 'left', padding: '7px 10px', borderBottom: HAIR, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', opacity: 0.6, fontWeight: 600, whiteSpace: 'nowrap' },
      td: { padding: '7px 10px', borderBottom: '1px solid rgba(128,128,128,.18)', whiteSpace: 'nowrap' },
      last: { padding: '7px 10px', whiteSpace: 'nowrap' },
      pill: { display: 'inline-block', fontSize: '11px', borderRadius: '999px', padding: '1px 8px', border: '1px solid rgba(128,128,128,.4)', opacity: 0.85, marginLeft: '6px' },
      link: { fontSize: '13px' },
      chartCard: { border: HAIR, borderRadius: '10px', padding: '10px 12px 6px', margin: '0 0 12px', overflow: 'hidden' },
      legend: { display: 'flex', flexWrap: 'wrap', gap: '10px', margin: '2px 0 6px', fontSize: '11px', opacity: 0.7 },
      legendItem: { display: 'inline-flex', alignItems: 'center', gap: '5px' },
      swatch: { width: '10px', height: '10px', borderRadius: '3px', display: 'inline-block' },
      toolbarRow: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 6px' },
      button: { fontSize: '12px', padding: '3px 10px', borderRadius: '7px', border: HAIR, background: 'transparent', color: 'inherit', cursor: 'pointer' },
      muted: { opacity: 0.6 },
    }

    // ---------------------------------------------------------------- format
    function counts(value) {
      const n = Number(value) || 0
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
      return String(n)
    }
    function usd4(value) {
      return `$${(Number(value) || 0).toFixed(4)}`
    }
    function usd2(value) {
      return `$${(Number(value) || 0).toFixed(2)}`
    }
    function percent(value) {
      return `${((Number(value) || 0) * 100).toFixed(1)}%`
    }
    function when(at) {
      return at ? new Date(at).toLocaleString('en-GB', { hour12: false }) : '\u2014'
    }
    function shortDay(date) {
      return typeof date === 'string' ? date.slice(5) : String(date)
    }
    /**
     * Present a trailing window as a continuous day series so a "7d" chart
     * really shows seven days, with quiet days drawn as zero. Windows of 0
     * ("all") pass the recorded rows through untouched.
     */
    function fillWindow(rows, windowDays, toPoint) {
      const list = Array.isArray(rows) ? rows : []
      if (!(windowDays >= 1)) return list.map((row) => toPoint(row.date, row))
      const byDate = new Map(list.map((row) => [row.date, row]))
      const points = []
      for (let back = windowDays - 1; back >= 0; back -= 1) {
        const date = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10)
        points.push(toPoint(date, byDate.get(date)))
      }
      return points
    }

    // ------------------------------------------------------------- primitives
    function Panel({ title, right, children }) {
      return h(
        'div',
        { style: S.chartCard },
        (title || right) &&
          h(
            'div',
            { style: S.toolbarRow },
            h('div', { style: S.subheading }, title),
            right ?? null,
          ),
        children,
      )
    }

    function StatCard({ label, value, sub, tone }) {
      return h(
        'div',
        { style: S.card },
        h('div', { style: S.k }, label),
        h('div', { style: { ...S.v, color: tone ?? 'inherit' } }, value),
        sub ? h('div', { style: S.k }, sub) : null,
      )
    }

    function Legend({ series }) {
      return h(
        'div',
        { style: S.legend },
        series.map((item) =>
          h(
            'span',
            { key: item.key, style: S.legendItem },
            h('span', { style: { ...S.swatch, background: item.color } }),
            item.label,
          ),
        ),
      )
    }

    function Table({ head, rows, empty }) {
      if (rows.length === 0) return h('p', { style: S.note }, empty)
      return h(
        'div',
        { style: S.wrap },
        h(
          'table',
          { style: S.table },
          h('thead', null, h('tr', null, head.map((cell, index) => h('th', { key: index, style: S.th }, cell)))),
          h(
            'tbody',
            null,
            rows.map((cells, rowIndex) =>
              h(
                'tr',
                { key: rowIndex },
                cells.map((cell, cellIndex) =>
                  h('td', { key: cellIndex, style: cellIndex === cells.length - 1 ? S.last : S.td }, cell),
                ),
              ),
            ),
          ),
        ),
      )
    }

    // A horizontal used/budget bar. Percentage is clamped to [0,1]; the tone
    // warms as the budget fills.
    function Gauge({ percent: ratio, label, detail }) {
      const clamped = Math.max(0, Math.min(1, Number(ratio) || 0))
      const color = clamped >= 0.9 ? COLOR.bad : clamped >= 0.7 ? COLOR.warn : COLOR.output
      return h(
        'div',
        { style: { marginTop: '8px' } },
        h(
          'div',
          { style: { height: '8px', borderRadius: '999px', background: 'rgba(128,128,128,.22)', overflow: 'hidden' } },
          h('div', { style: { width: `${(clamped * 100).toFixed(1)}%`, height: '100%', background: color } }),
        ),
        h('div', { style: { ...S.k, marginTop: '4px' } }, label, detail ? ` \u00b7 ${detail}` : ''),
      )
    }

    // Vertical columns; either grouped single-series or stacked multi-series.
    function ColumnChart({ data, series, height = 170, format = counts }) {
      const width = 720
      const padTop = 12
      const padBottom = 20
      const padX = 4
      const totals = data.map((point) =>
        series.reduce((sum, item) => sum + (Number(point.values?.[item.key]) || 0), 0),
      )
      const max = Math.max(1, ...totals)
      const gap = 3
      const barWidth = Math.max(2, (width - padX * 2 - gap * (data.length - 1)) / Math.max(1, data.length))
      const plotHeight = height - padTop - padBottom
      const nodes = []
      data.forEach((point, index) => {
        const x = padX + index * (barWidth + gap)
        let cursor = padTop + plotHeight
        series.forEach((item) => {
          const value = Number(point.values?.[item.key]) || 0
          if (value <= 0) return
          const segHeight = (plotHeight * value) / max
          cursor -= segHeight
          nodes.push(
            h(
              'rect',
              { key: `${index}-${item.key}`, x, y: cursor, width: barWidth, height: segHeight, fill: item.color },
              h('title', null, `${point.label} \u00b7 ${item.label}: ${format(value)}`),
            ),
          )
        })
        // An invisible full-height hit area makes the whole column hoverable.
        nodes.push(
          h(
            'rect',
            { key: `hit-${index}`, x, y: padTop, width: barWidth, height: plotHeight, fill: 'transparent' },
            h('title', null, `${point.label}: ${format(totals[index])}`),
          ),
        )
      })
      const every = Math.max(1, Math.ceil(data.length / 16))
      const labels = data
        .map((point, index) =>
          index % every === 0
            ? h(
                'text',
                { key: `l-${index}`, x: padX + index * (barWidth + gap) + barWidth / 2, y: height - 6, textAnchor: 'middle', fontSize: 9, fill: 'currentColor', opacity: 0.55 },
                point.short ?? shortDay(point.label),
              )
            : null,
        )
      return h(
        'div',
        null,
        h(Legend, { series }),
        h(
          'svg',
          { viewBox: `0 0 ${width} ${height}`, width: '100%', height, preserveAspectRatio: 'none', role: 'img' },
          nodes,
          labels,
        ),
      )
    }

    // Horizontal bars, best for per-model cost/token breakdowns.
    function BarList({ rows, format = counts, color = COLOR.cost }) {
      const max = Math.max(1, ...rows.map((row) => Number(row.value) || 0))
      return h(
        'div',
        { style: { display: 'grid', gap: '6px', marginTop: '4px' } },
        rows.map((row) =>
          h(
            'div',
            { key: row.label, style: { display: 'grid', gridTemplateColumns: 'minmax(120px, 34%) 1fr auto', gap: '8px', alignItems: 'center', fontSize: '12px' } },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }, title: row.label }, row.label),
            h(
              'span',
              { style: { background: 'rgba(128,128,128,.18)', borderRadius: '999px', height: '9px', overflow: 'hidden' } },
              h('span', { style: { display: 'block', width: `${((Number(row.value) || 0) / max) * 100}%`, height: '100%', background: row.color ?? color, borderRadius: '999px' } }),
            ),
            h('span', { style: { ...S.muted, whiteSpace: 'nowrap' } }, format(row.value)),
          ),
        ),
      )
    }

    // A donut for a share breakdown (token mix).
    function Donut({ segments, size = 132, thickness = 18, format = counts }) {
      const total = segments.reduce((sum, item) => sum + (Number(item.value) || 0), 0)
      const radius = (size - thickness) / 2
      const circumference = 2 * Math.PI * radius
      let offset = 0
      const arcs = segments
        .filter((item) => (Number(item.value) || 0) > 0)
        .map((item) => {
          const share = (Number(item.value) || 0) / (total || 1)
          const dash = share * circumference
          const arc = h('circle', {
            key: item.label,
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            stroke: item.color,
            strokeWidth: thickness,
            strokeDasharray: `${dash} ${circumference - dash}`,
            strokeDashoffset: -offset,
            transform: `rotate(-90 ${size / 2} ${size / 2})`,
          }, h('title', null, `${item.label}: ${format(item.value)} (${percent(share)})`))
          offset += dash
          return arc
        })
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' } },
        h(
          'svg',
          { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img' },
          h('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: 'rgba(128,128,128,.18)', strokeWidth: thickness }),
          arcs,
          total === 0
            ? h('text', { x: size / 2, y: size / 2, textAnchor: 'middle', dominantBaseline: 'middle', fontSize: 11, fill: 'currentColor', opacity: 0.5 }, 'no data')
            : null,
        ),
        h(
          'div',
          { style: { display: 'grid', gap: '4px', fontSize: '12px' } },
          segments
            .filter((item) => (Number(item.value) || 0) > 0)
            .map((item) =>
              h(
                'span',
                { key: item.label, style: S.legendItem },
                h('span', { style: { ...S.swatch, background: item.color } }),
                h('span', null, `${item.label} \u00b7 ${format(item.value)}`),
              ),
            ),
        ),
      )
    }

    // A GitHub-style activity grid: columns are weeks, rows are weekdays.
    function Heatmap({ days, weeks = 20, format = counts }) {
      if (!Array.isArray(days) || days.length === 0) return h('p', { style: S.note }, 'No activity recorded.')
      const slice = days.slice(-(weeks * 7))
      const first = new Date(`${slice[0].date}T00:00:00`)
      const offset = Number.isNaN(first.getTime()) ? 0 : (first.getDay() + 6) % 7
      const cell = 14
      const gap = 3
      const max = Math.max(1, ...slice.map((day) => Number(day.value) || 0))
      const columns = Math.ceil((offset + slice.length) / 7)
      const cells = slice.map((day, index) => {
        const slot = offset + index
        const weekend = slot % 7 >= 5
        const intensity = (Number(day.value) || 0) / max
        const color = intensity === 0 ? 'rgba(128,128,128,.16)' : `rgba(70,201,139,${(0.25 + intensity * 0.75).toFixed(2)})`
        return h('rect', {
          key: day.date,
          x: Math.floor(slot / 7) * (cell + gap),
          y: (slot % 7) * (cell + gap),
          width: cell,
          height: cell,
          rx: 3,
          fill: color,
          opacity: weekend ? 0.75 : 1,
        }, h('title', null, `${day.date}: ${format(day.value)}`))
      })
      const width = columns * (cell + gap)
      const height = 7 * (cell + gap)
      return h(
        'div',
        { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
        h('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' }, cells),
        h('span', { style: { ...S.k, display: 'grid', gap: '2px' } }, h('span', null, `${slice.length} active/tracked days`), h('span', null, `peak ${format(max)}`)),
      )
    }

    // ------------------------------------------------------------------ views
    function TokenMix({ usage, label }) {
      if (!usage) return null
      // The host sends slices that already add up to the view's total, because
      // the CLIs disagree about whether cache reads sit inside input. Reasoning
      // is never a slice, so it is named under the chart instead.
      const byKey = { input: COLOR.input, output: COLOR.output, cache: COLOR.cache }
      const slices = Array.isArray(usage.mix?.slices)
        ? usage.mix.slices
        : [
            { key: 'input', label: 'Input', value: usage.inputTokens },
            { key: 'output', label: 'Output', value: usage.outputTokens },
            { key: 'cache', label: 'Cache read', value: usage.cacheReadTokens },
          ]
      const segments = slices.map((slice) => ({
        label: slice.label,
        value: slice.value,
        color: byKey[slice.key] ?? COLOR.cache,
      }))
      return h(
        Panel,
        { title: `${label} token mix` },
        h(Donut, { segments }),
        usage.reasoningTokens > 0
          ? h('p', { style: S.note }, `${counts(usage.reasoningTokens)} reasoning tokens are reported separately and are not part of the total above.`)
          : null,
      )
    }

    function CliModelsTable({ grok, opencode, codex }) {
      const rows = []
      for (const model of grok?.models ?? []) {
        rows.push(['Grok', model.id, model.turns || model.modelCalls || 0, counts(model.inputTokens), counts(model.outputTokens), counts(model.cacheReadTokens), counts(model.totalTokens), usd4(model.costUsd)])
      }
      for (const model of opencode?.models ?? []) {
        rows.push(['OpenCode', model.id, model.steps || 0, counts(model.inputTokens), counts(model.outputTokens), counts(model.cacheReadTokens), counts(model.totalTokens), usd4(model.costUsd)])
      }
      for (const model of codex?.models ?? []) {
        // The Codex CLI reports no cost, so a dash is the honest cell here.
        rows.push(['Codex', model.id, model.turns || 0, counts(model.inputTokens), counts(model.outputTokens), counts(model.cacheReadTokens), counts(model.totalTokens), codex?.capabilities?.cost === false ? '\u2014' : usd4(model.costUsd)])
      }
      return h(Table, {
        head: ['Route', 'Model', 'Turns / steps', 'In', 'Out', 'Cache read', 'Total', 'Cost'],
        rows,
        empty: 'No CLI-recorded model usage yet.',
      })
    }

    /** The plugin's page in the Plugins panel and in Settings. */
    function LlmCliPage(props) {
      const [state, setState] = React.useState({ status: 'loading' })
      const [tick, setTick] = React.useState(0)
      const [auto, setAuto] = React.useState(true)
      const [days, setDays] = React.useState(7)
      // Updates are checked when asked, not on every page open, so opening the
      // dashboard does not make a network call on someone else's behalf.
      const [update, setUpdate] = React.useState({ status: 'idle' })
      const forceNext = React.useRef(false)
      const [setup, setSetup] = React.useState(null)
      const [auth, setAuth] = React.useState({})
      React.useEffect(() => {
        if (props?.view === 'summary') return
        let live = true
        fetch('/llm-cli/setup.json', { headers: { accept: 'application/json' } })
          .then(response => response.ok ? response.json() : null)
          .then(value => { if (live) setSetup(value) })
          .catch(() => { if (live) setSetup(null) })
        return () => { live = false }
      }, [props?.view])
      const providerAction = (provider, action) => {
        if (!setup?.actionToken) return
        setAuth(current => ({ ...current, [provider]: { ...current[provider], busy: true, error: '' } }))
        fetch('/llm-cli/setup', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-llm-cli-setup': setup.actionToken },
          body: JSON.stringify({ provider, action }),
        }).then(async response => {
          const value = await response.json()
          if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
          return value
        }).then(value => {
          setAuth(current => ({ ...current, [provider]: { ...value, busy: false } }))
          setSetup(current => current ? { ...current, providers: current.providers?.map(row => row.id === provider ? { ...row, ...value } : row) } : current)
          forceNext.current = true
          setTick(value => value + 1)
        }).catch(error => setAuth(current => ({ ...current, [provider]: { ...current[provider], busy: false, error: error.message } })))
      }
      React.useEffect(() => {
        if (!setup?.actionToken || !Object.values(auth).some(value => value.pending)) return
        const timer = setInterval(() => {
          for (const [provider, value] of Object.entries(auth)) if (value.pending && !value.busy) providerAction(provider, 'status')
        }, 5000)
        return () => clearInterval(timer)
      }, [auth, setup?.actionToken])

      const checkForUpdates = () => {
        setUpdate({ status: 'checking' })
        fetch('/llm-cli/update.json?force=1', { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((result) => setUpdate({ status: 'ready', data: result }))
          .catch((error) => setUpdate({ status: 'error', error: String((error && error.message) || error) }))
      }

      const applyUpdate = () => {
        const token = update.data?.actionToken
        if (!token) return
        setUpdate({ status: 'applying', data: update.data })
        fetch('/llm-cli/update', {
          method: 'POST',
          headers: { accept: 'application/json', 'x-llm-cli-update': token },
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((result) =>
            setUpdate({
              status: 'ready',
              data: {
                ...(update.data ?? {}),
                ...(result.status ?? {}),
                restartRequired: result.restartRequired,
                lastResult: { at: Date.now(), ok: result.ok, command: result.command, output: result.output },
              },
            }),
          )
          .catch((error) => setUpdate({ status: 'error', error: String((error && error.message) || error) }))
      }

      React.useEffect(() => {
        let live = true
        setState((current) => (current.status === 'ready' ? { ...current, refreshing: true } : { status: 'loading' }))
        const query = days > 0 ? `?days=${days}` : '?days=all'
        const force = forceNext.current
        forceNext.current = false
        fetch(`/llm-cli/usage.json${query}${force ? '&force=1' : ''}`, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((data) => {
            if (live) setState({ status: 'ready', data })
          })
          .catch((error) => {
            if (live) setState({ status: 'error', error: String((error && error.message) || error) })
          })
        return () => {
          live = false
        }
      }, [tick, days])

      // Auto-refresh keeps the charts live while the panel is open.
      React.useEffect(() => {
        if (!auto || props?.view === 'summary') return undefined
        const id = setInterval(() => setTick((value) => value + 1), 30000)
        return () => clearInterval(id)
      }, [auto, props?.view])

      // The card in the list shows one line; the page shows everything.
      if (props && props.view === 'summary') {
        return h(
          'span',
          null,
          'Model routes served by the OpenCode, Grok and Codex CLIs installed on this host, with published model limits, recorded Codex quota snapshots, usage charts, and optional usage-plan budgets.',
        )
      }

      if (state.status === 'loading') return h('p', { style: S.lead }, 'Reading /llm-cli/usage.json\u2026')

      if (state.status === 'error') {
        return h(
          'div',
          null,
          h('p', { style: S.lead }, `The usage endpoint did not answer (${state.error}).`),
          h(
            'p',
            { style: S.note },
            h('button', { type: 'button', style: S.button, onClick: () => setTick((value) => value + 1) }, 'Retry'),
            ' The routes still work; only this view is missing. The same page is served at ',
            h('a', { style: S.link, href: '/llm-cli/usage', target: '_blank', rel: 'noreferrer' }, '/llm-cli/usage'),
            '.',
          ),
        )
      }

      const data = state.data
      const routes = Array.isArray(data.routes) ? data.routes : []
      const cli = data.cliUsage ?? {}
      const grok = cli.grok
      const opencode = cli.opencode
      const plans = data.plans ?? {}
      const codex = cli.codex
      const windowDays = data.windowDays ?? 0
      const windowLabel =
        data.windowLabel ||
        (windowDays >= 1
          ? `last ${windowDays} days`
          : windowDays > 0
            ? `last ${Math.round(windowDays * 24)}h`
            : 'lifetime')

      const grokDaily = fillWindow(grok?.daily ?? [], windowDays, (date, day) => ({
        label: date,
        short: shortDay(date),
        values: {
          inputTokens: day?.inputTokens,
          outputTokens: day?.outputTokens,
          cacheReadTokens: day?.cacheReadTokens,
          reasoningTokens: day?.reasoningTokens,
        },
      }))
      const tokenSeries = [
        { key: 'inputTokens', label: 'Input', color: COLOR.input },
        { key: 'outputTokens', label: 'Output', color: COLOR.output },
        { key: 'cacheReadTokens', label: 'Cache read', color: COLOR.cache },
        { key: 'reasoningTokens', label: 'Reasoning', color: COLOR.reasoning },
      ]
      const costRows = (grok?.models ?? [])
        .filter((model) => (Number(model.costUsd) || 0) > 0)
        .sort((left, right) => (right.costUsd || 0) - (left.costUsd || 0))
        .map((model) => ({ label: model.id, value: model.costUsd, color: COLOR.cost }))
      const opencodeActivity = fillWindow(opencode?.daily ?? [], windowDays, (date, day) => ({
        date,
        value: day?.steps ?? 0,
      }))
      const codexDaily = fillWindow(codex?.daily ?? [], windowDays, (date, day) => ({
        label: date,
        short: shortDay(date),
        values: {
          inputTokens: day?.inputTokens,
          outputTokens: day?.outputTokens,
          cacheReadTokens: day?.cacheReadTokens,
          reasoningTokens: day?.reasoningTokens,
        },
      }))
      // A CLI that counts whole days serves a sub-day window at its smallest
      // scope, so say so instead of letting the label overstate the precision.
      const coarseScopes = [['opencode', opencode]].filter(
        ([, view]) => view?.available && view.scopeDays > 0 && view.scopeDays > windowDays,
      )
      const codexLimits = codex?.limits ?? {}
      const codexLimitCards = [
        codexLimits.primary ? { title: 'Codex 5-hour limit', minutes: codexLimits.primary.windowMinutes ?? 300, limit: codexLimits.primary, key: 'primary' } : null,
        codexLimits.secondary ? { title: 'Codex weekly limit', minutes: codexLimits.secondary.windowMinutes ?? 10080, limit: codexLimits.secondary, key: 'secondary' } : null,
      ].filter(Boolean)
      const toolbar = h(
        'span',
        { style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } },
        h(
          'span',
          { style: { display: 'inline-flex', border: HAIR, borderRadius: '7px', overflow: 'hidden' } },
          WINDOWS.map((window) =>
            h(
              'button',
              {
                key: window.label,
                type: 'button',
                onClick: () => setDays(window.value),
                style: {
                  ...S.button,
                  border: 'none',
                  borderRadius: 0,
                  padding: '3px 9px',
                  background: days === window.value ? 'rgba(128,128,128,.3)' : 'transparent',
                  fontWeight: days === window.value ? 600 : 400,
                },
              },
              window.label,
            ),
          ),
        ),
        h('label', { style: { ...S.k, display: 'inline-flex', gap: '5px', alignItems: 'center', cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: auto, onChange: (event) => setAuto(event.target.checked) }),
          'auto 30s'),
        h('button', { type: 'button', style: S.button, onClick: () => { forceNext.current = true; setTick((value) => value + 1) } }, state.refreshing ? 'Refreshing\u2026' : 'Refresh'),
        h('span', { style: S.k }, `updated ${when(data.generatedAt)}`),
      )

      return h(
        'div',
        null,
        h(
          'p',
          { style: S.lead },
          'Three model routes served by installed CLIs using their own authentication. Turns use the session workspace, forward harness instructions, and can request harness tools. Image support depends on the selected CLI and model.',
        ),
        h('div', { style: S.toolbarRow }, h('div', { style: S.heading }, `CLI-recorded usage \u00b7 ${windowLabel} (the CLIs\u2019 own accounting)`), toolbar),
        coarseScopes.length > 0
          ? h(
              'p',
              { style: S.note },
              `${coarseScopes.map(([id, view]) => `${id} covers ${view.scopeDays}d`).join(', ')} because that CLI counts whole days, so this window is shown at its smallest scope.`,
            )
          : null,

        // CLI-recorded totals
        h(
          'div',
          { style: S.cards },
          grok
            ? h(StatCard, { label: 'Grok CLI tokens', value: grok.available ? counts(grok.totalTokens) : '\u2014', sub: grok.available ? `${grok.sessionCount} sessions \u00b7 ${counts(grok.inputTokens)} in / ${counts(grok.outputTokens)} out` : grok.note })
            : null,
          grok
            ? h(StatCard, { label: 'Grok CLI cost', value: grok.available ? usd2(grok.costUsd) : '\u2014', sub: grok.available ? `${grok.turns} turns \u00b7 ${counts(grok.cacheReadTokens)} cache read` : 'unavailable', tone: COLOR.cost })
            : null,
          opencode
            ? h(StatCard, { label: 'OpenCode CLI tokens', value: opencode.available ? counts(opencode.totalTokens) : '\u2014', sub: opencode.available ? `${opencode.sessions ?? 0} sessions \u00b7 ${opencode.prompts ?? 0} prompts` : opencode.note })
            : null,
          opencode
            ? h(StatCard, { label: 'OpenCode CLI cost', value: opencode.available ? usd2(opencode.costUsd) : '\u2014', sub: opencode.available ? `${opencode.steps ?? 0} steps \u00b7 ${opencode.activeDays ?? 0} active days` : 'unavailable', tone: COLOR.cost })
            : null,
          codex
            ? h(StatCard, { label: 'Codex CLI tokens', value: codex.available ? counts(codex.totalTokens) : '\u2014', sub: codex.available ? `${codex.sessionCount} sessions \u00b7 ${counts(codex.inputTokens)} in / ${counts(codex.outputTokens)} out` : codex.note })
            : null,
          codex
            ? h(StatCard, { label: 'Codex cached input', value: codex.available ? counts(codex.cacheReadTokens) : '\u2014', sub: codex.available ? `${codex.turns} turns \u00b7 ${counts(codex.reasoningTokens)} reasoning` : 'unavailable', tone: COLOR.cache })
            : null,
        ),

        // Codex rate limits (real 5-hour and weekly windows from the CLI)
        codexLimitCards.length > 0 ? h('div', { style: S.heading }, 'Codex subscription limits (reported by the CLI)') : null,
        codexLimitCards.length > 0
          ? h(
              'div',
              { style: S.cards },
              codexLimitCards.map(({ title, minutes, limit, key }) =>
                h(
                  'div',
                  { key: title, style: S.card },
                  h('div', { style: S.k }, title),
                  h('div', { style: S.v }, `${(limit.usedPercent ?? 0).toFixed(0)}% ${codex?.limitsSource === 'live' ? 'used' : 'recorded'}`),
                  h(Gauge, {
                    percent: (limit.usedPercent ?? 0) / 100,
                    label: `${(limit.usedPercent ?? 0).toFixed(0)}% used`,
                    detail: `${minutes >= 1440 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 60)}h`} window \u00b7 resets ${when(limit.resetsAt)}`,
                  }),
                  h('div', { style: S.note }, `${codex?.limitsSource === 'live' ? 'Live quota checked:' : 'Recorded snapshot:'} ${when(codex?.limitsObservedAt?.[key])}${codex?.limitsStale?.[key] ? ' (stale)' : ''}. ${codex?.limitsSource === 'live' ? 'Refresh queries Codex account quota.' : 'Live quota unavailable; showing the recorded CLI snapshot.'}`),
                ),
              ),
            )
          : null,

        // Usage plans
        plans.grok || plans.opencode
          ? h('div', { style: S.heading }, 'Usage plans')
          : null,
        plans.grok || plans.opencode
          ? h(
              'div',
              { style: S.cards },
              plans.grok
                ? h(
                    'div',
                    { style: S.card },
                    h('div', { style: S.k }, 'Grok monthly budget (cost)'),
                    h('div', { style: S.v }, `${usd2(plans.grok.usedUsd)} / ${usd2(plans.grok.budgetUsd)}`),
                    h(Gauge, { percent: plans.grok.percent, label: `${percent(plans.grok.percent)} used`, detail: `${usd2(plans.grok.remainingUsd)} left \u00b7 resets day ${plans.grok.resetDay}` }),
                  )
                : null,
              plans.opencode
                ? h(
                    'div',
                    { style: S.card },
                    h('div', { style: S.k }, `OpenCode monthly budget (${plans.opencode.metric})`),
                    h(
                      'div',
                      { style: S.v },
                      plans.opencode.metric === 'tokens'
                        ? `${counts(plans.opencode.usedTokens)} / ${counts(plans.opencode.budgetTokens)}`
                        : `${usd2(plans.opencode.usedUsd)} / ${usd2(plans.opencode.budgetUsd)}`,
                    ),
                    h(Gauge, { percent: plans.opencode.percent, label: `${percent(plans.opencode.percent)} used`, detail: `last ${plans.opencode.periodDays}d \u00b7 resets day ${plans.opencode.resetDay}` }),
                  )
                : null,
            )
          : null,

        // Grok weekly premium limit (configured; the CLI exposes no quota)
        plans.grokWeekly ? h('div', { style: S.heading }, 'Grok subscription limit') : null,
        plans.grokWeekly
          ? h(
              'div',
              { style: S.cards },
              h(
                'div',
                { style: S.card },
                h('div', { style: S.k }, 'Grok weekly premium limit'),
                h('div', { style: S.v }, `${(plans.grokWeekly.usedPercent ?? 0).toFixed(0)}% used`),
                h(Gauge, {
                  percent: (plans.grokWeekly.usedPercent ?? 0) / 100,
                  label: `${(plans.grokWeekly.usedPercent ?? 0).toFixed(0)}% used`,
                  detail: `weekly window \u00b7 resets ${when(plans.grokWeekly.resetsAt)} \u00b7 ${plans.grokWeekly.source ?? ''}`,
                }),
              ),
            )
          : null,

        // Charts
        h('div', { style: S.heading }, 'Charts'),
        grokDaily.length > 0
          ? h(Panel, { title: 'Grok daily tokens (CLI)' }, h(ColumnChart, { data: grokDaily, series: tokenSeries }))
          : grok
            ? h(Panel, { title: 'Grok daily tokens (CLI)' }, h('p', { style: S.note }, grok.available ? 'No per-day grok turns recorded yet.' : `Grok usage unavailable: ${grok.note ?? ''}`))
            : null,
        costRows.length > 0
          ? h(Panel, { title: 'Grok cost by model (CLI)' }, h(BarList, { rows: costRows, format: usd4, color: COLOR.cost }))
          : null,
        codexDaily.length > 0
          ? h(Panel, { title: 'Codex daily tokens (CLI)' }, h(ColumnChart, { data: codexDaily, series: tokenSeries }))
          : codex
            ? h(Panel, { title: 'Codex daily tokens (CLI)' }, h('p', { style: S.note }, codex.available ? 'No per-day codex turns recorded yet.' : `Codex usage unavailable: ${codex.note ?? ''}`))
            : null,
        opencode
          ? h(Panel, { title: 'OpenCode activity (CLI, steps per day)' }, h(Heatmap, { days: opencodeActivity, format: counts }))
          : null,
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' } },
          grok && grok.available ? h(TokenMix, { usage: grok, label: 'Grok' }) : null,
          opencode && opencode.available ? h(TokenMix, { usage: opencode, label: 'OpenCode' }) : null,
          codex && codex.available ? h(TokenMix, { usage: codex, label: 'Codex' }) : null,
        ),

        // Per-model CLI usage
        h('div', { style: S.heading }, 'Every model, by usage (CLI-recorded)'),
        h(CliModelsTable, { grok, opencode, codex }),

        // This harness's own ledger
        h('div', { style: S.heading }, 'This harness (turns it recorded itself)'),
        routes.length > 0
          ? h(
              'div',
              { style: S.cards },
              routes.map((route) =>
                h(
                  'div',
                  { key: route.id, style: S.card },
                  h('div', { style: S.k }, route.displayName),
                  h('div', { style: S.v }, `${route.usage.turns} turn${route.usage.turns === 1 ? '' : 's'}`),
                  h('div', { style: S.k }, `${route.usage.costTurns === 0 ? '\u2014' : usd4(route.usage.costUsd)} \u00b7 ${counts(route.usage.inputTokens)} in / ${counts(route.usage.outputTokens)} out`),
                  h('div', { style: S.k }, `${route.signedIn === null ? 'sign-in unknown' : route.signedIn ? 'signed in' : route.signInOptional ? 'no sign-in needed' : 'not signed in'} \u00b7 ${route.models.length} models`),
                ),
              ),
            )
          : h('p', { style: S.note }, 'No routes are enabled.'),

        h('div', { style: S.heading }, 'CLI setup and sign-in'),
        h('p', { style: S.note }, 'Installation and sign-in run on this DSH host. Approve the account in your browser; credentials stay with the CLI.'),
        !setup?.actionToken
          ? h('p', { style: S.note }, 'Open this page on the CLI host to manage setup, or use provider_signin in chat.')
          : h('div', { style: S.cards }, routes.map(route => {
              const installed = setup.providers?.find(row => row.id === route.id)
              const current = auth[route.id] ?? {}
              const signedIn = typeof current.signedIn === 'boolean' ? current.signedIn : route.signedIn
              return h('div', { key: route.id, style: S.card },
                h('div', { style: S.k }, route.displayName),
                h('p', null, installed?.installed ? (signedIn ? 'Signed in' : 'Not signed in') : 'CLI not installed'),
                !installed?.installed ? h('button', { type: 'button', style: S.button, disabled: current.busy, onClick: () => providerAction(route.id, 'install') }, 'Install CLI') : null,
                !signedIn && !current.pending ? h('button', { type: 'button', style: S.button, disabled: current.busy, onClick: () => providerAction(route.id, 'signin') }, installed?.installed ? 'Sign in' : 'Install and sign in') : null,
                h('button', { type: 'button', style: S.button, disabled: current.busy, onClick: () => providerAction(route.id, 'status') }, 'Check sign-in'),
                current.pending ? h('button', { type: 'button', style: S.button, disabled: current.busy, onClick: () => providerAction(route.id, 'cancel') }, 'Cancel sign-in') : null,
                current.url ? h('p', null, h('a', { href: current.url, target: '_blank', rel: 'noreferrer', style: S.link }, 'Open sign-in page')) : null,
                current.code ? h('p', null, 'Device code: ', h('strong', null, current.code)) : null,
                current.pending ? h('p', { style: S.note }, 'Waiting for browser approval. Status checks run every 5 seconds.') : null,
                current.busy ? h('p', { style: S.note }, 'Working on the host…') : null,
                current.error || installed?.error ? h('p', { style: S.note }, current.error || installed.error) : null,
              )
            })),

        h('div', { style: S.heading }, 'Model limits'),
        routes.length > 0
          ? routes.map((route) =>
              h(
                'div',
                { key: route.id, style: { marginBottom: '10px' } },
                h('div', { style: S.subheading }, route.displayName, h('span', { style: S.pill }, route.id)),
                h(Table, {
                  head: ['Model', 'Context window', 'Max output', 'Source'],
                  rows: route.models.map((model) => [
                    model.id,
                    model.contextWindow ? counts(model.contextWindow) : '\u2014',
                    model.maxOutputTokens ? counts(model.maxOutputTokens) : '\u2014',
                    model.source ?? '',
                  ]),
                  empty: 'No models are configured for this route.',
                }),
              ),
            )
          : null,

        h('div', { style: S.heading }, 'Recent harness turns'),
        h(Table, {
          head: ['When', 'Route', 'Model', 'In', 'Out', 'Cost', 'Time', 'Result'],
          rows: (data.recent ?? []).slice(0, 12).map((entry) => [
            when(entry.at),
            entry.provider,
            entry.model,
            counts(entry.inputTokens ?? 0),
            counts(entry.outputTokens ?? 0),
            entry.costUsd === undefined ? '\u2014' : usd4(entry.costUsd),
            `${((entry.ms ?? 0) / 1000).toFixed(1)}s`,
            entry.ok ? 'ok' : String(entry.error ?? 'failed'),
          ]),
          empty: 'No turns recorded yet.',
        }),

        h('p', { style: S.note }, data.limitsNotice),
        h('div', { style: S.heading }, 'Plugin version'),
        h(
          'div',
          null,
          h(
            'div',
            { style: S.cards },
            h(StatCard, {
              label: 'Installed',
              value: update.data?.current ?? '\u2014',
              sub: update.data?.install?.detail ?? 'press check for updates',
            }),
            update.data?.latest
              ? h(StatCard, {
                  label: 'Newest published',
                  value: update.data.latest,
                  sub: update.data.updateAvailable ? 'an update is available' : 'this copy is current',
                  tone: update.data.updateAvailable ? COLOR.warn : COLOR.output,
                })
              : null,
          ),
          h(
            'p',
            { style: S.note },
            h(
              'button',
              { type: 'button', style: S.button, onClick: checkForUpdates },
              update.status === 'checking' ? 'Checking\u2026' : 'Check for updates',
            ),
            update.data?.canApply && update.data?.updateAvailable && update.data?.actionToken
              ? h(
                  'button',
                  { type: 'button', style: { ...S.button, marginLeft: '8px' }, onClick: applyUpdate },
                  update.status === 'applying' ? 'Updating\u2026' : 'Update now',
                )
              : null,
            update.status === 'error' ? ` ${update.error}` : '',
            update.data?.restartRequired ? ' Restart the profile to load the new version.' : '',
            update.data?.lastResult
              ? ` Last run ${update.data.lastResult.ok ? 'succeeded' : 'failed'}: ${String(update.data.lastResult.output ?? '').slice(0, 300)}`
              : '',
            update.data
              ? update.data.autoUpdate
                ? ` Auto-update is on (${update.data.autoUpdate}).`
                : ' Auto-update is off.'
              : '',
          ),
        ),
        h(
          'p',
          { style: S.note },
          'Ledger: ',
          h('code', null, data.ledgerFile ?? 'in memory only'),
          ' \u00b7 full dashboard: ',
          h('a', { style: S.link, href: '/llm-cli/usage', target: '_blank', rel: 'noreferrer' }, '/llm-cli/usage'),
          ' \u00b7 JSON: ',
          h('a', { style: S.link, href: '/llm-cli/usage.json', target: '_blank', rel: 'noreferrer' }, '/llm-cli/usage.json'),
        ),
      )
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots']

    /**
     * Register this plugin's UI twice: a card in the Plugins panel and a page
     * in Settings. Both render the same component.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.item', () =>
            ctx.slots.register(
              { name: 'plugins.item', id: 'dsh-llm-cli', order: 45, label: 'Grok + Codex + OpenCode (CLI)' },
              LlmCliPage,
            ),
          ),
        'llm-cli: plugins-panel page',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'dsh-llm-cli-usage', order: 60, label: 'LLM usage' },
              LlmCliPage,
            ),
          ),
        'llm-cli: settings page',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.LlmCliPage = LlmCliPage
    return module.exports
  },
})
