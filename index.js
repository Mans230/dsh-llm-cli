/**
 * dsh-llm-cli — DeepSeek Harness LLM provider routes backed by agent CLIs.
 *
 * Routes:
 *   opencode  -> the OpenCode CLI  (`opencode run --model <m> --format json`)
 *   grok      -> the Grok Build CLI (`grok -p <prompt> -m <m> --output-format streaming-json`)
 *   codex     -> the OpenAI Codex CLI (`codex exec --json -m <m> <prompt>`)
 *
 * The CLI owns authentication and model access; this adapter only maps the
 * harness message/stream vocabulary onto one headless CLI turn. The CLI agent
 * runs with its own tools in `cwd`, so its reply is a finished answer rather
 * than raw tool-call deltas: the adapter declares a text-only stream.
 *
 * Every route is optional; a profile patch supplies `config.providers`.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const name = 'llm-cli'
export const inject = ['llm']

const DEFAULT_CONTEXT_WINDOW = 200000
const LIST_TTL_MS = 5 * 60 * 1000
/** Windows caps a whole command line near 32 KiB; longer prompts go through a file. */
const ARG_PROMPT_LIMIT = 20000
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
/** Model-limit lookups read the CLI's own cache; a short TTL keeps them cheap. */
const LIMITS_TTL_MS = 60 * 1000
/** A sign-in probe spawns the CLI, so the dashboard reuses a recent answer. */
const ROUTE_FACTS_TTL_MS = 30 * 1000
/** Reading the CLIs' own usage (grok session files, `opencode stats`) is cached. */
const CLI_USAGE_TTL_MS = 60 * 1000
/** The Grok CLI records cost in ticks of 1e-10 USD. */
const TICKS_PER_USD = 1e10

/** Resolve a path under %APPDATA% without importing when the env var is absent. */
function appDataPath(...parts) {
  const base = process.env.APPDATA
  return base ? join(base, ...parts) : undefined
}

/** Resolve a path under the user profile without importing when it is absent. */
function profilePath(...parts) {
  const base = process.env.USERPROFILE ?? process.env.HOME
  return base ? join(base, ...parts) : undefined
}

/**
 * Candidate locations for the Codex CLI. The npm package ships a native
 * executable under a platform-specific vendor folder; the bare `codex` on PATH
 * is the `.cmd` shim, which Node cannot spawn without a shell, so the real
 * `codex.exe` is preferred and the shim is only a last resort.
 */
function codexBinCandidates() {
  return [
    appDataPath(
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    ),
    profilePath('.codex', 'bin', 'codex.exe'),
    'codex',
  ].filter(Boolean)
}

/**
 * Built-in route defaults. A profile patch may override any field; `bin` is a
 * candidate list tried in order, so a bare command name still works when the
 * CLI is on PATH.
 */
function defaultRoutes() {
  return {
    opencode: {
      displayName: 'OpenCode (CLI)',
      bin: [appDataPath('npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'), 'opencode'],
      listArgs: ['models'],
      defaultModel: 'opencode/deepseek-v4.1-flash-free',
      parseList: parseOpencodeList,
      parseLine: parseOpencodeLine,
      buildArgs: (model, prompt, promptFile) =>
        promptFile
          ? ['run', '--model', model, '--format', 'json', '--file', promptFile, 'The attached file is the full conversation transcript. Reply with your next message only, with no commentary about the file.']
          : ['run', '--model', model, '--format', 'json', prompt],
    },
    grok: {
      displayName: 'Grok (CLI)',
      bin: [profilePath('.grok', 'bin', 'grok.exe'), 'grok'],
      listArgs: ['models'],
      defaultModel: 'grok-4.7',
      parseList: parseGrokList,
      parseLine: parseGrokLine,
      buildArgs: (model, prompt, promptFile) =>
        promptFile
          ? ['--prompt-file', promptFile, '-m', model, '--output-format', 'streaming-json']
          : ['-p', prompt, '-m', model, '--output-format', 'streaming-json'],
    },
    codex: {
      displayName: 'Codex (CLI)',
      bin: codexBinCandidates(),
      // Codex has no `models` listing command; it caches the account's catalog
      // at `~/.codex/models_cache.json`, which `readModels` reads. A profile
      // patch may instead pin `providers.codex.models`.
      readModels: () => readCodexModelList(),
      defaultModel: 'gpt-6.1-sol',
      parseLine: parseCodexLine,
      buildArgs: (model, prompt, promptFile) =>
        promptFile
          ? [
              'exec',
              '--json',
              '--skip-git-repo-check',
              '--color',
              'never',
              '-s',
              'read-only',
              '-m',
              model,
              `The attached file is the full conversation transcript. Read it (${promptFile}) and reply with your next message only, with no commentary about the file.`,
            ]
          : ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-s', 'read-only', '-m', model, prompt],
    },
  }
}

/**
 * The Grok Build CLI caches the model catalog it fetched from its own proxy,
 * limits included: `context_window`, the larger `context_windows` an account
 * may unlock, and `max_completion_tokens`. Reading that cache is the only
 * source of real per-model limits a CLI-backed route has. The CLI publishes no
 * subscription quota, no remaining-request count and no reset time, so no
 * "remaining" figure exists to report.
 */
function readGrokModelLimits() {
  const file = profilePath('.grok', 'models_cache.json')
  if (!file || !existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const limits = {}
    for (const [id, entry] of Object.entries(parsed?.models ?? {})) {
      const info = entry?.info ?? {}
      const windows = Array.isArray(info.context_windows)
        ? info.context_windows.filter((value) => typeof value === 'number' && value > 0)
        : []
      const primary =
        typeof info.context_window === 'number' && info.context_window > 0
          ? info.context_window
          : windows[0]
      limits[id] = {
        contextWindow: primary,
        contextWindows: windows.length > 0 ? windows : primary ? [primary] : [],
        maxOutputTokens:
          typeof info.max_completion_tokens === 'number' && info.max_completion_tokens > 0
            ? info.max_completion_tokens
            : undefined,
        source: 'grok models cache',
      }
    }
    return limits
  } catch {
    return {}
  }
}

/** Fields a token/cost accumulator carries, in the order the UI shows them. */
const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
  'modelCalls',
  'costUsd',
  'turns',
]

function blankUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    costUsd: 0,
    turns: 0,
  }
}

/**
 * The shape every CLI usage view returns, whether or not the CLI could answer.
 * `capabilities` says what that CLI actually reports, so a consumer can show a
 * dash instead of inventing a zero. `costReason` explains a `cost: false`.
 */
function blankCliUsage(source, capabilities) {
  return {
    available: false,
    source,
    ...blankUsage(),
    sessions: [],
    sessionCount: 0,
    models: [],
    daily: [],
    recentSessions: [],
    note: '',
    capabilities: capabilities ?? { cost: false, rateLimits: false, perStep: false },
  }
}

/** Add the numeric usage fields of `source` into `target` in place. */
function addUsage(target, source) {
  for (const field of USAGE_FIELDS) {
    const value = source?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) target[field] = (target[field] ?? 0) + value
  }
  return target
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Turn a Grok `usage.json` session block into the accumulator shape. */
function grokSessionUsage(block) {
  return {
    inputTokens: toCount(block.inputTokens),
    outputTokens: toCount(block.outputTokens),
    cacheReadTokens: toCount(block.cachedReadTokens),
    cacheWriteTokens: toCount(block.cacheCreationTokens),
    reasoningTokens: toCount(block.reasoningTokens),
    totalTokens: toCount(block.totalTokens),
    modelCalls: toCount(block.modelCalls),
    costUsd: finiteOr(block.costUsdTicks, 0) / TICKS_PER_USD,
  }
}

/**
 * The Grok Build CLI persists real token and cost accounting per session at
 * `<grokHome>/sessions/<encoded-cwd>/<sessionId>/usage.json`. Reading those
 * files is the one place a Grok *usage* total exists (the CLI exports no
 * subscription quota, so there is still no "remaining" figure to show).
 * `costUsdTicks` is cost in units of 1e-10 USD.
 */
function readGrokCliUsage(dir) {
  const empty = {
    ...blankCliUsage('grok session usage.json files', {
      cost: false,
      costReason: 'the Grok CLI has not recorded a session on this host yet',
      rateLimits: false,
      perStep: false,
    }),
    dir: dir ?? '',
  }
  if (!dir || !existsSync(dir)) return { ...empty, note: 'grok sessions directory not found' }
  let workspaces = []
  try {
    workspaces = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
  } catch (error) {
    return { ...empty, note: `could not read ${dir}: ${error?.message ?? error}` }
  }
  const totals = blankUsage()
  const byModel = new Map()
  const byDay = new Map()
  const sessions = []
  let sessionCount = 0
  for (const workspace of workspaces) {
    let sessionIds = []
    try {
      sessionIds = readdirSync(workspace, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const id of sessionIds) {
      const file = join(workspace, id, 'usage.json')
      if (!existsSync(file)) continue
      let parsed
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      const block = parsed?.session
      if (!block || typeof block !== 'object') continue
      sessionCount += 1
      const usage = grokSessionUsage(block)
      addUsage(totals, usage)
      totals.turns += toCount(block.turnCount) || 1
      for (const [model, entry] of Object.entries(block.modelUsage ?? {})) {
        const row = byModel.get(model) ?? { id: model, ...blankUsage() }
        addUsage(row, grokSessionUsage(entry))
        row.turns += toCount(entry.modelCalls) || 1
        byModel.set(model, row)
      }
      for (const turn of Array.isArray(parsed.turns) ? parsed.turns : []) {
        const day = String(turn?.endedAt ?? parsed.updatedAt ?? '').slice(0, 10)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
        const row = byDay.get(day) ?? { date: day, ...blankUsage() }
        addUsage(row, grokSessionUsage(turn))
        row.turns += 1
        byDay.set(day, row)
      }
      sessions.push({
        id,
        workspace: basename(workspace),
        endedAt: Date.parse(parsed.updatedAt ?? '') || 0,
        model: typeof block.primaryModelId === 'string' ? block.primaryModelId : '',
        models: Object.entries(block.modelUsage ?? {}).map(([modelId, entry]) => ({
          id: modelId,
          ...grokSessionUsage(entry),
          turns: toCount(entry.modelCalls) || 1,
        })),
        ...usage,
        turns: toCount(block.turnCount) || 1,
      })
    }
  }
  sessions.sort((left, right) => right.endedAt - left.endedAt)
  const models = [...byModel.values()].sort((left, right) => right.totalTokens - left.totalTokens)
  const daily = [...byDay.values()].sort((left, right) => (left.date < right.date ? -1 : 1))
  const available = sessionCount > 0
  return {
    ...empty,
    available,
    ...totals,
    sessions,
    sessionCount,
    models,
    daily,
    recentSessions: sessions.slice(0, 25),
    note: available ? '' : 'no grok session usage recorded yet',
    capabilities: {
      ...empty.capabilities,
      cost: available,
      costReason: available ? undefined : 'the Grok CLI has not recorded a session on this host yet',
    },
  }
}

/**
 * Project the full Grok usage onto a trailing window (for example the last 7
 * days). The per-model totals and the recent list are recomputed over the same
 * window so they agree with the headline numbers. A non-positive window means
 * "all". The full session list is kept so plans can still measure their own
 * billing period.
 */
function windowGrokUsage(full, sinceMs, windowDays = 0) {
  return windowCliUsage(full, sinceMs, 'grok', windowDays)
}

/**
 * Project any CLI usage view onto a trailing window. The per-model totals and
 * the recent list are recomputed over the same window so they agree with the
 * headline numbers. A non-positive window means "all".
 */
function windowCliUsage(full, sinceMs, what = 'cli', windowDays = 0) {
  if (!full || !(sinceMs > 0)) return full
  const cutoffDate = new Date(sinceMs).toISOString().slice(0, 10)
  const sessions = (full.sessions ?? []).filter((session) => (session.endedAt ?? 0) >= sinceMs)
  const totals = blankUsage()
  const byModel = new Map()
  for (const session of sessions) {
    addUsage(totals, session)
    for (const model of session.models ?? []) {
      const row = byModel.get(model.id) ?? { id: model.id, ...blankUsage() }
      addUsage(row, model)
      byModel.set(model.id, row)
    }
  }
  const daily = (full.daily ?? []).filter((day) => day.date >= cutoffDate)
  const models = [...byModel.values()].sort((left, right) => right.totalTokens - left.totalTokens)
  return {
    ...full,
    available: sessions.length > 0,
    ...totals,
    sessions,
    sessionCount: sessions.length,
    totalSessions: full.sessionCount ?? 0,
    models,
    daily,
    recentSessions: sessions.slice(0, 25),
    // A CLI that could not answer at all keeps its own reason. Otherwise the
    // note names the window, and the window is the one the caller asked for, so
    // it cannot drift into a value like "7.0000183 days".
    note:
      sessions.length === 0
        ? full.available === false && full.note
          ? full.note
          : `no ${what} sessions in the ${windowLabelFor(windowDays)}`
        : '',
  }
}

/**
 * Codex caches its own model catalog at `~/.codex/models_cache.json` (the same
 * shape its TUI picker uses). Only the entries the account marks `list` are
 * offered; hidden ones (internal reviewers) are skipped.
 */
function readCodexModelList(file) {
  const path = file ?? profilePath('.codex', 'models_cache.json')
  if (!path || !existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const list = Array.isArray(parsed?.models) ? parsed.models : []
    return list
      .filter(
        (model) =>
          model &&
          typeof model.slug === 'string' &&
          model.slug.length > 0 &&
          (model.visibility === undefined || model.visibility === 'list'),
      )
      .map((model) => model.slug)
  } catch {
    return []
  }
}

/** Collect `.jsonl` files under `dir` (bounded depth) for the Codex reader. */function collectJsonlFiles(dir, depth = 6) {
  const out = []
  if (depth < 0) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectJsonlFiles(full, depth - 1))
    else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) out.push(full)
  }
  return out
}

