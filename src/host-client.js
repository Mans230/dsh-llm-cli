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
// in Settings. The shared coss ui/Recharts dashboard is bundled at build time.
//
// Loaded by the web client's module loader through this package's
// `dsh.client` manifest and `./client` export.
window.__ModuleLoader__.load({
  id: 'dsh-llm-cli',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    /* DASHBOARD_BUNDLE */
    /* DASHBOARD_STYLES */
    const h = (...args) => React.createElement(...args)

    // Accent palette. These read on both light and dark themes, and the rest of
    // the page leans on currentColor so it follows the app theme.
    const COLOR = {
      input: '#5b9dff',
      output: '#46c98b',
      cache: '#a97bff',
      cost: '#e46c8f',
      warn: '#e9b34a',
      bad: '#e46c6c',
    }
    const HAIR = '1px solid rgba(128,128,128,.32)'
    const S = {
      lead: { fontSize: '13px', lineHeight: 1.55, opacity: 0.78, margin: '0 0 4px', maxWidth: '80ch' },
      note: { fontSize: '12px', lineHeight: 1.55, opacity: 0.65, margin: '10px 0 0', maxWidth: '80ch' },
      heading: { fontSize: '12px', fontWeight: 650, margin: '22px 0 8px', opacity: 0.8 },
      subheading: { fontSize: '12px', fontWeight: 600, opacity: 0.7, margin: '2px 0 6px' },
      cards: { display: 'flex', flexWrap: 'wrap', gap: '10px' },
      card: { border: HAIR, borderRadius: '10px', padding: '10px 14px', minWidth: '168px', flex: '0 1 220px' },
      k: { fontSize: '11px', opacity: 0.6 },
      v: { fontSize: '20px', fontWeight: 650, marginTop: '2px' },
      wrap: { overflowX: 'auto', border: HAIR, borderRadius: '10px' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
      th: { textAlign: 'left', padding: '7px 10px', borderBottom: HAIR, fontSize: '11px', opacity: 0.6, fontWeight: 600, whiteSpace: 'nowrap' },
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
    function when(at) {
      return at ? new Date(at).toLocaleString('en-GB', { hour12: false }) : '\u2014'
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
      const dashboardToken = React.useRef('')
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
        if (props?.view === 'summary') return
        let live = true
        setState((current) => (current.status === 'ready' ? { ...current, refreshing: true } : { status: 'loading' }))
        const query = days > 0 ? `?days=${days}` : '?days=all'
        const force = forceNext.current
        forceNext.current = false
        const headers = { accept: 'application/json' }
        if (dashboardToken.current) {
          headers['x-llm-cli-token'] = dashboardToken.current
          headers['x-llm-cli-remember'] = '1'
          dashboardToken.current = ''
        }
        fetch(`/llm-cli/usage.json${query}${force ? '&force=1' : ''}`, { headers })
          .then((response) => {
            if (!response.ok) {
              const error = new Error(`HTTP ${response.status}`)
              if (response.status === 403) error.code = response.headers.get('x-llm-cli-dashboard-error')
              throw error
            }
            return response.json()
          })
          .then((data) => {
            if (live) {
              setState({ status: 'ready', data })
              // The latest host snapshot supersedes earlier setup-action results.
              setAuth(current => {
                const next = { ...current }
                for (const route of data.routes ?? []) {
                  if (!next[route.id]) continue
                  next[route.id] = { ...next[route.id], signedIn: route.signedIn }
                  if (route.signedIn === true) next[route.id] = { ...next[route.id], pending: false, url: undefined, code: undefined, error: '' }
                }
                return next
              })
            }
          })
          .catch((error) => {
            if (live) setState({ status: 'error', code: error?.code, error: String((error && error.message) || error) })
          })
        return () => {
          live = false
        }
      }, [tick, days, props?.view])

      // Auto-refresh keeps the charts live while the panel is open.
      const needsDashboardAccess = state.code === 'dashboard-token-required' || state.code === 'dashboard-token-unconfigured'
      React.useEffect(() => {
        if (!auto || needsDashboardAccess || props?.view === 'summary') return undefined
        const id = setInterval(() => setTick((value) => value + 1), 30000)
        return () => clearInterval(id)
      }, [auto, needsDashboardAccess, props?.view])

      // The card in the list shows one line; the page shows everything.
      if (props && props.view === 'summary') {
        return h(
          'span',
          null,
          'Model routes served by the OpenCode, Grok and Codex CLIs installed on this host, with published model limits, live Codex quota with recorded fallback, usage charts, and optional usage-plan budgets.',
        )
      }

      if (state.status === 'loading') return h('p', { style: S.lead }, 'Reading /llm-cli/usage.json\u2026')

      if (state.status === 'error') {
        if (state.code === 'dashboard-token-unconfigured') {
          return h('div', null,
            h('p', { style: S.lead }, 'Remote usage access has not been set up.'),
            h('p', { style: S.note }, 'Ask the server admin to set dashboardToken in the llm-cli profile configuration and restart the Harness.'),
            h('button', { type: 'button', style: S.button, onClick: () => setTick(value => value + 1) }, 'Retry'),
          )
        }
        if (state.code === 'dashboard-token-required') {
          if (window.location?.protocol === 'http:') {
            return h('p', { style: S.lead }, 'Open the Harness over HTTPS to enter your dashboard token.')
          }
          return h('form', {
            method: 'post',
            onSubmit: (event) => {
              event.preventDefault()
              const input = event.currentTarget.elements.dashboardToken
              const token = input.value.trim()
              if (!token) return
              input.value = ''
              dashboardToken.current = token
              setTick(value => value + 1)
            },
          },
          h('p', { style: S.lead }, 'Unlock usage dashboard'),
          h('label', { style: S.note }, 'Enter a valid dashboard token ',
            h('input', { type: 'password', name: 'dashboardToken', required: true, autoComplete: 'off' }),
          ),
          ' ',
          h('button', { type: 'submit', style: S.button }, 'Open dashboard'))
        }
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
      return h(
        'div',
        { className: 'dsh-dashboard' },
        h('style', null, dashboardStyles),
        h(UsageExplorer, { data, days, onDaysChange: setDays, refreshing: !!state.refreshing,
          onRefresh: () => { forceNext.current = true; setTick(value => value + 1) },
          auto, onAutoChange: setAuto, providerStatus: setup?.providers ?? [] }),
        h('details', { className: 'du-management' },
        h('summary', null, 'Host management / setup, sign-in & updates'),
        // This harness's own ledger
        h('h2', { style: S.heading }, 'This Harness · All time'),
        h('p', { style: S.note }, 'Totals from turns recorded by this Harness, regardless of the selected date range.'),
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
                  h('div', { style: S.k }, `${route.usage.costTurns === 0 ? '\u2014' : `$${Number(route.usage.costUsd || 0).toFixed(4)}`} \u00b7 ${counts(route.usage.inputTokens)} in / ${counts(route.usage.outputTokens)} out`),
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
                h('p', null, installed?.installed ? (signedIn === null ? 'Sign-in unknown' : signedIn ? 'Signed in' : route.signInOptional ? 'Sign-in optional (free models need no sign-in)' : 'Not signed in') : 'CLI not installed'),
                !installed?.installed ? h('button', { type: 'button', style: S.button, disabled: current.busy, onClick: () => providerAction(route.id, 'install') }, 'Install CLI') : null,
                !signedIn && !current.pending ? h('button', { type: 'button', style: S.button, disabled: current.busy, onClick: () => providerAction(route.id, 'signin') }, installed?.installed ? (route.signInOptional ? 'Sign in for paid models' : 'Sign in') : 'Install and sign in') : null,
                h('button', { type: 'button', style: S.button, disabled: current.busy, onClick: () => providerAction(route.id, 'status') }, 'Check sign-in'),
                current.pending ? h('button', { type: 'button', style: S.button, disabled: current.busy, onClick: () => providerAction(route.id, 'cancel') }, 'Cancel sign-in') : null,
                current.url ? h('p', null, h('a', { href: current.url, target: '_blank', rel: 'noreferrer', style: S.link }, 'Open sign-in page')) : null,
                current.code ? h('p', null, 'Device code: ', h('strong', null, current.code)) : null,
                current.pending ? h('p', { style: S.note }, 'Waiting for browser approval. Status checks run every 5 seconds.') : null,
                current.busy ? h('p', { style: S.note }, 'Working on the host…') : null,
                current.error || installed?.error ? h('p', { style: S.note }, current.error || installed.error) : null,
              )
            })),

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
