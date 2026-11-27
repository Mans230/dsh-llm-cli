import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { UsageExplorer } from './dashboard'

function Standalone() {
  const initial = JSON.parse(document.getElementById('du-payload')!.textContent!)
  const [data, setData] = React.useState(initial)
  const [days, setDays] = React.useState(initial.windowDays ?? 7)
  const [auto, setAuto] = React.useState(new URLSearchParams(location.search).get('refresh') !== 'off')
  const [tick, setTick] = React.useState(0)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState('')
  const force = React.useRef(false)
  const first = React.useRef(true)
  React.useEffect(() => {
    if (first.current) { first.current = false; return }
    const abort = new AbortController()
    setRefreshing(true)
    fetch(`/llm-cli/usage.json?days=${days || 'all'}${force.current ? '&force=1' : ''}`, { headers: { accept: 'application/json' }, signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error(`Usage refresh failed (${response.status}). Reload the page to check access.`); return response.json() })
      .then(value => { setData(value); setError('') })
      .catch(error => { if (error.name !== 'AbortError') setError(error.message) })
      .finally(() => { if (!abort.signal.aborted) setRefreshing(false) })
    force.current = false
    return () => abort.abort()
  }, [days, tick])
  React.useEffect(() => { if (!auto) return; const timer = setInterval(() => setTick(value => value + 1), 30000); return () => clearInterval(timer) }, [auto])
  const changeDays = value => {
    setDays(value)
    const url = new URL(location.href); url.searchParams.delete('hours'); url.searchParams.set('days', String(value || 'all')); history.replaceState(null, '', url)
  }
  return <>{error && <p role="alert">{error}</p>}<UsageExplorer data={data} days={days} onDaysChange={changeDays} auto={auto} onAutoChange={setAuto} refreshing={refreshing} onRefresh={() => { force.current = true; setTick(value => value + 1) }}/></>
}
const mount = document.getElementById('du-root')
if (mount) {
  createRoot(mount).render(<Standalone/>)
  document.documentElement.classList.add('du-enhanced')
  document.querySelector('.du-static-management')?.removeAttribute('open')
  // The shared React view refreshes in place; cancel the fallback page reload.
  if (window.__duFallbackTimer) clearTimeout(window.__duFallbackTimer)
}