/** Normalize one Codex rate-limit window (5-hour primary, weekly secondary). */
function normalizeCodexLimit(limit, atMs) {
  if (!limit || typeof limit !== 'object') return null
  const usedPercent = firstNumber(limit.used_percent, limit.usedPercent)
  const windowMinutes = firstNumber(limit.window_minutes, limit.windowMinutes)
  let resetsAt
  const resetsAtRaw = firstNumber(limit.resets_at, limit.resetsAt)
  if (resetsAtRaw !== undefined) resetsAt = resetsAtRaw > 1e12 ? resetsAtRaw : resetsAtRaw * 1000
  else {
    const inSeconds = firstNumber(limit.resets_in_seconds, limit.resetsInSeconds)
    if (inSeconds !== undefined) resetsAt = (atMs || Date.now()) + inSeconds * 1000
  }
  if (usedPercent === undefined && resetsAt === undefined) return null
  return {
    usedPercent: usedPercent ?? null,
    windowMinutes: windowMinutes ?? null,
    resetsAt: resetsAt ?? null,
  }
}

const ROLLOUT_CACHE_MAX = 2000
/** file path -> { key: `<mtimeMs>:<size>`, value: parsed rollout } */
const rolloutCache = new Map()

/**
 * Parsing a rollout is pure work over an immutable file, so the result is
 * cached against its size and mtime. The dashboard walks the same history on
 * every refresh, and re-parsing it made the cost of a page load grow with the
 * account's lifetime usage.
 */
function parseRollout(file) {
  let key
  try {
    const stat = statSync(file)
    key = `${stat.mtimeMs}:${stat.size}`
  } catch {
    key = null
  }
  const cached = key ? rolloutCache.get(file) : undefined
  if (cached && cached.key === key) return cached.value

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const value = { sessionId: '', model: '', endedAt: 0, sessionTotals: null, rate: null, contextWindow: undefined, days: [] }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed[0] !== '{') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    const at = Date.parse(event?.timestamp ?? '') || 0
    if (at > value.endedAt) value.endedAt = at
    const payload = event?.payload
    if (event?.type === 'session_meta') {
      if (typeof payload?.id === 'string') value.sessionId = payload.id
      if (typeof payload?.model === 'string' && payload.model) value.model = payload.model
    } else if (event?.type === 'turn_context') {
      if (typeof payload?.model === 'string' && payload.model) value.model = payload.model
    } else if (event?.type === 'event_msg' && payload?.type === 'token_count') {
      const info = payload.info
      const cumulative = info?.total_token_usage
      if (cumulative && typeof cumulative === 'object') value.sessionTotals = codexUsage(cumulative)
      const contextWindow = firstNumber(info?.model_context_window, info?.modelContextWindow)
      if (contextWindow !== undefined) value.contextWindow = contextWindow
      const perTurn = info?.last_token_usage
      if (perTurn && typeof perTurn === 'object') {
        value.days.push({ date: new Date(at || Date.now()).toISOString().slice(0, 10), usage: codexUsage(perTurn) })
      }
      if (payload.rate_limits && typeof payload.rate_limits === 'object') value.rate = payload.rate_limits
    }
  }
  if (key) {
    if (rolloutCache.size >= ROLLOUT_CACHE_MAX) rolloutCache.clear()
    rolloutCache.set(file, { key, value })
  }
  return value
}

/**
 * Read the Codex CLI's own accounting. Codex writes a rollout per session under
 * `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`; the newest
 * `token_count` event in the newest rollout carries the account rate limits
 * (a 5-hour `primary` window and a weekly `secondary` window) alongside the
 * cumulative token usage. This is the one place a real used-percentage exists.
 */
function readCodexCliUsage(dir) {
  const empty = {
    ...blankCliUsage('codex session rollouts', {
      cost: false,
      costReason: 'the Codex CLI reports tokens and rate limits, never a cost',
      rateLimits: true,
      perStep: false,
    }),
    dir: dir ?? '',
    limits: { primary: null, secondary: null },
  }
  if (!dir || !existsSync(dir)) return { ...empty, note: 'codex sessions directory not found' }
  let files = []
  try {
    files = collectJsonlFiles(dir)
  } catch (error) {
    return { ...empty, note: `could not read ${dir}: ${error?.message ?? error}` }
  }
  if (files.length === 0) return { ...empty, note: 'no codex session rollouts recorded yet' }

  const totals = blankUsage()
  const byModel = new Map()
  const byDay = new Map()
  const sessions = []
  let bestLimitsAt = 0
  let limits = { primary: null, secondary: null }
  let lastContextWindow

  for (const file of files) {
    const parsed = parseRollout(file)
    if (!parsed) continue
    // Per-day rows count even when the rollout has no cumulative usage block.
    for (const day of parsed.days) {
      const row = byDay.get(day.date) ?? { date: day.date, ...blankUsage() }
      addUsage(row, day.usage)
      row.turns += 1
      byDay.set(day.date, row)
    }
    if (parsed.contextWindow !== undefined) lastContextWindow = parsed.contextWindow
    const { sessionId, model, endedAt, sessionTotals, rate } = parsed
    if (!sessionTotals) continue
    addUsage(totals, sessionTotals)
    totals.turns += 1
    const modelId = model || 'codex'
    const modelRow = byModel.get(modelId) ?? { id: modelId, ...blankUsage() }
    addUsage(modelRow, sessionTotals)
    modelRow.turns += 1
    byModel.set(modelId, modelRow)
    sessions.push({
      id: sessionId || basename(file),
      endedAt,
      model: modelId,
      models: [{ id: modelId, ...sessionTotals, turns: 1 }],
      ...sessionTotals,
      turns: 1,
    })
    if (rate && endedAt >= bestLimitsAt) {
      const primary = normalizeCodexLimit(rate.primary, endedAt)
      const secondary = normalizeCodexLimit(rate.secondary, endedAt)
      if (primary || secondary) {
        bestLimitsAt = endedAt
        limits = { primary: primary ?? limits.primary, secondary: secondary ?? limits.secondary }
      }
    }
  }

  sessions.sort((left, right) => right.endedAt - left.endedAt)
  const models = [...byModel.values()].sort((left, right) => right.totalTokens - left.totalTokens)
  const daily = [...byDay.values()].sort((left, right) => (left.date < right.date ? -1 : 1))
  return {
    ...empty,
    available: sessions.length > 0,
    ...totals,
    sessions,
    sessionCount: sessions.length,
    models,
    daily,
    recentSessions: sessions.slice(0, 25),
    limits,
    contextWindow: lastContextWindow,
    note: sessions.length === 0 ? 'no codex turns recorded yet' : '',
    capabilities: { ...empty.capabilities, cost: false },
  }
}

/** Map `opencode stats --json` output onto the dashboard vocabulary. */
function toOpencodeCliUsage(stats, args) {
  const tokens = stats?.tokens ?? {}
  const models = (Array.isArray(stats?.models) ? stats.models : []).map((entry) => {
    const variant = entry?.model?.variant
    const id = [entry?.model?.providerID, entry?.model?.id].filter(Boolean).join('/')
    return {
      id: variant && variant !== 'default' ? `${id}@${variant}` : id,
      providerID: entry?.model?.providerID ?? '',
      variant: variant ?? 'default',
      steps: toCount(entry?.steps),
      inputTokens: toCount(entry?.tokens?.input),
      outputTokens: toCount(entry?.tokens?.output),
      cacheReadTokens: toCount(entry?.tokens?.cache?.read),
      cacheWriteTokens: toCount(entry?.tokens?.cache?.write),
      reasoningTokens: toCount(entry?.tokens?.reasoning),
      totalTokens:
        toCount(entry?.tokens?.input) +
        toCount(entry?.tokens?.output) +
        toCount(entry?.tokens?.cache?.read),
      costUsd: finiteOr(entry?.cost, 0),
      turns: toCount(entry?.steps),
    }
  })
  const tools = stats?.tools ?? null
  return {
    available: true,
    source: `opencode ${args.join(' ')}`,
    args,
    from: finiteOr(stats?.range?.from, 0),
    to: finiteOr(stats?.range?.to, 0),
    sessions: toCount(stats?.sessions),
    subagents: toCount(stats?.subagents),
    prompts: toCount(stats?.prompts),
    steps: toCount(stats?.steps),
    inputTokens: toCount(tokens.input),
    outputTokens: toCount(tokens.output),
    cacheReadTokens: toCount(tokens.cache?.read),
    cacheWriteTokens: toCount(tokens.cache?.write),
    reasoningTokens: toCount(tokens.reasoning),
    totalTokens: toCount(tokens.input) + toCount(tokens.output) + toCount(tokens.cache?.read),
    costUsd: finiteOr(stats?.cost, 0),
    activeDays: toCount(stats?.activeDays),
    streak: toCount(stats?.streak),
    models,
    daily: (Array.isArray(stats?.activity) ? stats.activity : []).map((entry) => ({
      date: String(entry?.date ?? ''),
      steps: toCount(entry?.steps),
    })),
    tools,
    note: '',
    capabilities: { cost: true, rateLimits: false, perStep: true },
  }
}

