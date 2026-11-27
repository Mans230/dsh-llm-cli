// Real Chromium integration checks for both plugin and standalone entry points.
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { renderUsageHtml, windowCliUsage } from '../index.js'
import { assert, assertEqual } from './_assert.mjs'

const now = Date.now()
const usage = (id, models, multiplier = 1) => {
  const timeline = Array.from({ length: 30 }, (_, index) => ({
    at: now - index * 3600000, model: models[index % models.length], inputTokens: (1000 + index * 100) * multiplier,
    outputTokens: 200 * multiplier, cacheReadTokens: 400 * multiplier, totalTokens: (1200 + index * 100) * multiplier,
    reasoningTokens: 50 * multiplier, costUsd: id === 'codex' ? 0 : 0.01 * multiplier, turns: 1,
  }))
  const sum = rows => rows.reduce((total, row) => { for (const key of ['inputTokens','outputTokens','cacheReadTokens','totalTokens','costUsd','reasoningTokens','turns']) total[key] = (total[key] || 0) + row[key]; return total }, {})
  return { available: true, ...sum(timeline), capabilities: { cost: id !== 'codex' }, timelinePrecision: 'event', timeline,
    models: models.map(id => ({ id, ...sum(timeline.filter(row => row.model === id)) })), daily: [], sessions: [{ endedAt: now }], sessionCount: 1,
    limits: id === 'codex' ? { primary: { usedPercent: 18, windowMinutes: 300, resetsAt: now + 3600000 }, secondary: { usedPercent: 4, windowMinutes: 10080, resetsAt: now + 86400000 } } : {},
    limitsSource: 'recorded', limitsObservedAt: { primary: now - 3600000, secondary: now - 3600000 }, limitsStale: { primary: true, secondary: true },
  }
}
const full = {
  codex: usage('codex', ['gpt-6.1-sol', 'gpt-5-codex'], 4),
  grok: usage('grok', ['grok-4.7', 'grok-fast'], 2),
  opencode: { available: true, scopeDays: 1, totalTokens: 24000, inputTokens: 15000, outputTokens: 5000, cacheReadTokens: 4000, steps: 15, costUsd: 0.1, capabilities: { cost: true }, models: [{ id: 'opencode/free', totalTokens: 24000, inputTokens: 15000, outputTokens: 5000, cacheReadTokens: 4000, costUsd: 0.1, steps: 15 }], daily: [{ date: new Date(now).toISOString().slice(0, 10), steps: 15 }] },
}
const payload = days => ({
  generatedAt: now, windowDays: days, turns: 2, providers: [], models: [],
  recent: [{ at: now, model: 'gpt-6.1-sol', provider: 'codex', inputTokens: 400, outputTokens: 20, firstTextMs: 120, ms: 2500, ok: true }, { at: now, model: 'opencode/free', provider: 'opencode', ms: 500, ok: false, error: 'Free usage limit reached. (HTTP 429)', retryAt: now + 3600000 }],
  cliUsage: { windowDays: days, ...Object.fromEntries(Object.entries(full).map(([id, row]) => [id, id === 'opencode' ? row : windowCliUsage(row, days > 0 ? now - days * 86400000 : 0, id, days)])) },
  routes: Object.entries(full).map(([id, row]) => ({ id, displayName: id, signedIn: id !== 'grok', usage: { turns: 0, costTurns: 0, costUsd: 0 }, models: [...row.models.map(model => ({ id: model.id, contextWindow: 128000, providerContextWindow: 256000, maxOutputTokens: 16000, source: 'CLI catalog' })), { id: 'unused-model', contextWindow: 128000 }] })),
  plans: { grokWeekly: { usedPercent: 20, resetsAt: now + 86400000 } },
})
const initial = payload(7)
const html = renderUsageHtml(initial, now, initial.routes, '', initial.cliUsage, initial.plans, { autoRefresh: false })
mkdirSync('export/redesign', { recursive: true })
writeFileSync('export/redesign/example.html', html)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors = []
const requests = []
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
page.on('pageerror', error => errors.push(error.message))
await page.route('http://dashboard.test/**', async route => {
  const url = new URL(route.request().url())
  requests.push(url.href)
  if (url.pathname.endsWith('usage.json')) {
    const days = url.searchParams.get('days') === 'all' ? 0 : Number(url.searchParams.get('days') || 7)
    await route.fulfill({ json: payload(days) })
  } else if (url.pathname.endsWith('setup.json')) await route.fulfill({ json: { providers: [] } })
  else await route.fulfill({ contentType: 'text/html', body: html })
})
try {
  await page.goto('http://dashboard.test/llm-cli/usage?refresh=off')
  await page.getByRole('heading', { name: 'Usage, in focus.' }).waitFor()
  await page.locator('.recharts-bar-rectangle').first().waitFor()
  assert((await page.getByRole('region', { name: 'Provider status' }).textContent()).includes('Signed out'), 'provider readiness survives the redesign')
  await page.getByText('Sign in on the Harness host under Host management.', { exact: true }).waitFor()
  await page.getByText(/opencode\/free hit its free usage limit/).waitFor()
  assertEqual(await page.locator('.du-panel').first().evaluate(el => getComputedStyle(el).borderRadius), '10px', 'scoped coss styles load')
  assertEqual(await page.locator('.dsh-dashboard').first().evaluate(el => getComputedStyle(el).getPropertyValue('--du-blue').trim()), '#3370e6', 'theme tokens apply to the scope root')
  await page.screenshot({ path: 'export/redesign/desktop-light.png', fullPage: true })
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  await page.getByLabel('Model filter').selectOption('codex:gpt-6.1-sol')
  assert((await page.locator('.du-stat').first().textContent()).includes('gpt-6.1-sol'), 'model drill-down changes scope')
  const longer = await page.locator('.du-stat strong').first().textContent()
  await Promise.all([page.waitForResponse(response => response.url().includes('usage.json?days=0.291666')), page.getByRole('button', { name: '7h', exact: true }).click()])
  await page.getByRole('button', { name: 'Refresh usage' }).waitFor({ state: 'visible' })
  await page.waitForFunction(previous => document.querySelector('.du-stat strong')?.textContent !== previous, longer)
  assert(requests.some(url => url.includes('days=0.291666')), '7h requests the correct fractional-day window')
  await Promise.all([page.waitForResponse(response => response.url().includes('usage.json?days=1')), page.getByRole('button', { name: '24h', exact: true }).click()])
  await Promise.all([page.waitForResponse(response => response.url().includes('force=1')), page.getByRole('button', { name: 'Refresh usage' }).click()])
  await page.getByRole('tab', { name: 'Limits & budgets' }).click()
  await page.getByText('Codex 5-hour limit', { exact: true }).waitFor()
  await page.getByRole('columnheader', { name: 'Harness context', exact: true }).waitFor()
  await page.getByRole('columnheader', { name: 'Provider context', exact: true }).waitFor()
  assert((await page.locator('.du-limit').first().textContent()).includes('(stale)'), 'recorded quota exposes staleness')
  await page.getByRole('tab', { name: /Models/ }).click()
  await page.getByLabel('Search models').fill('gpt-6.1-sol')
  await page.getByRole('button', { name: 'Inspect Codex gpt-6.1-sol' }).click()
  assertEqual(await page.getByRole('tab', { name: 'Overview', exact: true }).getAttribute('aria-selected'), 'true', 'Inspect returns to the selected model overview')
  await page.getByRole('button', { name: 'OpenCode', exact: true }).click()
  await page.getByRole('button', { name: '7h', exact: true }).click()
  await page.getByText(/OpenCode totals cover 1 full day/).waitFor()
  await page.getByLabel('Model filter').selectOption('opencode:unused-model')
  assertEqual(await page.locator('.du-stat strong').first().textContent(), '—', 'unused models do not inherit CLI totals')
  await page.getByRole('button', { name: 'All CLIs', exact: true }).click()
  await page.getByRole('button', { name: '7d', exact: true }).click()
  await page.getByRole('tab', { name: 'Harness activity' }).click()
  await page.getByText('Completed', { exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: 'export/redesign/desktop-dark.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone layout has no horizontal page overflow')
  await page.screenshot({ path: 'export/redesign/mobile-dark.png', fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: 'export/redesign/mobile-light.png', fullPage: true })
  // Also execute the real host loader with a shared React instance.
  const bootstrap = await build({ stdin: { contents: `import * as React from 'react'; import {createRoot} from 'react-dom/client'; window.__hostReact=React; window.__hostMount=createRoot; window.__ModuleLoader__={load:m=>window.__plugin=m};`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false })
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.goto('http://dashboard.test/host')
  await page.evaluate(() => { document.body.innerHTML = '<main id="host-root"></main>'; document.querySelectorAll('style').forEach(el => el.remove()) })
  await page.addScriptTag({ content: bootstrap.outputFiles[0].text })
  await page.addScriptTag({ content: readFileSync('client.js', 'utf8') })
  await page.evaluate(() => {
    const plugin = window.__plugin.factory(id => { if (id === 'react') return window.__hostReact; throw Error(id) })
    window.__hostMount(document.getElementById('host-root')).render(window.__hostReact.createElement(plugin.LlmCliPage, { view: 'full' }))
  })
  await page.getByRole('heading', { name: 'Usage, in focus.' }).waitFor()
  await page.locator('.recharts-bar-rectangle').first().waitFor()
  await page.getByRole('button', { name: '7h', exact: true }).click()
  await page.getByRole('tab', { name: 'Limits & budgets' }).click()
  await page.getByText('Grok weekly premium limit', { exact: true }).waitFor()
  await page.screenshot({ path: 'export/redesign/hosted-limits.png', fullPage: true })
  assertEqual(errors, [], 'both real browser entry points have no uncaught errors')
  console.log('ok  browser: standalone + hosted, filters, models, ranges, refresh, quotas, light/dark, desktop/phone')
} finally { await browser.close() }