/** Run `opencode stats --json …` and parse it; throws on unusable output. */
/**
 * Re-scope an `opencode stats` argument list to a trailing window: drop any
 * existing period flag and append `--days N`. Keeps the operator's other
 * customisations (models, cost, json) intact.
 */
function statsArgsForDays(base, days) {
  const args = Array.isArray(base) ? [...base] : ['stats', '--json', '--all', '--models', '--cost']
  if (!(days > 0)) return args
  const out = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--all') continue
    if (args[index] === '--days') {
      index += 1
      continue
    }
    out.push(args[index])
  }
  out.push('--days', String(Math.max(1, Math.ceil(days))))
  return out
}

async function readOpencodeCliUsage(route, cwd, timeoutMs, argsOverride) {
  const args = argsOverride ?? route.statsArgs ?? ['stats', '--json', '--all', '--models', '--cost']
  const { code, stdout, stderr } = await runCapture(route.bin, args, { cwd, timeoutMs })
  const text = stdout.trim()
  if (text.length === 0) {
    throw new Error(`${(stderr || '').trim().slice(0, 300) || `opencode ${args.join(' ')} exited ${code}`}`)
  }
  return toOpencodeCliUsage(JSON.parse(text), args)
}

/**
 * The current billing window for a monthly plan that resets on `resetDay`.
 * A reset day past 28 is clamped so every month has one.
 */
function periodWindow(resetDay, now) {
  const date = new Date(now)
  const day = Math.min(Math.max(1, Math.trunc(resetDay) || 1), 28)
  let start = new Date(date.getFullYear(), date.getMonth(), day).getTime()
  if (start > now) start = new Date(date.getFullYear(), date.getMonth() - 1, day).getTime()
  return { start, end: now }
}

/**
 * Best-effort read of a Grok subscription snapshot. The CLI fetches the weekly
 * premium limit over a private auth RPC and normally does not persist it, but a
 * snapshot file is honoured if one is ever present. Configuration
 * (`plan.grok.weeklyPremium`) takes precedence over this.
 */
function readGrokWeeklySnapshot() {
  const file = profilePath('.grok', 'subscription.json')
  if (!file || !existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const weekly = parsed?.weekly ?? parsed?.weeklyPremium ?? parsed
    const usedPercent = firstNumber(weekly?.usedPercent, weekly?.used_percent, weekly?.percent)
    const resetsAt = firstNumber(weekly?.resetsAt, weekly?.resets_at, weekly?.resetAt)
    const windowMinutes = firstNumber(weekly?.windowMinutes, weekly?.window_minutes)
    if (usedPercent === undefined && resetsAt === undefined) return null
    return {
      usedPercent,
      resetsAt: resetsAt !== undefined && resetsAt < 1e12 ? resetsAt * 1000 : resetsAt,
      windowMinutes,
      source: 'grok subscription snapshot',
    }
  } catch {
    return null
  }
}

/**
 * Roll measured CLI usage against an optional budget. The CLIs expose no real
 * quota, so a plan is whatever the operator configures; with no budget the
 * dashboard shows plain measured usage and no gauge.
 */
async function computePlans(planConfig, cliUsage, adapter, now) {
  const plan = planConfig && typeof planConfig === 'object' ? planConfig : {}
  const plans = {}

  const grok = plan.grok
  if (grok && finiteOr(grok.monthlyBudgetUsd, 0) > 0) {
    try {
      const budget = grok.monthlyBudgetUsd
      const { start } = periodWindow(grok.resetDay, now)
      const period = blankUsage()
      for (const session of cliUsage?.grok?.sessions ?? []) {
        if ((session.endedAt ?? 0) >= start) addUsage(period, session)
      }
      const used = period.costUsd
      plans.grok = {
        enabled: true,
        metric: 'cost',
        budgetUsd: budget,
        usedUsd: used,
        remainingUsd: Math.max(0, budget - used),
        percent: budget > 0 ? used / budget : 0,
        periodTokens: period.totalTokens,
        periodTurns: period.turns,
        resetDay: finiteOr(grok.resetDay, 1),
        periodStart: start,
        note: 'Your own budget for the Grok account — the CLI publishes no real quota.',
      }
    } catch {
      /* a plan is optional; never fail the dashboard for it */
    }
  }

  // The Grok weekly premium limit is published only behind the CLI's private
  // auth RPC, so it is configured here (used percent + reset time), or read
  // from a snapshot if the CLI ever writes one.
  const weekly = grok?.weeklyPremium ?? readGrokWeeklySnapshot()
  if (weekly && typeof weekly === 'object') {
    const usedPercent = finiteOr(weekly.usedPercent, -1)
    const resetsAt =
      typeof weekly.resetAt === 'string' ? Date.parse(weekly.resetAt) : finiteOr(weekly.resetsAt, 0)
    if (usedPercent >= 0 || resetsAt > 0) {
      plans.grokWeekly = {
        enabled: true,
        usedPercent: Math.max(0, Math.min(100, usedPercent < 0 ? 0 : usedPercent)),
        resetsAt: resetsAt > 0 ? resetsAt : undefined,
        windowMinutes: finiteOr(weekly.windowMinutes, 10080),
        source: weekly.source ?? 'configured — the Grok CLI exposes no quota',
      }
    }
  }

  const opencode = plan.opencode
  const tokenBudget = finiteOr(opencode?.monthlyBudgetTokens, 0)
  const costBudget = finiteOr(opencode?.monthlyBudgetUsd, 0)
  if (opencode && (tokenBudget > 0 || costBudget > 0)) {
    try {
      const { start } = periodWindow(opencode.resetDay, now)
      const days = Math.max(1, Math.floor((now - start) / 86400000) + 1)
      let usedTokens = 0
      let usedUsd = 0
      let scoped = false
      const route = adapter?.config?.providers?.opencode
      if (route) {
        try {
          const period = await readOpencodeCliUsage(route, adapter.config.cwd, 30000, [
            'stats',
            '--json',
            '--days',
            String(days),
            '--models',
            '--cost',
          ])
          usedTokens = period.totalTokens
          usedUsd = period.costUsd
          scoped = true
        } catch {
          /* fall back to the lifetime totals already fetched */
        }
      }
      if (!scoped) {
        usedTokens = cliUsage?.opencode?.totalTokens ?? 0
        usedUsd = cliUsage?.opencode?.costUsd ?? 0
      }
      const percent = tokenBudget > 0 ? usedTokens / tokenBudget : costBudget > 0 ? usedUsd / costBudget : 0
      plans.opencode = {
        enabled: true,
        metric: tokenBudget > 0 ? 'tokens' : 'cost',
        budgetTokens: tokenBudget,
        budgetUsd: costBudget,
        usedTokens,
        usedUsd,
        percent,
        resetDay: finiteOr(opencode.resetDay, 1),
        periodStart: start,
        periodDays: days,
        scopedToPeriod: scoped,
        note: 'Your own budget for the OpenCode account — free models need none.',
      }
    } catch {
      /* a plan is optional; never fail the dashboard for it */
    }
  }

  return plans
}

/** Flatten harness messages into one transcript prompt for a CLI turn. */
function buildPrompt(options, includeSystem) {
  const parts = []
  if (includeSystem && typeof options.system === 'string' && options.system.trim().length > 0) {
    parts.push(`System instructions:\n${options.system.trim()}`)
  }
  const turns = []
  for (const message of options.messages ?? []) {
    const role = message?.role ?? 'user'
    // The harness system/developer turns are tool-and-harness scaffolding for a
    // tool-calling loop this route does not expose; forwarding them to the CLI
    // agent only inflates the turn, so they are dropped by default.
    if ((role === 'system' || role === 'developer') && !includeSystem) continue
    const text = contentToText(message?.content)
    if (text.length === 0) continue
    if (role === 'system' || role === 'developer') {
      turns.push(`[${role}]\n${text}`)
      continue
    }
    turns.push(`${role}: ${text}`)
  }
  if (turns.length > 0) parts.push(`Conversation transcript:\n${turns.join('\n\n')}`)
  parts.push(
    'You are answering as the assistant inside a chat product. Continue the transcript above: reply to the last user turn directly. Do not narrate these instructions, and do not describe the transcript format.',
  )
  return parts.join('\n\n')
}

/** Project one message's content blocks to plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (block == null) continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') out.push(block.text)
        break
      case 'reasoning':
        if (typeof block.text === 'string' && block.text.length > 0) out.push(`[thinking] ${block.text}`)
        break
      case 'tool-call':
        out.push(`[tool call ${block.name ?? ''}(${block.arguments ?? ''})]`)
        break
      case 'image':
        out.push('[image attachment]')
        break
      case 'file':
        out.push('[file attachment]')
        break
      default:
        break
    }
  }
  return out.join('\n').trim()
}

/** True when the line is a JSON object, so a log line is not read as one. */
function isJsonLine(line) {
  if (!line.startsWith('{')) return false
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}

/**
 * A CLI release that ignores the JSON flag still prints its answer as plain
 * text. Recover it only when stdout carried no JSON at all, so a malformed or
 * unexpected event is never passed off as the reply, and fall back to stderr
 * only when stdout was empty.
 */
function plainTextAnswer(stdout, stderr) {
  const clean = (source) =>
    String(source ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/reading additional input from stdin/i.test(line))

  const outLines = clean(stdout)
  if (outLines.some(isJsonLine)) return ''
  const answer = outLines.join('\n').trim()
  if (answer.length > 0) return answer
  return clean(stderr).filter((line) => !isJsonLine(line)).join('\n').trim()
}

/** Parse `opencode models` output: one `provider/model` id per line. */
function parseOpencodeList(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** Parse `grok models` output: bullet lines, `(default)` annotated. */
function parseGrokList(stdout) {
  const ids = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    const match = /^[*-]\s+(\S+)/.exec(line)
    if (match) ids.push(match[1])
  }
  return ids
}

/** Parse one OpenCode `--format json` NDJSON event. */
function parseOpencodeLine(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  // The CLI reports provider failures (quota, auth, model access) as an error
  // event on stdout and still exits 0, so the event is the only signal.
  if (event?.type === 'error') {
    const message = event?.error?.message ?? event?.message ?? (typeof event?.error === 'string' ? event.error : undefined)
    const status = firstNumber(event?.error?.status, event?.status)
    if (typeof message === 'string' && message.length > 0) {
      return { error: status !== undefined ? `${message} (HTTP ${status})` : message }
    }
  }
  if (event?.type === 'text' && typeof event.part?.text === 'string' && event.part.text.length > 0) {
    return { text: event.part.text }
  }
  if (event?.type === 'step_finish') {
    const tokens = event.part?.tokens
    const cost = typeof event.part?.cost === 'number' ? event.part.cost : undefined
    if (tokens && typeof tokens === 'object') {
      return {
        usage: {
          inputTokens: toCount(tokens.input),
          outputTokens: toCount(tokens.output),
          cacheReadTokens: toCount(tokens.cache?.read),
          cacheWriteTokens: toCount(tokens.cache?.write),
          reasoningTokens: toCount(tokens.reasoning),
        },
        cost,
        // One step_finish per agent step, so a turn's total is their sum.
        usageDelta: true,
      }
    }
    if (cost !== undefined) return { cost }
  }
  return null
}

/**
 * Parse one Grok `--output-format streaming-json` line. Observed bare event
 * shapes: `{"type":"text","data":"…"}` per delta, `{"type":"usage","usage":{…}}`,
 * and `{"type":"end","stopReason":"end_turn"}`. ACP `session/update` frames and
 * OpenAI-style chunks are also accepted so a different CLI release still
 * streams text instead of failing the turn.
 */
function parseGrokLine(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (event?.type === 'error') {
    const message = event?.message ?? event?.error?.message ?? (typeof event?.error === 'string' ? event.error : undefined)
    const status = firstNumber(event?.status, event?.error?.status)
    if (typeof message === 'string' && message.length > 0) {
      return { error: status !== undefined ? `${message} (HTTP ${status})` : message }
    }
  }
  if (event?.type === 'result' && (event?.subtype === 'error' || event?.is_error === true)) {
    const message = event?.error?.message ?? event?.result ?? event?.message
    if (typeof message === 'string' && message.length > 0) return { error: message }
  }
  if (event?.type === 'text' && typeof event.data === 'string' && event.data.length > 0) {
    return { text: event.data }
  }
  if ((event?.type === 'thinking' || event?.type === 'reasoning') && typeof event.data === 'string') {
    return { reasoning: event.data }
  }
  if (event?.type === 'usage' && event.usage && typeof event.usage === 'object') {
    return { usage: grokUsage(event.usage) }
  }
  if (event?.type === 'end' || event?.type === 'result') {
    const cost = firstNumber(event.total_cost_usd, event.cost_usd, event.cost)
    const usage = event.usage && typeof event.usage === 'object' ? grokUsage(event.usage) : undefined
    if (cost !== undefined || usage) return { cost, usage }
  }
  const update = event?.params?.update ?? event?.update
  if (update && typeof update === 'object') {
    const kind = update.sessionUpdate ?? update.type
    const text = typeof update.content?.text === 'string' ? update.content.text : undefined
    if (kind === 'agent_message_chunk' || kind === 'agent_message') {
      if (text) return { text }
    }
    if (kind === 'agent_thought_chunk') {
      if (text) return { reasoning: text }
    }
  }
  const choiceText = event?.choices?.[0]?.delta?.content
  if (typeof choiceText === 'string' && choiceText.length > 0) return { text: choiceText }
  return null
}

/** Map Grok's snake_case token counters onto the harness usage vocabulary. */
function grokUsage(usage) {
  return {
    inputTokens: toCount(usage.input_tokens),
    outputTokens: toCount(usage.output_tokens),
    cacheReadTokens: toCount(usage.cache_read_input_tokens),
    cacheWriteTokens: toCount(usage.cache_creation_input_tokens),
    reasoningTokens: toCount(usage.reasoning_tokens),
  }
}

/**
 * Parse one `codex exec --json` JSONL line. Codex emits item lifecycle events
 * and a final `turn.completed` with usage; older releases use flat
 * `agent_message` / `token_count` events, so both spellings are accepted.
 */
function parseCodexLine(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  const item = event?.item
  const itemType = item?.type
  if (event?.type === 'error' && typeof event.message === 'string' && event.message.length > 0) {
    return { error: event.message }
  }
  if (event?.type === 'turn.failed') {
    return { error: event?.error?.message ?? event?.message ?? 'the codex turn failed' }
  }
  if (itemType === 'error' && typeof item.message === 'string' && item.message.length > 0) {
    return { error: item.message }
  }
  if ((itemType === 'agent_message' || itemType === 'assistant_message') && typeof item.text === 'string' && item.text.length > 0) {
    return { text: item.text }
  }
  if (itemType === 'reasoning' && typeof item.text === 'string' && item.text.length > 0) {
    return { reasoning: item.text }
  }
  if (
    (event?.type === 'agent_message' || event?.type === 'assistant_message' || event?.type === 'text') &&
    typeof event.text === 'string' &&
    event.text.length > 0
  ) {
    return { text: event.text }
  }
  const usage = event?.usage ?? event?.info?.last_token_usage ?? event?.info?.total_token_usage
  if (usage && typeof usage === 'object') {
    return { usage: codexUsage(usage) }
  }
  return null
}

/**
 * Map Codex token counters onto the harness vocabulary. Codex reports cached
 * input separately from fresh input, and reasoning as a subset of output.
 */
function codexUsage(usage) {
  const inputTokens = toCount(usage.input_tokens)
  const outputTokens = toCount(usage.output_tokens)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: toCount(usage.cached_input_tokens),
    cacheWriteTokens: 0,
    reasoningTokens: toCount(usage.reasoning_output_tokens),
    totalTokens: toCount(usage.total_tokens) || inputTokens + outputTokens,
  }
}

function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The first finite number among the candidates, so CLI spellings can vary. */
function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** Spawn one CLI process and collect its stdout/stderr to completion. */
function runCapture(bin, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { cwd, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : undefined
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** The first candidate path that exists on disk, else the bare command name. */
function resolveBin(candidates) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean)
  for (const candidate of list) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* fall through */
      }
      continue
    }
    return candidate
  }
  return list.pop()
}

/** One CLI-backed adapter serving every configured route. */
class CliAdapter {
  constructor(ctx, config, signIn, ledger) {
    this.ctx = ctx
    this.config = config
    this.signIn = signIn
    this.ledger = ledger
    this.listCache = new Map()
    this.limitsCache = undefined
    this.routeFactsCache = undefined
    this.cliUsageCache = new Map()
  }

  /** Record a failed turn so the dashboard shows it beside the successful ones. */
  recordFailure(provider, model, startedAt, message) {
    this.ledger?.record({
      at: startedAt,
      ms: Date.now() - startedAt,
      provider,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      ok: false,
      error: String(message).slice(0, 200),
    })
  }

  providerInfo(provider) {
    return { id: provider, name: this.config.providers[provider]?.displayName ?? provider }
  }

  /** The CLI route keeps the harness default retry policy. */
  providerRetryPolicy() {
    return undefined
  }

  /** The CLI route streams text only, so it prices no images. */
  imageRequestPricing() {
    return undefined
  }

  /** Bind exact model metadata to this adapter generation. */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Explain a turn that produced no text. A signed-out CLI is the common cause
   * and the one case the plugin can act on: it starts the CLI's own sign-in and
   * reports the page and code the human must confirm, so the next attempt works.
   */
  async describeEmptyTurn(route, provider, exit, stderr, signal) {
    const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''
    if (this.signIn) {
      try {
        const status = await this.signIn.status(provider)
        if (!status.signedIn) {
          const started = await this.signIn.start(provider, signal)
          const where = [
            started.url ? `open ${started.url}` : undefined,
            started.code ? `confirm code ${started.code}` : undefined,
          ].filter(Boolean).join(' and ')
          return `llm-cli: "${route.displayName}" is not signed in. ${
            where ? `${where}, then send the message again.` : 'Sign in on the host, then send the message again.'
          }`
        }
      } catch {
        /* fall through to the plain explanation */
      }
    }
    return `llm-cli: "${route.displayName}" produced no reply (exit ${exit?.code ?? 'null'})${detail}`
  }

  async listModels(provider) {
    const route = this.config.providers[provider]
    if (!route) return []
    if (Array.isArray(route.models) && route.models.length > 0) {
      return route.models.map((id) => ({ provider, id, name: id }))
    }
    const cached = this.listCache.get(provider)
    if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.models
    let ids = []
    if (typeof route.readModels === 'function') {
      try {
        ids = route.readModels()
      } catch (error) {
        this.ctx.logger?.warn?.(`llm-cli: could not read the model list for route "${provider}": ${error?.message ?? error}`)
      }
    } else {
      try {
        const { stdout } = await runCapture(route.bin, route.listArgs ?? [], {
          cwd: this.config.cwd,
          timeoutMs: 30000,
        })
        ids = route.parseList ? route.parseList(stdout) : []
      } catch (error) {
        this.ctx.logger?.warn?.(`llm-cli: could not list models for route "${provider}": ${error?.message ?? error}`)
      }
    }
    if (ids.length === 0 && route.defaultModel) ids = [route.defaultModel]
    const models = ids.map((id) => ({ provider, id, name: id }))
    this.listCache.set(provider, { at: Date.now(), models })
    return models
  }

  /**
   * What this route can honestly say about one model's limits. Grok's CLI
   * caches the limits its own proxy publishes; the OpenCode CLI prints model
   * ids without limits, so the harness default stands in and says so.
   */
  limitsFor(provider, model) {
    const route = this.config.providers[provider]
    if (provider === 'codex') {
      const now = Date.now()
      if (!this.codexLimitsCache || now - this.codexLimitsCache.at > LIMITS_TTL_MS) {
        let contextWindow
        try {
          contextWindow = readCodexCliUsage(this.config.codexUsageDir)?.contextWindow
        } catch {
          /* the CLI may not have recorded a turn yet */
        }
        this.codexLimitsCache = { at: now, contextWindow }
      }
      const contextWindow = this.codexLimitsCache.contextWindow ?? route?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
      return {
        contextWindow,
        contextWindows: [],
        source: this.codexLimitsCache.contextWindow
          ? 'from the codex session rollouts'
          : 'harness default: Codex has not recorded a context window yet',
      }
    }
    if (provider !== 'grok') {
      return {
        contextWindow: route?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        contextWindows: [],
        source: `harness default: the ${route?.displayName ?? provider} CLI publishes no model limits`,
      }
    }
    const now = Date.now()
    if (!this.limitsCache || now - this.limitsCache.at > LIMITS_TTL_MS) {
      this.limitsCache = { at: now, byModel: readGrokModelLimits() }
    }
    const byModel = this.limitsCache.byModel
    const found = byModel[model]
    if (found) return found
    return {
      contextWindow: route?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      contextWindows: [],
      source:
        Object.keys(byModel).length === 0
          ? 'grok models cache unavailable: sign in with the grok CLI to refresh it'
          : 'this model is not in the grok models cache',
    }
  }

  /**
   * Route identity, sign-in state, model limits and recorded usage for the
   * dashboard. Sign-in probes spawn the CLI, so the whole answer is held for a
   * short TTL.
   */
  async routeFacts() {
    const now = Date.now()
    if (this.routeFactsCache && now - this.routeFactsCache.at < ROUTE_FACTS_TTL_MS) {
      return this.routeFactsCache.entries
    }
    const usage = new Map(this.ledger?.summary().providers.map((row) => [row.key, row]) ?? [])
    const entries = []
    for (const [id, route] of Object.entries(this.config.providers)) {
      let signedIn = null
      let signInText = ''
      if (this.signIn) {
        try {
          const status = await this.signIn.status(id)
          signedIn = status.signedIn
          signInText = status.text
        } catch (error) {
          signInText = String(error?.message ?? error)
        }
      }
      const configured = Array.isArray(route.models) ? route.models.filter(Boolean) : []
      let models = configured
      if (models.length === 0) {
        // No model filter is configured, so the route offers whatever the CLI
        // lists (listModels already falls back to the default model).
        models = (await this.listModels(id)).map((model) => model.id)
      }
      const row = usage.get(id)
      entries.push({
        id,
        displayName: route.displayName ?? id,
        signedIn,
        signInText: signInText.slice(0, 400),
        signInNote: LOGIN[id]?.note ?? '',
        signInOptional: LOGIN[id]?.optional === true,
        bin: Array.isArray(route.bin) ? route.bin[0] : route.bin,
        defaultModel: route.defaultModel,
        models: models.map((model) => ({ id: model, ...this.limitsFor(id, model) })),
        usage: {
          turns: row?.turns ?? 0,
          errors: row?.errors ?? 0,
          inputTokens: row?.inputTokens ?? 0,
          outputTokens: row?.outputTokens ?? 0,
          cacheReadTokens: row?.cacheReadTokens ?? 0,
          costUsd: row?.costUsd ?? 0,
          costTurns: row?.costTurns ?? 0,
          ms: row?.ms ?? 0,
          lastAt: row?.lastAt ?? 0,
        },
      })
    }
    this.routeFactsCache = { at: now, entries }
    return entries
  }

  /**
   * The CLIs' own recorded usage, independent of this harness's ledger: the
   * Grok CLI's per-session usage files, and `opencode stats`. `days` selects a
   * trailing window (7 by convention on the dashboard); 0 means lifetime.
   * Results are cached per window because they touch disk or spawn a process.
   */
  async cliUsage(days = 0) {
    const windowDays = Number.isFinite(days) && days > 0 ? days : 0
    const now = Date.now()
    const cached = this.cliUsageCache.get(windowDays)
    if (cached && now - cached.at < CLI_USAGE_TTL_MS) return cached.value
    const daysArg =
      windowDays > 0 ? statsArgsForDays(this.config.providers.opencode?.statsArgs, windowDays) : undefined
    const value = {
      grok: null,
      opencode: null,
      codex: null,
      plans: {},
      windowDays,
      windowLabel: windowLabelFor(windowDays),
      generatedAt: now,
    }
    let fullGrok = null
    let fullCodex = null
    if (this.config.providers.grok) {
      try {
        fullGrok = readGrokCliUsage(this.config.grokUsageDir)
      } catch (error) {
        fullGrok = { ...blankCliUsage('grok session usage.json files'), note: String(error?.message ?? error) }
      }
    }
    if (this.config.providers.codex) {
      try {
        fullCodex = readCodexCliUsage(this.config.codexUsageDir)
      } catch (error) {
        fullCodex = {
          ...blankCliUsage('codex session rollouts', { cost: false, rateLimits: true, perStep: false }),
          limits: { primary: null, secondary: null },
          note: String(error?.message ?? error),
        }
      }
    }
    if (this.config.providers.opencode) {
      try {
        value.opencode = await readOpencodeCliUsage(this.config.providers.opencode, this.config.cwd, 30000, daysArg)
      } catch (error) {
        value.opencode = {
          ...blankCliUsage('opencode stats', { cost: true, rateLimits: false, perStep: true }),
          note: String(error?.message ?? error),
        }
      }
    }
    try {
      value.plans = await computePlans(this.config.plan, { grok: fullGrok, opencode: value.opencode }, this, now)
    } catch {
      value.plans = {}
    }
    const since = windowDays > 0 ? now - windowDays * 86400000 : 0
    value.grok = fullGrok ? windowGrokUsage(fullGrok, since, windowDays) : null
    value.codex = fullCodex ? windowCliUsage(fullCodex, since, 'codex', windowDays) : null
    this.cliUsageCache.set(windowDays, { at: now, value })
    return value
  }

  async resolveModel(provider, model) {
    const route = this.config.providers[provider]
    const limits = this.limitsFor(provider, model)
    return {
      provider,
      id: model,
      name: model,
      context: {
        contextWindow: limits.contextWindow ?? route?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      },
    }
  }

  async *stream(options) {
    const provider = options.provider
    const route = this.config.providers[provider]
    if (!route) throw new Error(`llm-cli: unknown provider route "${provider}"`)
    const turnStartedAt = Date.now()

    // A missing cwd makes spawn fail with an ENOENT that names the binary, so
    // the turn looks like a missing CLI instead of a bad config path.
    let cwdIsDirectory = false
    try {
      cwdIsDirectory = statSync(this.config.cwd).isDirectory()
    } catch {
      cwdIsDirectory = false
    }
    if (!cwdIsDirectory) {
      const message = `llm-cli: the configured cwd is not a directory: ${this.config.cwd}`
      this.recordFailure(provider, options.model, turnStartedAt, message)
      throw new Error(message)
    }

    const prompt = buildPrompt(options, this.config.includeSystemPrompt === true)
    const bin = route.bin
    let promptFile
    let promptDir
    if (prompt.length > ARG_PROMPT_LIMIT || route.promptMode === 'file') {
      promptDir = mkdtempSync(join(tmpdir(), 'dsh-llm-cli-'))
      promptFile = join(promptDir, 'prompt.txt')
      writeFileSync(promptFile, prompt, 'utf8')
    }
    const args = route.buildArgs(options.model, prompt, promptFile)

    const child = spawn(bin, args, {
      cwd: this.config.cwd,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    let aborted = false
    const onAbort = () => {
      aborted = true
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const timeoutMs = route.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let timedOut = false
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill() }, timeoutMs) : undefined

    const finishCleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (child.exitCode === null) child.kill()
      if (promptDir) {
        try {
          rmSync(promptDir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    }

    let started = false
    let text = ''
    let usage
    let cost
    // Block indices are allocated on first use, so text that starts before any
    // reasoning cannot collide with the reasoning block's index.
    let nextIndex = 0
    let textIndex = -1
    let reasoningIndex = -1
    let reasoningText = ''
    let cliError = ''
    let stdout = ''

    try {
      const closed = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }))
        child.on('error', (error) => resolve({ code: null, signal: null, error }))
      })

      const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
      for await (const line of reader) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        stdout += `${line}\n`
        const parsed = route.parseLine ? route.parseLine(trimmed) : null
        if (parsed?.error) cliError = String(parsed.error).slice(0, 400)
        if (parsed?.usage) {
          // A route that reports usage per agent step accumulates it. A route
          // that reports one total for the turn replaces it, so nothing is
          // counted twice.
          usage = parsed.usageDelta ? addUsage(usage ?? {}, parsed.usage) : parsed.usage
        }
        if (parsed?.cost !== undefined) {
          cost = parsed.usageDelta ? (cost ?? 0) + parsed.cost : parsed.cost
        }
        if (parsed?.reasoning) {
          if (reasoningIndex < 0) {
            reasoningIndex = nextIndex
            nextIndex += 1
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          reasoningText += parsed.reasoning
          yield { type: 'reasoning-delta', index: reasoningIndex, text: parsed.reasoning }
        }
        if (parsed?.text) {
          if (textIndex < 0) {
            textIndex = nextIndex
            nextIndex += 1
            started = true
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          text += parsed.text
          yield { type: 'text-delta', index: textIndex, text: parsed.text }
        }
      }

      const exit = await closed

      if (aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was aborted', code: 'ABORTED' } } }
        return
      }

      if (exit?.error) {
        const message = `llm-cli: failed to start "${route.displayName}": ${exit.error.message}`
        this.recordFailure(provider, options.model, turnStartedAt, message)
        throw new Error(message)
      }

      // A killed CLI used to hand back whatever it had streamed as a finished
      // answer, so a timeout read as a short reply instead of a failure.
      if (timedOut) {
        const message = `llm-cli: "${route.displayName}" timed out after ${timeoutMs} ms`
        this.recordFailure(provider, options.model, turnStartedAt, message)
        throw new Error(message)
      }

      if (text.length === 0 && exit?.code === 0) {
        const answer = plainTextAnswer(stdout, stderr)
        if (answer.length > 0) text = answer
      }

      if (text.length === 0) {
        const message = cliError
          ? `llm-cli: "${route.displayName}" returned an error: ${cliError}`
          : await this.describeEmptyTurn(route, provider, exit, stderr, options.signal)
        this.recordFailure(provider, options.model, turnStartedAt, message)
        throw new Error(message)
      }

      if (!started) {
        textIndex = nextIndex
        nextIndex += 1
        started = true
        yield { type: 'block-start', index: textIndex, blockType: 'text' }
        yield { type: 'text-delta', index: textIndex, text }
      }

      yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
      if (reasoningIndex >= 0) {
        yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
      }
      if (usage) yield { type: 'usage', usage }
      this.ledger?.record({
        at: turnStartedAt,
        ms: Date.now() - turnStartedAt,
        provider,
        model: options.model,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        costUsd: cost,
        ok: true,
      })
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      finishCleanup()
    }
  }
}

/**
 * Per-route CLI sign-in commands and signed-in detection. The CLI owns the
 * credential (it writes its own config), so the plugin only drives the login
 * and reports what the human must do.
 */
const LOGIN = {
  opencode: {
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'list'],
    signedIn: (out) => !/no authenticated integrations/i.test(out),
    note: 'OpenCode free models need no sign-in; this is only for a paid OpenCode account.',
    optional: true,
  },
  grok: {
    loginArgs: ['login', '--device-auth'],
    statusArgs: ['models'],
    signedIn: (out) => /logged in/i.test(out) && !/not authenticated/i.test(out),
    note: 'Signs in with your Grok / X Premium account using a device code.',
  },
  codex: {
    loginArgs: ['login', '--device-auth'],
    statusArgs: ['login', 'status'],
    signedIn: (out) => /logged in|signed in|authenticated/i.test(out) && !/not logged in|not signed in|no credentials/i.test(out),
    note: 'Signs in with your ChatGPT account using a device code (uses your Codex subscription).',
  },
}

/** Pull the page and short code out of a CLI device-code prompt. */
function parseDeviceInfo(text) {
  const url = /https?:\/\/[^\s'"]+/.exec(text)?.[0]
  const fromUrl = url ? /user_code=([A-Za-z0-9._-]+)/.exec(url)?.[1] : undefined
  const code = fromUrl ?? /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text)?.[1]
  return { url, code }
}

/** Drives one CLI's sign-in at a time and remembers what is waiting. */
class SignInManager {
  constructor(config) {
    this.config = config
    this.pending = new Map()
  }

  routeFor(provider) {
    const route = this.config.providers[provider]
    const login = LOGIN[provider]
    if (!route || !login) throw new Error(`llm-cli: no sign-in is known for provider "${provider}"`)
    // A route may override the sign-in commands (used by tests and by a CLI
    // whose login verb differs from the built-in one).
    return {
      route,
      login,
      loginArgs: route.loginArgs ?? login.loginArgs,
      statusArgs: route.statusArgs ?? login.statusArgs,
      signedIn: route.signedIn ?? login.signedIn,
      note: route.signInNote ?? login.note,
    }
  }

  /** Ask the CLI itself whether it is already signed in. */
  async status(provider) {
    const { route, signedIn, statusArgs } = this.routeFor(provider)
    const { stdout, stderr } = await runCapture(route.bin, statusArgs, {
      cwd: this.config.cwd,
      timeoutMs: 30000,
    }).catch(() => ({ stdout: '', stderr: '' }))
    const text = `${stdout}\n${stderr}`
    // `grok models` reports signed-out state on exit code 1, so the text decides.
    return { signedIn: signedIn(text), text: text.trim() }
  }

  /**
   * Start a sign-in and return the device instruction as soon as the CLI
   * prints it, leaving the process waiting for the human to approve.
   */
  async start(provider, signal) {
    const existing = this.pending.get(provider)
    if (existing) return { url: existing.url, code: existing.code, resumed: true }
    const { route, loginArgs, note } = this.routeFor(provider)
    const child = spawn(route.bin, loginArgs, {
      cwd: this.config.cwd,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    const collect = (chunk) => {
      text += chunk
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const done = new Promise((resolve) => {
      child.on('close', (code) => resolve({ code, text }))
      child.on('error', (error) => resolve({ code: null, text: `${text}\n${error.message}` }))
    })

    // Poll for the prompt rather than reading one line: the CLI may print the
    // URL and the code on separate writes.
    const deadline = Date.now() + 15000
    let info = parseDeviceInfo(text)
    while (!info.url && !info.code && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      info = parseDeviceInfo(text)
    }

    if (child.exitCode !== null && !info.url && !info.code) {
      const settled = await done
      throw new Error(`llm-cli: "${provider}" sign-in exited before printing a code: ${settled.text.trim().slice(0, 400)}`)
    }

    this.pending.set(provider, { child, done, url: info.url, code: info.code })
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    done.then(() => signal?.removeEventListener('abort', onAbort))

    return { url: info.url, code: info.code, note }
  }

  /** Report whether a started sign-in finished, within a short bound. */
  async settle(provider, waitMs) {
    const entry = this.pending.get(provider)
    if (!entry) return { pending: false }
    const result = await Promise.race([
      entry.done,
      new Promise((resolve) => setTimeout(() => resolve(undefined), waitMs)),
    ])
    if (result === undefined) return { pending: true, url: entry.url, code: entry.code }
    this.pending.delete(provider)
    if (entry.child.exitCode === null) entry.child.kill()
    const status = await this.status(provider)
    return { pending: false, signedIn: status.signedIn, output: result.text.trim().slice(0, 600), code: result.code }
  }
}

/** One accumulator row, in the shape the dashboard has always consumed. */
function blankRow(key) {
  return {
    key,
    turns: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    // Turns that reported a cost at all. A route whose CLI never reports one
    // (Codex) would otherwise show a confident $0.00.
    costTurns: 0,
    ms: 0,
    lastAt: 0,
  }
}

/** Fold one turn into a row in place. */
function bumpRow(row, entry) {
  row.turns += 1
  if (!entry.ok) row.errors += 1
  row.inputTokens += entry.inputTokens ?? 0
  row.outputTokens += entry.outputTokens ?? 0
  row.cacheReadTokens += entry.cacheReadTokens ?? 0
  if (typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd)) {
    row.costUsd += entry.costUsd
    row.costTurns += 1
  }
  row.ms += entry.ms ?? 0
  row.lastAt = Math.max(row.lastAt, entry.at ?? 0)
  return row
}

/**
 * Lifetime totals live beside the retained turns, not inside them. Deriving
 * them from the capped `entries` array makes every figure plateau at the
 * retention limit, so a long-lived install would under-report forever.
 */
function emptyTotals() {
  return { turns: 0, providers: {}, models: {} }
}

function addToTotals(totals, entry) {
  totals.turns += 1
  const providerKey = String(entry.provider ?? '')
  const modelKey = `${providerKey}/${entry.model}`
  totals.providers[providerKey] = bumpRow(totals.providers[providerKey] ?? blankRow(providerKey), entry)
  totals.models[modelKey] = bumpRow(totals.models[modelKey] ?? blankRow(modelKey), entry)
  return totals
}

function totalsFrom(entries) {
  const totals = emptyTotals()
  for (const entry of entries ?? []) addToTotals(totals, entry)
  return totals
}

/** Keep a persisted totals block only when it still has the expected shape. */
function readTotals(candidate) {
  if (!candidate || typeof candidate !== 'object') return null
  const providers = candidate.providers && typeof candidate.providers === 'object' ? candidate.providers : null
  const models = candidate.models && typeof candidate.models === 'object' ? candidate.models : null
  if (!providers || !models || !Number.isFinite(candidate.turns)) return null
  // Totals written before costTurns existed are ambiguous when the cost is
  // zero, which is exactly the case a dash exists for. A positive total proves
  // some turn reported a cost, so it keeps the figure it showed.
  for (const row of [...Object.values(providers), ...Object.values(models)]) {
    if (row && !Number.isFinite(row.costTurns)) row.costTurns = row.costUsd > 0 ? row.turns ?? 0 : 0
  }
  return { turns: candidate.turns, providers, models }
}

/**
 * Per-route usage ledger: one record per finished CLI turn, persisted so the
 * dashboard survives a harness restart. Records carry counts and cost only,
 * never prompt or reply text.
 */
class UsageLedger {
  constructor(file, limit) {
    this.file = file
    this.limit = limit ?? 1000
    this.entries = []
    this.totals = emptyTotals()
    this.load()
  }

  load() {
    if (!this.file) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      /* first run, or an unreadable ledger: start empty */
      return
    }
    if (Array.isArray(parsed?.entries)) this.entries = parsed.entries.slice(-this.limit)
    // A version 1 file has no totals block, so recover them from the turns it
    // does carry. That is the best available answer, not a lifetime figure.
    this.totals = readTotals(parsed?.totals) ?? totalsFrom(parsed?.entries)
    if (this.totals.turns < this.entries.length) this.totals.turns = this.entries.length
  }

  record(entry) {
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit)
    addToTotals(this.totals, entry)
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ version: 2, totals: this.totals, entries: this.entries }), 'utf8')
    } catch {
      /* the dashboard still serves from memory; persistence is best effort */
    }
  }

  /** Lifetime totals per route and per model, plus the newest turns first. */
  summary() {
    const sortByTurns = (left, right) => right.turns - left.turns
    return {
      providers: Object.values(this.totals.providers).sort(sortByTurns),
      models: Object.values(this.totals.models).sort(sortByTurns),
      turns: this.totals.turns,
      recent: this.entries.slice(-60).reverse(),
      ledgerFile: this.file,
    }
  }
}

/** Format a token count compactly. */
function compact(value) {
  const count = Number(value) || 0
  if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`
  return String(count)
}

/** Escape a value for HTML text and attribute positions. */
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  )
}

/** A local-time stamp, or a dash when there is no timestamp yet. */
function stamp(at) {
  if (!at) return '—'
  return new Date(at).toLocaleString('en-GB', { hour12: false })
}

/** Parse the dashboard's trailing-window query parameter (`?days=7`, `?hours=5`). */
function windowDaysFromUrl(url) {
  try {
    const params = new URL(url ?? '', 'http://localhost').searchParams
    const hours = params.get('hours')
    if (hours !== null && hours !== '') {
      const value = Number(hours)
      if (Number.isFinite(value) && value > 0) return value / 24
    }
    const value = params.get('days')
    if (value === null || value === '') return 7
    if (/^(all|0|off|lifetime)$/i.test(value)) return 0
    const days = Number(value)
    return Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : 7
  } catch {
    return 7
  }
}

/** A short human label for a trailing window measured in (possibly fractional) days. */
function windowLabelFor(days) {
  if (!(days > 0)) return 'lifetime'
  if (days < 1) return `last ${Math.round(days * 24)}h`
  return `last ${days} day${days === 1 ? '' : 's'}`
}

/**
 * The dashboard payload: recorded usage plus, per route, the identity, the
 * sign-in state and the per-model limits the CLI itself publishes.
 */
async function describeRoutes(adapter, ledger, days = 0) {
  const summary = ledger.summary()
  const routes = await adapter.routeFacts()
  let cliUsage = { grok: null, opencode: null, plans: {}, windowDays: 0 }
  try {
    cliUsage = await adapter.cliUsage(days)
  } catch {
    /* the ledger view still renders without the CLIs' own accounting */
  }
  return {
    ...summary,
    generatedAt: Date.now(),
    totalCostUsd: summary.providers.reduce((sum, row) => sum + row.costUsd, 0),
    cliUsage,
    plans: cliUsage.plans ?? {},
    windowDays: cliUsage.windowDays ?? 0,
    windowLabel: cliUsage.windowLabel ?? '',
    routes,
    limitsNotice:
      'A CLI-backed route reports only what its CLI publishes. The Grok CLI persists per-session token and cost accounting locally (read here for its own totals) and caches per-model context limits, but it exposes no subscription quota, no remaining-request count and no reset time, so any "plan" gauge is your own configured budget. The OpenCode CLI publishes per-model limits only through `opencode stats`, which this page also reads. Token counts and cost under "this harness" are measured from this harness\u2019s own turns.',
  }
}

/** A tiny server-rendered vertical bar chart (SVG) for the standalone page. */
function barChartSvg(points, { color = '#6fb3ff', width = 720, height = 150, format = (value) => String(value) } = {}) {
  if (!Array.isArray(points) || points.length === 0) return ''
  const padX = 6
  const padTop = 10
  const padBottom = 22
  const max = Math.max(1, ...points.map((point) => point.value || 0))
  const gap = 4
  const barWidth = Math.max(2, (width - padX * 2 - gap * (points.length - 1)) / points.length)
  const plotHeight = height - padTop - padBottom
  const bars = points
    .map((point, index) => {
      const value = point.value || 0
      const barHeight = Math.round(plotHeight * (value / max))
      const x = padX + index * (barWidth + gap)
      const y = padTop + (plotHeight - barHeight)
      return `<rect x="${x.toFixed(1)}" y="${y}" width="${barWidth.toFixed(1)}" height="${barHeight}" rx="2" fill="${color}"><title>${escapeHtml(point.label)}: ${escapeHtml(format(value))}</title></rect>`
    })
    .join('')
  const every = Math.max(1, Math.ceil(points.length / 14))
  const labels = points
    .map((point, index) =>
      index % every === 0
        ? `<text x="${(padX + index * (barWidth + gap) + barWidth / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="9" fill="#7d8694">${escapeHtml(point.short ?? point.label)}</text>`
        : '',
    )
    .join('')
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img">${bars}${labels}</svg>`
}

/** A horizontal used/budget bar with a colour that reacts to pressure. */
function gaugeHtml(percent, label) {
  const clamped = Math.max(0, Math.min(1, Number(percent) || 0))
  const tone = clamped >= 0.9 ? '#ff8a8a' : clamped >= 0.7 ? '#ffcf6b' : '#7ee0a0'
  return `<div class="gauge"><div class="gauge-fill" style="width:${(clamped * 100).toFixed(1)}%;background:${tone}"></div></div><div class="gauge-label">${escapeHtml(label)}</div>`
}

/** The self-contained usage dashboard page, rendered server-side. */
function renderUsageHtml(summary, generatedAt, routes, notice, cliUsage, plans) {
  const row = (cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`
  const providerRows = summary.providers
    .map((item) =>
      row([
        `<strong>${escapeHtml(item.key)}</strong>`,
        item.turns,
        compact(item.inputTokens),
        compact(item.outputTokens),
        compact(item.cacheReadTokens),
        `$${item.costUsd.toFixed(4)}`,
        `${(item.ms / item.turns / 1000).toFixed(1)}s`,
        item.errors || '',
        stamp(item.lastAt),
      ]),
    )
    .join('')
  const modelRows = summary.models
    .map((item) =>
      row([
        escapeHtml(item.key),
        item.turns,
        compact(item.inputTokens),
        compact(item.outputTokens),
        `$${item.costUsd.toFixed(4)}`,
        `${(item.ms / item.turns / 1000).toFixed(1)}s`,
      ]),
    )
    .join('')
  const recentRows = summary.recent
    .map((entry) =>
      row([
        stamp(entry.at),
        escapeHtml(entry.provider),
        escapeHtml(entry.model),
        compact(entry.inputTokens ?? 0),
        compact(entry.outputTokens ?? 0),
        entry.costUsd === undefined ? '—' : `$${entry.costUsd.toFixed(4)}`,
        `${((entry.ms ?? 0) / 1000).toFixed(1)}s`,
        entry.ok ? 'ok' : `<span class="bad">${escapeHtml(entry.error ?? 'failed')}</span>`,
      ]),
    )
  const limitRows = (routes ?? [])
    .flatMap((route) =>
      route.models.map((model) =>
        row([
          `<strong>${escapeHtml(route.displayName)}</strong>`,
          escapeHtml(model.id),
          model.contextWindow ? compact(model.contextWindow) : '\u2014',
          model.maxOutputTokens ? compact(model.maxOutputTokens) : '\u2014',
          escapeHtml(model.source ?? ''),
        ]),
      ),
    )
    .join('')
  const routeCards = (routes ?? [])
    .map(
      (route) =>
        `<div class="card"><div class="k">${escapeHtml(route.displayName)}</div><div class="v">${route.usage.turns} turns</div><div class="k">${route.usage.costTurns === 0 ? '\u2014' : `$${route.usage.costUsd.toFixed(4)}`} \u00b7 ${compact(route.usage.inputTokens)} in / ${compact(route.usage.outputTokens)} out<br>${
          route.signedIn === null ? 'sign-in unknown' : route.signedIn ? 'signed in' : 'not signed in'
        }</div></div>`,
    )
    .join('')
  const grokCli = cliUsage?.grok
  const opencodeCli = cliUsage?.opencode
  const codexCli = cliUsage?.codex
  const cliCards = []
  // A CLI that could not answer, or that never reports a figure, gets a dash.
  // Printing 0 claims a measurement the CLI never made.
  const dash = '\u2014'
  if (grokCli?.available !== undefined) {
    cliCards.push(
      `<div class="card"><div class="k">Grok CLI tokens</div><div class="v">${grokCli.available ? compact(grokCli.totalTokens) : dash}</div><div class="k">${
        grokCli.available
          ? `${grokCli.sessionCount} sessions \u00b7 ${compact(grokCli.inputTokens)} in / ${compact(grokCli.outputTokens)} out`
          : escapeHtml(grokCli.note ?? 'unavailable')
      }</div></div>` +
        `<div class="card"><div class="k">Grok CLI cost</div><div class="v">${grokCli.available ? `$${(grokCli.costUsd ?? 0).toFixed(2)}` : dash}</div><div class="k">${
          grokCli.available ? 'from grok session usage' : escapeHtml(grokCli.capabilities?.costReason ?? grokCli.note ?? 'unavailable')
        }</div></div>`,
    )
  }
  if (codexCli?.available !== undefined) {
    cliCards.push(
      `<div class="card"><div class="k">Codex CLI tokens</div><div class="v">${codexCli.available ? compact(codexCli.totalTokens) : dash}</div><div class="k">${
        codexCli.available
          ? `${codexCli.sessionCount} sessions \u00b7 ${compact(codexCli.inputTokens)} in / ${compact(codexCli.outputTokens)} out`
          : escapeHtml(codexCli.note ?? 'unavailable')
      }</div></div>` +
        `<div class="card"><div class="k">Codex cost</div><div class="v">${dash}</div><div class="k">${escapeHtml(
          codexCli.capabilities?.costReason ?? 'the Codex CLI reports no cost',
        )}</div></div>`,
    )
  }
  if (opencodeCli?.available !== undefined) {
    cliCards.push(
      `<div class="card"><div class="k">OpenCode CLI tokens</div><div class="v">${opencodeCli.available ? compact(opencodeCli.totalTokens) : dash}</div><div class="k">${
        opencodeCli.available
          ? `${opencodeCli.sessions ?? 0} sessions \u00b7 ${compact(opencodeCli.prompts ?? 0)} prompts`
          : escapeHtml(opencodeCli.note ?? 'unavailable')
      }</div></div>` +
        `<div class="card"><div class="k">OpenCode CLI cost</div><div class="v">${opencodeCli.available ? `$${(opencodeCli.costUsd ?? 0).toFixed(2)}` : dash}</div><div class="k">${
          opencodeCli.available ? `${opencodeCli.steps ?? 0} steps` : escapeHtml(opencodeCli.note ?? 'unavailable')
        }</div></div>`,
    )
  }
  const planCards = []
  if (plans?.grok) {
    planCards.push(
      `<div class="card"><div class="k">Grok plan (cost)</div><div class="v">$${plans.grok.usedUsd.toFixed(2)} / $${plans.grok.budgetUsd.toFixed(2)}</div>${gaugeHtml(plans.grok.percent, `${(plans.grok.percent * 100).toFixed(1)}% used · resets day ${plans.grok.resetDay}`)}</div>`,
    )
  }
  if (plans?.grokWeekly) {
    planCards.push(
      `<div class="card"><div class="k">Grok weekly premium limit</div><div class="v">${(plans.grokWeekly.usedPercent ?? 0).toFixed(0)}% used</div>${gaugeHtml((plans.grokWeekly.usedPercent ?? 0) / 100, `resets ${stamp(plans.grokWeekly.resetsAt)}`)}</div>`,
    )
  }
  const codexLimits = codexCli?.limits ?? {}
  for (const [title, minutes, limit] of [
    ['Codex 5-hour limit', codexLimits.primary?.windowMinutes ?? 300, codexLimits.primary],
    ['Codex weekly limit', codexLimits.secondary?.windowMinutes ?? 10080, codexLimits.secondary],
  ]) {
    if (limit) {
      planCards.push(
        `<div class="card"><div class="k">${title} (reported by the CLI)</div><div class="v">${(limit.usedPercent ?? 0).toFixed(0)}% used</div>${gaugeHtml((limit.usedPercent ?? 0) / 100, `${minutes >= 1440 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 60)}h`} window · resets ${stamp(limit.resetsAt)}`)}</div>`,
      )
    }
  }
  if (plans?.opencode) {
    const tokenPlan = plans.opencode.metric === 'tokens'
    const used = tokenPlan ? compact(plans.opencode.usedTokens) : `$${plans.opencode.usedUsd.toFixed(2)}`
    const budget = tokenPlan ? compact(plans.opencode.budgetTokens) : `$${plans.opencode.budgetUsd.toFixed(2)}`
    planCards.push(
      `<div class="card"><div class="k">OpenCode plan (${plans.opencode.metric})</div><div class="v">${used} / ${budget}</div>${gaugeHtml(plans.opencode.percent, `${(plans.opencode.percent * 100).toFixed(1)}% used \u00b7 last ${plans.opencode.periodDays}d`)}</div>`,
    )
  }
  const grokDaily = (grokCli?.daily ?? []).slice(-30)
  const grokChart = grokDaily.length
    ? `<h2>Grok daily tokens (CLI)</h2><div class="chart">${barChartSvg(
        grokDaily.map((day) => ({ label: day.date, short: day.date.slice(5), value: day.totalTokens })),
        { format: compact },
      )}</div>`
    : ''
  const opencodeDaily = (opencodeCli?.daily ?? []).slice(-30)
  const opencodeChart = opencodeDaily.length
    ? `<h2>OpenCode daily steps (CLI)</h2><div class="chart">${barChartSvg(
        opencodeDaily.map((day) => ({ label: day.date, short: day.date.slice(5), value: day.steps })),
        { color: '#7ee0a0' },
      )}</div>`
    : ''
  const codexDaily = (codexCli?.daily ?? []).slice(-30)
  const codexChart = codexDaily.length
    ? `<h2>Codex daily tokens (CLI)</h2><div class="chart">${barChartSvg(
        codexDaily.map((day) => ({ label: day.date, short: day.date.slice(5), value: day.totalTokens })),
        { format: compact },
      )}</div>`
    : ''
  const grokModelRows = (grokCli?.models ?? [])
    .map((model) =>
      row([
        escapeHtml(model.id),
        model.turns || model.modelCalls || '',
        compact(model.inputTokens),
        compact(model.outputTokens),
        compact(model.cacheReadTokens),
        compact(model.totalTokens),
        `$${(model.costUsd ?? 0).toFixed(4)}`,
      ]),
    )
    .join('')
  const opencodeModelRows = (opencodeCli?.models ?? [])
    .map((model) =>
      row([
        escapeHtml(model.id),
        model.steps || '',
        compact(model.inputTokens),
        compact(model.outputTokens),
        compact(model.cacheReadTokens),
        compact(model.totalTokens),
        `$${(model.costUsd ?? 0).toFixed(4)}`,
      ]),
    )
    .join('')
  const codexModelRows = (codexCli?.models ?? [])
    .map((model) =>
      row([
        escapeHtml(model.id),
        model.turns || '',
        compact(model.inputTokens),
        compact(model.outputTokens),
        compact(model.cacheReadTokens),
        compact(model.totalTokens),
        codexCli?.capabilities?.cost === false ? dash : `$${(model.costUsd ?? 0).toFixed(4)}`,
      ]),
    )
    .join('')
  const cliModelTable = (heading, rowsHtml, emptyNote) =>
    `<h2>${heading}</h2><div class="wrap"><table><thead><tr><th>Model</th><th>Steps</th><th>In</th><th>Out</th><th>Cache read</th><th>Total</th><th>Cost</th></tr></thead><tbody>${rowsHtml || `<tr><td colspan="7">${emptyNote}</td></tr>`}</tbody></table></div>`
  const cliSections =
    (cliCards.length || planCards.length) > 0
      ? `<h2>CLI-recorded usage</h2><div class="cards">${cliCards.join('')}</div>${
          planCards.length ? `<h2>Usage plans and subscription limits</h2><div class="cards">${planCards.join('')}</div>` : ''
        }${grokChart}${codexChart}${opencodeChart}${
          grokModelRows || opencodeModelRows || codexModelRows
            ? `<div class="cli-models">${
                grokModelRows ? cliModelTable('Grok usage by model', grokModelRows, 'No grok model usage recorded.') : ''
              }${
                codexModelRows ? cliModelTable('Codex usage by model', codexModelRows, 'No codex model usage recorded.') : ''
              }${
                opencodeModelRows
                  ? cliModelTable('OpenCode usage by model', opencodeModelRows, 'No OpenCode model usage recorded.')
                  : ''
              }</div>`
            : ''
        }`
      : ''
  const windowDaysShown = cliUsage?.windowDays ?? 0
  const windowLabel = cliUsage?.windowLabel ?? windowLabelFor(windowDaysShown)
  const windowLink = (query, text) =>
    `<a href="/llm-cli/usage?${query}" style="color:#6fb3ff">${text}</a>`
  const windowLinks = [
    windowLink('hours=5', '5h'),
    windowLink('days=7', '7d'),
    windowLink('days=30', '30d'),
    windowLink('days=90', '90d'),
    windowLink('days=all', 'all'),
  ].join(' \u00b7 ')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>CLI provider usage</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0f1115; color: #e6e8eb;
    font: 14px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; color: #9aa4b2; font-weight: 600; }
  .sub { color: #7d8694; font-size: 12px; margin-bottom: 18px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; }
  .card { background: #171a21; border: 1px solid #232833; border-radius: 10px; padding: 12px 16px; min-width: 150px; }
  .card .k { color: #7d8694; font-size: 12px; }
  .card .v { font-size: 22px; font-weight: 650; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: #171a21; border: 1px solid #232833; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #232833; white-space: nowrap; }
  th { color: #8b95a3; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  tr:last-child td { border-bottom: none; }
  .bad { color: #ff8a8a; }
  .ok { color: #7ee0a0; }
  .wrap { overflow-x: auto; }
  footer { color: #5c6570; font-size: 12px; margin-top: 24px; }
  .note { color: #8b95a3; font-size: 12px; max-width: 900px; margin: 10px 0 0; }
  .gauge { height: 8px; border-radius: 999px; background: #232833; overflow: hidden; margin-top: 8px; }
  .gauge-fill { height: 100%; border-radius: 999px; }
  .gauge-label { color: #7d8694; font-size: 11px; margin-top: 4px; }
  .chart { background: #171a21; border: 1px solid #232833; border-radius: 10px; padding: 8px 6px 2px; }
  .cli-models h2 { margin-top: 20px; }
  code { background: #171a21; border: 1px solid #232833; border-radius: 6px; padding: 1px 5px; }
</style>
</head>
<body>
<h1>CLI provider usage</h1>
<div class="sub">OpenCode, Grok and Codex CLI usage · ${windowLabel} · window ${windowLinks} · page refreshes every 20s · <a href="/llm-cli/usage.json?days=${windowDaysShown || 'all'}" style="color:#6fb3ff">JSON</a></div>
<div class="cards">
  <div class="card"><div class="k">Turns recorded</div><div class="v">${summary.turns}</div></div>
  <div class="card"><div class="k">Total spend</div><div class="v">$${summary.providers.reduce((sum, item) => sum + item.costUsd, 0).toFixed(4)}</div></div>
  <div class="card"><div class="k">Input tokens</div><div class="v">${compact(summary.providers.reduce((sum, item) => sum + item.inputTokens, 0))}</div></div>
  <div class="card"><div class="k">Output tokens</div><div class="v">${compact(summary.providers.reduce((sum, item) => sum + item.outputTokens, 0))}</div></div>
</div>
${cliSections}
${routeCards ? `<h2>Routes</h2>
<div class="cards">${routeCards}</div>` : ''}
${limitRows ? `<h2>Model limits</h2>
<div class="wrap"><table>
<thead><tr><th>Route</th><th>Model</th><th>Context window</th><th>Max output</th><th>Source</th></tr></thead>
<tbody>${limitRows}</tbody>
</table></div>` : ''}
${notice ? `<p class="note">${escapeHtml(notice)}</p>` : ''}
<h2>By provider</h2>
<div class="wrap"><table>
<thead><tr><th>Provider</th><th>Turns</th><th>In</th><th>Out</th><th>Cache read</th><th>Cost</th><th>Avg</th><th>Errors</th><th>Last used</th></tr></thead>
<tbody>${providerRows || '<tr><td colspan="9">No turns recorded yet.</td></tr>'}</tbody>
</table></div>
<h2>By model</h2>
<div class="wrap"><table>
<thead><tr><th>Model</th><th>Turns</th><th>In</th><th>Out</th><th>Cost</th><th>Avg</th></tr></thead>
<tbody>${modelRows || '<tr><td colspan="6">No turns recorded yet.</td></tr>'}</tbody>
</table></div>
<h2>Recent turns</h2>
<div class="wrap"><table>
<thead><tr><th>When</th><th>Provider</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th><th>Time</th><th>Result</th></tr></thead>
<tbody>${recentRows || '<tr><td colspan="8">No turns recorded yet.</td></tr>'}</tbody>
</table></div>
<footer>Ledger: <code>${escapeHtml(summary.ledgerFile ?? 'in memory only')}</code> · rendered ${escapeHtml(stamp(generatedAt))}</footer>
</body>
</html>
`
}

/** JSON Schema for the sign-in tools' shared `provider` argument. */
const SIGNIN_PARAMS = {
  type: 'object',
  properties: {
    provider: {
      type: 'string',
      description: 'Which CLI to sign in: "grok" (Grok Build) or "opencode" (OpenCode CLI).',
    },
  },
  required: ['provider'],
  additionalProperties: false,
}

/** The registry-ready tool definitions this plugin contributes. */
function buildTools(manager) {
  const render = (_args, value) => [{ type: 'text', text: String(value) }]
  return [
    {
      name: 'provider_signin',
      description:
        'Start signing a provider CLI into its account. Returns a page URL and a short code the user must confirm in their browser. Use it when the user asks to sign in to Grok or OpenCode, or when a CLI model reports it is not authenticated.',
      parameters: SIGNIN_PARAMS,
      output: { schema: { type: 'string' }, render },
      async execute(args, exec) {
        const provider = String(args?.provider ?? '').toLowerCase()
        const before = await manager.status(provider)
        if (before.signedIn) return `Already signed in to "${provider}".`
        const started = await manager.start(provider, exec?.signal)
        const lines = [`Sign-in started for "${provider}".`]
        if (started.note) lines.push(started.note)
        if (started.resumed) lines.push('A sign-in for this provider is already waiting.')
        if (started.url) lines.push(`Open: ${started.url}`)
        if (started.code) lines.push(`Confirm this code: ${started.code}`)
        if (!started.url && !started.code) lines.push('The CLI did not print a code yet; check the host terminal.')
        lines.push('After confirming in the browser, call provider_signin_status to verify.')
        return lines.join('\n')
      },
    },
    {
      name: 'provider_signin_status',
      description:
        'Check whether a provider CLI sign-in finished. Call it after the user confirms the device code, to verify the CLI is authenticated.',
      parameters: SIGNIN_PARAMS,
      output: { schema: { type: 'string' }, render },
      async execute(args) {
        const provider = String(args?.provider ?? '').toLowerCase()
        const settled = await manager.settle(provider, 20000)
        if (settled.pending) {
          return `Still waiting for the "${provider}" sign-in to be approved. Code: ${settled.code ?? '(none printed)'}`
        }
        const status = await manager.status(provider)
        return status.signedIn
          ? `"${provider}" is now signed in.`
          : `"${provider}" is still not signed in.${settled.output ? `\n${settled.output}` : ''}`
      },
    },
  ]
}

/** Merge configured routes over the built-in defaults. */
function normalizeConfig(raw) {
  const defaults = defaultRoutes()
  const config = raw && typeof raw === 'object' ? raw : {}
  const providers = {}
  const configured = config.providers && typeof config.providers === 'object' ? config.providers : {}
  const codexModelsCache =
    typeof config.codexModelsCache === 'string' && config.codexModelsCache.length > 0
      ? config.codexModelsCache
      : profilePath('.codex', 'models_cache.json')
  for (const [id, base] of Object.entries(defaults)) {
    const override = configured[id]
    if (override === false || override?.enabled === false) continue
    const merged = { ...base, ...(override && typeof override === 'object' ? override : {}) }
    merged.bin = resolveBin(override?.bin ?? base.bin)
    // A profile may set the `opencode stats` invocation once, globally.
    if (id === 'opencode' && Array.isArray(config.opencodeStats?.args) && merged.statsArgs === undefined) {
      merged.statsArgs = config.opencodeStats.args
    }
    // Codex's model catalog lives in its own cache file, not in a CLI command.
    if (id === 'codex' && !Array.isArray(merged.models)) {
      merged.readModels = () => readCodexModelList(merged.modelsCacheFile ?? codexModelsCache)
    }
    providers[id] = merged
  }
  return {
    cwd: typeof config.cwd === 'string' && config.cwd.length > 0 ? config.cwd : process.cwd(),
    timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    usageFile:
      typeof config.usageFile === 'string' && config.usageFile.length > 0
        ? config.usageFile
        : profilePath('.dsh', 'llm-cli-usage.json'),
    includeSystemPrompt: config.includeSystemPrompt === true,
    plan: config.plan && typeof config.plan === 'object' ? config.plan : {},
    grokUsageDir:
      typeof config.grokUsageDir === 'string' && config.grokUsageDir.length > 0
        ? config.grokUsageDir
        : profilePath('.grok', 'sessions'),
    codexUsageDir:
      typeof config.codexUsageDir === 'string' && config.codexUsageDir.length > 0
        ? config.codexUsageDir
        : profilePath('.codex', 'sessions'),
    codexModelsCache:
      typeof config.codexModelsCache === 'string' && config.codexModelsCache.length > 0
        ? config.codexModelsCache
        : profilePath('.codex', 'models_cache.json'),
    providers,
  }
}

/** Register one adapter for every enabled route, the sign-in tools and the dashboard. */
export function apply(ctx, config) {
  const normalized = normalizeConfig(config)
  const routeNames = Object.keys(normalized.providers)
  if (routeNames.length === 0) {
    ctx.logger?.warn?.('llm-cli: no provider routes enabled')
    return
  }
  const manager = new SignInManager(normalized)
  const ledger = new UsageLedger(normalized.usageFile)
  const adapter = new CliAdapter(ctx, normalized, manager, ledger)
  ctx.llm.registerAdapter(routeNames, adapter)

  // `tools` is optional: the route still works where the harness exposes no
  // tool surface, only the sign-in tools are unavailable there.
  ctx.inject(['tools'], (child) => {
    const tools = buildTools(manager)
    for (const tool of tools) child.tools.register(tool)
    ctx.logger?.info?.(`llm-cli: registered sign-in tools ${tools.map((tool) => tool.name).join(', ')}`)
  })

  // The dashboard rides the harness web server, so it answers on whatever
  // address the GUI already serves — no extra port or firewall rule.
  ctx.inject(['webServer'], (child) => {
    const disposers = [
      child.webServer.register({
        kind: 'exact',
        path: '/llm-cli/usage',
        handler: async (request, response) => {
          try {
            const payload = await describeRoutes(adapter, ledger, windowDaysFromUrl(request?.url))
            response.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            })
            response.end(renderUsageHtml(payload, Date.now(), payload.routes, payload.limitsNotice, payload.cliUsage, payload.plans))
          } catch (error) {
            response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            response.end(`llm-cli: could not build the usage view: ${String(error?.message ?? error)}`)
          }
        },
      }),
      child.webServer.register({
        kind: 'exact',
        path: '/llm-cli/usage.json',
        handler: async (request, response) => {
          try {
            const payload = await describeRoutes(adapter, ledger, windowDaysFromUrl(request?.url))
            response.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            response.end(JSON.stringify(payload))
          } catch (error) {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ error: String(error?.message ?? error) }))
          }
        },
      }),
    ]
    child.effect(() => () => {
      for (const dispose of disposers) dispose()
    })
    ctx.logger?.info?.(`llm-cli: usage dashboard at /llm-cli/usage (ledger ${normalized.usageFile ?? 'memory'})`)
  })

  ctx.logger?.info?.(
    `llm-cli: registered routes ${routeNames.join(', ')} (cwd ${normalized.cwd})`,
  )
}

export {
  buildTools,
  computePlans,
  describeRoutes,
  parseDeviceInfo,
  periodWindow,
  readGrokCliUsage,
  readGrokModelLimits,
  readCodexCliUsage,
  readCodexModelList,
  renderUsageHtml,
  SignInManager,
  toOpencodeCliUsage,
  UsageLedger,
  windowCliUsage,
  windowGrokUsage,
}
