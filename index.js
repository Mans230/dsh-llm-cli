/**
 * dsh-llm-cli — DeepSeek Harness LLM provider routes backed by agent CLIs.
 *
 * Routes:
 *   opencode  -> the OpenCode CLI  (`opencode run --model <m> --format json`)
 *   grok      -> the Grok Build CLI (`grok -p <prompt> -m <m> --output-format streaming-json`)
 *   codex     -> the OpenAI Codex app-server (streamed JSON-RPC over stdio)
 *
 * The CLI owns authentication and model access; this adapter only maps the
 * harness message/stream vocabulary onto one headless CLI turn. The CLI agent
 * runs in the session workspace. Text streams incrementally; offered harness
 * tools use a validated JSON relay, and attachments use CLI image transports.
 *
 * Every route is optional; a profile patch supplies `config.providers`.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
/** How long a device-code sign-in may wait for a human before it is closed. */
const DEFAULT_SIGN_IN_TTL_MS = 10 * 60 * 1000
/** A dashboard token shorter than this is not worth calling a secret. */
const MIN_DASHBOARD_TOKEN = 16
/** Where an update check reads the published version from. */
const UPDATE_SOURCE = 'https://raw.githubusercontent.com/Mans230/dsh-llm-cli/main/package.json'
/** A check result is reused this long, so a click cannot hammer the source. */
const UPDATE_TTL_MS = 10 * 60 * 1000
/** How long an install command may run before it is killed. */
const UPDATE_TIMEOUT_MS = 3 * 60 * 1000
/** How often an auto-updating install looks for a new version. */
const DEFAULT_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

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
      modelInfoArgs: ['api', 'GET', '/api/model'],
      contextWindowCap: 500000,
      preserveFreeContext: true,
      defaultModel: 'opencode/deepseek-v4.1-flash-free',
      parseList: parseOpencodeList,
      parseLine: parseOpencodeLine,
      buildArgs: (model, prompt, promptFile, execution = {}) =>
        execution.images?.length
          ? ['run', '--model', model, '--format', 'json', '--file', execution.images[0], promptFile ? `Read the full transcript at ${promptFile} and answer its last user turn.` : prompt]
          : promptFile
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
      imageTransport: 'acp',
      buildArgs: (model, prompt, promptFile, execution = {}) =>
        execution.images?.length
          ? ['agent', '-m', model, 'stdio']
          : promptFile
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
      buildArgs: (model, prompt, promptFile, execution = {}) => {
        const args = promptFile
          ? [
              'exec',
              '--json',
              '--skip-git-repo-check',
              '--color',
              'never',
              '-s',
              execution.sandbox ?? 'read-only',
              '-m',
              model,
              `The attached file is the full conversation transcript. Read it (${promptFile}) and reply with your next message only, with no commentary about the file.`,
            ]
          : ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-s', execution.sandbox ?? 'read-only', '-m', model, prompt]
        args.splice(1, 0, ...(execution.images ?? []).flatMap((file) => ['--image', file]))
        return args
      },
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
    note: '',
    mix: tokenMix({}, { cacheInInput: false }),
    capabilities: capabilities ?? { cost: false, rateLimits: false, perStep: false },
  }
}

/**
 * Split a view's counters into slices that add up to its total. The CLIs
 * disagree about where cache reads live: OpenCode counts them beside input,
 * Grok and Codex count them inside it. Reasoning is reported separately by all
 * three and is never a slice, so the parts always sum to the whole.
 */
function tokenMix(usage, { cacheInInput }) {
  const cache = toCount(usage?.cacheReadTokens)
  const input = Math.max(0, toCount(usage?.inputTokens) - (cacheInInput ? cache : 0))
  const output = toCount(usage?.outputTokens)
  return {
    total: input + output + cache,
    slices: [
      { key: 'input', label: 'Input', value: input },
      { key: 'output', label: 'Output', value: output },
      { key: 'cache', label: 'Cache read', value: cache },
    ],
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

/**
 * Turn a Grok `usage.json` session block into the accumulator shape. The file
 * counts cached input inside `inputTokens`, and a per-model block has no total
 * of its own, so the total is derived from the counters.
 */
function grokSessionUsage(block) {
  const usage = {
    inputTokens: toCount(block.inputTokens),
    outputTokens: toCount(block.outputTokens),
    cacheReadTokens: toCount(block.cachedReadTokens),
    cacheWriteTokens: toCount(block.cacheCreationTokens),
    reasoningTokens: toCount(block.reasoningTokens),
    modelCalls: toCount(block.modelCalls),
    costUsd: finiteOr(block.costUsdTicks, 0) / TICKS_PER_USD,
  }
  usage.totalTokens = tokenMix(usage, { cacheInInput: true }).total
  return usage
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
  // The session file counts cached input inside inputTokens.
  const mix = tokenMix(totals, { cacheInInput: true })
  return {
    ...empty,
    available,
    ...totals,
    totalTokens: mix.total,
    mix,
    sessions,
    sessionCount,
    models,
    daily,
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
  // Both windowed views embed cache reads in input, and a window must not keep
  // the unwindowed mix from `full`.
  const mix = tokenMix(totals, { cacheInInput: true })
  return {
    ...full,
    available: sessions.length > 0,
    ...totals,
    totalTokens: mix.total,
    mix,
    sessions,
    sessionCount: sessions.length,
    totalSessions: full.sessionCount ?? 0,
    models,
    daily,
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
  const value = { sessionId: '', model: '', endedAt: 0, sessionTotals: null, rate: null, rateAt: 0, contextWindow: undefined, days: [] }
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
      if (payload.rate_limits && typeof payload.rate_limits === 'object') {
        value.rate = payload.rate_limits
        value.rateAt = at
      }
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
    limitsObservedAt: { primary: null, secondary: null },
    limitsStale: { primary: true, secondary: true },
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
  const limitsObservedAt = { primary: null, secondary: null }
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
    const { sessionId, model, endedAt, sessionTotals, rate, rateAt } = parsed
    // Quota-only events are useful even before a session records token totals.
    if (rate && rateAt >= bestLimitsAt) {
      const primary = normalizeCodexLimit(rate.primary, rateAt)
      const secondary = normalizeCodexLimit(rate.secondary, rateAt)
      if (primary || secondary) {
        bestLimitsAt = rateAt
        limits = { primary: primary ?? limits.primary, secondary: secondary ?? limits.secondary }
        if (primary) limitsObservedAt.primary = rateAt
        if (secondary) limitsObservedAt.secondary = rateAt
      }
    }
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
  }

  sessions.sort((left, right) => right.endedAt - left.endedAt)
  const models = [...byModel.values()].sort((left, right) => right.totalTokens - left.totalTokens)
  const daily = [...byDay.values()].sort((left, right) => (left.date < right.date ? -1 : 1))
  // Codex counts cached input inside input_tokens.
  const mix = tokenMix(totals, { cacheInInput: true })
  return {
    ...empty,
    available: sessions.length > 0,
    ...totals,
    totalTokens: mix.total,
    mix,
    sessions,
    sessionCount: sessions.length,
    models,
    daily,
    limits,
    limitsObservedAt,
    limitsStale: Object.fromEntries(['primary', 'secondary'].map((key) => [key,
      !limitsObservedAt[key] || Date.now() - limitsObservedAt[key] > 5 * 60000 ||
      (limits[key]?.resetsAt > 0 && limits[key].resetsAt <= Date.now()),
    ])),
    contextWindow: lastContextWindow,
    note: sessions.length === 0 ? 'no codex turns recorded yet' : '',
    capabilities: { ...empty.capabilities, cost: false },
  }
}

/** Map `opencode stats --json` output onto the dashboard vocabulary. */
function toOpencodeCliUsage(stats, args, scopeDays) {
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
  const mix = tokenMix(
    {
      inputTokens: toCount(tokens.input),
      outputTokens: toCount(tokens.output),
      cacheReadTokens: toCount(tokens.cache?.read),
    },
    { cacheInInput: false },
  )
  return {
    available: true,
    source: `opencode ${args.join(' ')}`,
    args,
    // `opencode stats --days` takes whole days, so a sub-day window is served
    // at the smallest scope it can offer. The caller reports the difference.
    scopeDays: scopeDays ?? 0,
    from: finiteOr(stats?.range?.from, 0),
    to: finiteOr(stats?.range?.to, 0),
    sessions: toCount(stats?.sessions),
    prompts: toCount(stats?.prompts),
    steps: toCount(stats?.steps),
    inputTokens: toCount(tokens.input),
    outputTokens: toCount(tokens.output),
    cacheReadTokens: toCount(tokens.cache?.read),
    cacheWriteTokens: toCount(tokens.cache?.write),
    reasoningTokens: toCount(tokens.reasoning),
    totalTokens: mix.total,
    mix,
    costUsd: finiteOr(stats?.cost, 0),
    activeDays: toCount(stats?.activeDays),
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

async function readOpencodeCliUsage(route, cwd, timeoutMs, argsOverride, scopeDays) {
  const args = argsOverride ?? route.statsArgs ?? ['stats', '--json', '--all', '--models', '--cost']
  const { code, stdout, stderr } = await runCapture(route, args, { cwd, timeoutMs })
  const text = stdout.trim()
  if (code !== 0) {
    throw new Error((stderr || text).trim().slice(0, 300) || `opencode stats exited ${code}`)
  }
  if (text.length === 0) {
    throw new Error(`${(stderr || '').trim().slice(0, 300) || `opencode ${args.join(' ')} exited ${code}`}`)
  }
  const stats = JSON.parse(text)
  if (!stats?.tokens || !Number.isFinite(stats.tokens.input) || !Number.isFinite(stats.tokens.output)) {
    throw new Error('opencode stats returned no token counters')
  }
  return toOpencodeCliUsage(stats, args, scopeDays)
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
          const period = await readOpencodeCliUsage(
            route,
            adapter.config.cwd,
            30000,
            ['stats', '--json', '--days', String(days), '--models', '--cost'],
            days,
          )
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
    // Forward harness instructions unless the profile explicitly opts out.
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
        out.push(`[tool call ${block.id ?? ''} ${block.name ?? ''}(${block.arguments ?? ''})]`)
        break
      case 'tool-result':
        out.push(`[tool result ${block.toolCallId ?? ''}${block.isError ? ' (error)' : ''}]\n${contentToText(block.content)}`)
        break
      case 'image':
        out.push('[image supplied separately with this request]')
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

const TOOL_BRIDGE_PREFIX = 'DSH_TOOL_CALLS '

function toolBridgePrompt(tools) {
  return `\n\nDSH tools available for this turn (JSON schemas):\n${JSON.stringify(tools)}\n` +
    `To request one or more of THESE tools, return ONLY ${TOOL_BRIDGE_PREFIX}` +
    '[{"name":"exact tool name","arguments":{}}] with valid JSON double quotes. ' +
    'The host executes the tools under its own permission rules and returns correlated tool results on the next turn. ' +
    'Do not claim a tool was executed before its result arrives. For a normal answer, write normal text without this prefix.'
}

function bridgeCalls(text, tools) {
  if (!text.startsWith(TOOL_BRIDGE_PREFIX)) return []
  const calls = JSON.parse(text.slice(TOOL_BRIDGE_PREFIX.length))
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 16) throw new Error('expected 1 to 16 tool requests')
  const names = new Set(tools.map((tool) => tool.name))
  return calls.map((call) => {
    if (!names.has(call?.name)) throw new Error('the requested tool was not offered for this turn')
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new Error('tool arguments must be a JSON object')
    return { type: 'tool-call', id: randomUUID(), name: call.name, arguments: JSON.stringify(call.arguments) }
  })
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
    const mapped = codexUsage(usage)
    // The harness requires disjoint input/cache counters. Keep rollout readers
    // in Codex's native accounting; only the streaming boundary subtracts cache.
    return { usage: { ...mapped, inputTokens: Math.max(0, mapped.inputTokens - mapped.cacheReadTokens) } }
  }
  return null
}

/** Adapt app-server notifications to the same chunks as other CLI routes. */
function parseCodexServerPacket(packet) {
  const params = packet?.params ?? {}
  if (packet?.method === 'item/agentMessage/delta') return { text: params.delta }
  if (packet?.method === 'item/reasoning/summaryTextDelta') return { reasoning: params.delta }
  if (packet?.method === 'thread/tokenUsage/updated') {
    const u = params.tokenUsage?.total
    if (!u) return null
    const mapped = codexUsage({ input_tokens: u.inputTokens, output_tokens: u.outputTokens,
      cached_input_tokens: u.cachedInputTokens, reasoning_output_tokens: u.reasoningOutputTokens, total_tokens: u.totalTokens })
    return { usage: { ...mapped, inputTokens: Math.max(0, mapped.inputTokens - mapped.cacheReadTokens) } }
  }
  return null
}

/** A bounded, quota-only RPC: never starts an inference turn or reads credentials. */
async function readLiveCodexLimits(route, cwd) {
  const child = spawnCommand(route, route.appServerArgs ?? ['app-server', '--listen', 'stdio://'],
    { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  child.stderr.resume()
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const send = packet => child.stdin.write(JSON.stringify(packet) + '\n')
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reader.close()
      child.kill()
      error ? reject(error) : resolve(result)
    }
    const timer = setTimeout(() => finish(new Error('Codex live quota request timed out')), 8000)
    child.on('error', error => finish(error))
    child.on('close', () => finish(new Error('Codex exited before returning live quota')))
    reader.on('line', line => {
      let packet
      try { packet = JSON.parse(line) } catch { return }
      if (packet.error) return finish(new Error(packet.error.message ?? 'Codex quota request failed'))
      if (packet.id === 1) {
        send({ method: 'initialized' })
        send({ id: 2, method: 'account/rateLimits/read' })
      }
      if (packet.id === 2) {
        const limits = packet.result?.rateLimitsByLimitId?.codex ?? packet.result?.rateLimits
        if (!limits || (!limits.primary && !limits.secondary)) return finish(new Error('Codex returned no account quota windows'))
        finish(null, limits)
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dsh_llm_cli', version: currentVersion() } } })
  })
}

/** Preserve native counters; the stream boundary subtracts cached input. */
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

/**
 * A route carries the executable and any arguments that must come before the
 * real ones. A Windows shim resolved to a node script needs `node <script>`
 * ahead of the CLI arguments.
 */
function spawnCommand(route, args, options) {
  const bin = typeof route === 'string' ? route : route?.bin
  const prefix = typeof route === 'string' ? [] : route?.binArgs ?? []
  return spawn(bin, [...prefix, ...args], options)
}

/** The message to show when a route's executable cannot be launched at all. */
function launchErrorFor(route) {
  if (!route?.launchError) return null
  return `llm-cli: ${route.launchError}`
}

/** Spawn one CLI process and collect its stdout/stderr to completion. */
function runCapture(route, args, { cwd, timeoutMs, env = process.env, signal }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnCommand(route, args, { cwd, windowsHide: true, env, signal, stdio: ['ignore', 'pipe', 'pipe'] })
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

/**
 * A PATH entry can arrive POSIX-shaped when the harness was launched from a
 * shell that rewrites PATH (git-bash, WSL interop). Native lookup needs a
 * Windows path, so translate those entries instead of failing every probe.
 */
function windowsPathEntry(dir) {
  const wsl = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(dir)
  if (wsl) return `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}`
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(dir)
  if (msys) return `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, '\\')}`
  return dir
}

/**
 * Find a bare command on PATH the way a shell would, including the `.cmd` shims
 * npm installs. Node's own spawn lookup only finds executables, so without this
 * a globally installed CLI that ships nothing but a shim is invisible.
 */
function findOnPath(name) {
  if (process.platform !== 'win32') return null
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(windowsPathEntry(dir), `${name}${extension.toLowerCase()}`)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return null
}

/**
 * Node cannot spawn a `.cmd` or `.bat` without a shell, and a shell would put
 * the prompt on a command line where `&` and `|` mean something. The shim is a
 * text file that names its real target, so read it and launch that instead.
 *
 * npm's own shim assigns a variable first (`SET "NODE_EXE=%~dp0\node.exe"`) and
 * runs the script last, so every quoted candidate is collected: assignments are
 * skipped, a script wins over an executable, and the first target that exists is
 * used. Returns null when nothing resolves, and the caller then explains itself
 * rather than falling back to a shell.
 */
function resolveWindowsShim(bin) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { bin, prefix: [] }
  let text
  try {
    text = readFileSync(bin, 'utf8')
  } catch {
    return null
  }
  // Two kinds of quoted target: one the shim runs directly, and one it assigns
  // to a variable first. npm uses the second form for both its node and its
  // script, so an assigned target is used when there is no direct one.
  const direct = []
  const assigned = []
  for (const match of text.matchAll(/"([^"\r\n]+)"/g)) {
    const quoted = match[1]
    const isAssignment = quoted.includes('=')
    const value = (isAssignment ? quoted.slice(quoted.indexOf('=') + 1) : quoted).trim()
    if (!/\.(exe|js|mjs|cjs)$/i.test(value)) continue
    const relative = value.replace(/%~dp0\\?/gi, '').replace(/%dp0%\\?/gi, '').replace(/%[^%]*%/g, '')
    if (!relative || relative.includes('%')) continue
    const target = isAbsolute(relative) ? relative : join(dirname(bin), relative)
    try {
      if (existsSync(target)) (isAssignment ? assigned : direct).push(target)
    } catch {
      /* skip an entry the filesystem will not answer for */
    }
  }
  // A shim hands off on its last line, so the last matching target wins. npm
  // assigns a prefix helper before its real entry, and the later assignment is
  // the one it runs.
  const pick = (list, pattern) => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (pattern.test(list[index])) return list[index]
    }
    return undefined
  }
  const target =
    pick(direct, /\.(js|mjs|cjs)$/i) ??
    pick(direct, /\.exe$/i) ??
    pick(assigned, /\.(js|mjs|cjs)$/i) ??
    pick(assigned, /\.exe$/i)
  if (!target) return null
  return /\.exe$/i.test(target) ? { bin: target, prefix: [] } : { bin: process.execPath, prefix: [target] }
}

/** The first candidate that exists on disk, else the bare command name. */
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
    return findOnPath(candidate) ?? candidate
  }
  return list.pop()
}

/** One CLI-backed adapter serving every configured route. */
class CliAdapter {
  constructor(ctx, config, signIn, ledger) {
    this.ctx = ctx
    this.config = config
    this.signIn = signIn
    this.setup = signIn?.setup
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

  async loadOpencodeModelInfo() {
    const route = this.config.providers.opencode
    if (!route || route.modelInfoArgs === false) return
    if (this.opencodeModelInfo && Date.now() - this.opencodeModelInfo.at < LIST_TTL_MS) return
    const byModel = {}
    try {
      const { code, stdout } = await runCapture(route, route.modelInfoArgs, { cwd: this.config.cwd, timeoutMs: 30000 })
      if (code === 0) {
        const payload = JSON.parse(stdout)
        for (const entry of (Array.isArray(payload) ? payload : payload.data ?? [])) {
          if (typeof entry.id !== 'string' || typeof entry.providerID !== 'string') continue
          byModel[`${entry.providerID}/${entry.id}`] = {
            contextWindow: firstNumber(entry.limit?.context),
            maxOutputTokens: firstNumber(entry.limit?.output),
            name: entry.name,
          }
        }
      }
    } catch { /* Older CLIs without the catalog API retain the labelled fallback. */ }
    this.opencodeModelInfo = { at: Date.now(), byModel }
  }

  /** The CLI route keeps the harness default retry policy. */
  providerRetryPolicy() {
    return undefined
  }

  /** The CLIs expose no separate image-price estimate to the harness. */
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
    if (provider === 'opencode') await this.loadOpencodeModelInfo()
    const configured = modelEntries(route.models)
    if (configured.length > 0) {
      return configured.map((entry) => ({ provider, id: entry.id, name: entry.name ?? entry.id }))
    }
    const cached = this.listCache.get(provider)
    if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.models
    let ids = []
    if (typeof route.readModels === 'function') {
      try {
        ids = route.readModels()
      } catch (error) {
        this.ctx.logger?.warn?.(`llm-cli: could not read the model list for route "${provider}"`)
      }
    } else {
      try {
        const { stdout } = await runCapture(route, route.listArgs ?? [], {
          cwd: this.config.cwd,
          timeoutMs: 30000,
        })
        ids = route.parseList ? route.parseList(stdout) : []
      } catch (error) {
        this.ctx.logger?.warn?.(`llm-cli: could not list models for route "${provider}"`)
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
    // A profile may state one model's limits where its CLI publishes none
    // (OpenCode prints ids only). A configured entry wins over every probe.
    const configured = modelEntries(route?.models).find((entry) => entry.id === model)
    const configuredContext = configured?.contextWindow
    const configuredMax = configured?.maxOutputTokens
    const maxField = configuredMax === undefined ? {} : { maxOutputTokens: configuredMax }
    if (provider === 'opencode') {
      const native = this.opencodeModelInfo?.byModel?.[model]
      const nativeContext = native?.contextWindow > 0 ? native.contextWindow : undefined
      const cap = route?.contextWindowCap > 0 ? route.contextWindowCap : undefined
      const preserveFree = route?.preserveFreeContext !== false && /(?:^|[-/])free$/.test(model) && nativeContext >= 1000000
      const contextWindow = configuredContext ?? route?.contextWindow ??
        (nativeContext ? (cap && !preserveFree ? Math.min(cap, nativeContext) : nativeContext) : DEFAULT_CONTEXT_WINDOW)
      return {
        contextWindow,
        maxOutputTokens: configuredMax ?? (native?.maxOutputTokens > 0 ? native.maxOutputTokens : undefined),
        source: configuredContext !== undefined ? 'configured for this model'
          : route?.contextWindow ? 'configured for this route'
            : nativeContext ? `opencode model catalog${contextWindow < nativeContext ? ' (configured context cap)' : ''}`
              : 'harness default: OpenCode model catalog unavailable',
      }
    }
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
      const contextWindow =
        configuredContext ?? this.codexLimitsCache.contextWindow ?? route?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
      return {
        contextWindow,
        ...maxField,
        source:
          configuredContext !== undefined
            ? 'configured for this model'
            : this.codexLimitsCache.contextWindow
              ? 'from the codex session rollouts'
              : 'harness default: Codex has not recorded a context window yet',
      }
    }
    if (provider !== 'grok') {
      return {
        contextWindow: configuredContext ?? route?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        ...maxField,
        source:
          configuredContext !== undefined
            ? 'configured for this model'
            : `harness default: the ${route?.displayName ?? provider} CLI publishes no model limits`,
      }
    }
    const now = Date.now()
    if (!this.limitsCache || now - this.limitsCache.at > LIMITS_TTL_MS) {
      this.limitsCache = { at: now, byModel: readGrokModelLimits() }
    }
    const byModel = this.limitsCache.byModel
    const found = byModel[model]
    if (found) {
      return configuredContext === undefined
        ? { ...found, ...maxField }
        : { ...found, contextWindow: configuredContext, ...maxField, source: 'configured for this model' }
    }
    return {
      contextWindow: configuredContext ?? route?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      ...maxField,
      source:
        configuredContext !== undefined
          ? 'configured for this model'
          : Object.keys(byModel).length === 0
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
    await this.loadOpencodeModelInfo()
    for (const [id, route] of Object.entries(this.config.providers)) {
      let signedIn = null
      if (this.signIn) {
        try {
          signedIn = (await this.signIn.status(id)).signedIn
        } catch {
          /* a probe that fails leaves the sign-in state unknown */
        }
      }
      const configured = modelEntries(route.models)
      let models = configured.map((entry) => entry.id)
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
  invalidateCaches() {
    rolloutCache.clear()
    this.cliUsageCache.clear()
    this.routeFactsCache = undefined
    this.codexLimitsCache = undefined
    this.limitsCache = undefined
    this.listCache.clear()
    this.opencodeModelInfo = undefined
  }

  async cliUsage(days = 0, { force = false } = {}) {
    if (force) this.invalidateCaches()
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
    const codexRoute = this.config.providers.codex
    if (fullCodex && codexRoute?.liveQuota) {
      try {
        const live = await readLiveCodexLimits(codexRoute, this.config.cwd)
        const observedAt = Date.now()
        fullCodex.limits = {}
        fullCodex.limitsObservedAt = {}
        fullCodex.limitsStale = {}
        for (const key of ['primary', 'secondary']) {
          const window = live[key]
          fullCodex.limits[key] = window ? { usedPercent: window.usedPercent, windowMinutes: window.windowDurationMins, resetsAt: window.resetsAt * 1000 } : null
          fullCodex.limitsObservedAt[key] = window ? observedAt : null
          fullCodex.limitsStale[key] = false
        }
        fullCodex.limitsSource = 'live'
      } catch (error) {
        fullCodex.limitsSource = 'recorded'
        fullCodex.liveQuotaError = String(error.message).slice(0, 300)
      }
    }
    if (this.config.providers.opencode) {
      try {
        value.opencode = await readOpencodeCliUsage(
          this.config.providers.opencode,
          this.config.cwd,
          30000,
          daysArg,
          windowDays > 0 ? Math.max(1, Math.ceil(windowDays)) : 0,
        )
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
    if (provider === 'opencode') await this.loadOpencodeModelInfo()
    const route = this.config.providers[provider]
    const limits = this.limitsFor(provider, model)
    return {
      provider,
      id: model,
      name: modelEntries(route?.models).find((entry) => entry.id === model)?.name ?? model,
      context: {
        contextWindow: limits.contextWindow ?? route?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      },
    }
  }

  async resolveTurnCwd(options) {
    if (typeof this.config.resolveCwd === 'function') return this.config.resolveCwd(options)
    if (options.sessionId) {
      const session = (this.sessions ?? this.ctx.sessions)?.get(options.sessionId)
      if (!session?.header?.cwd) throw new Error('llm-cli: the session workspace is unavailable; no global-directory fallback was used')
      return session.header.cwd
    }
    return this.config.providers[options.provider]?.cwd ?? this.config.cwd
  }

  async *stream(options) {
    const provider = options.provider
    const route = this.config.providers[provider]
    if (!route) throw new Error(`llm-cli: unknown provider route "${provider}"`)
    const turnStartedAt = Date.now()
    if (options.signal?.aborted) {
      this.recordFailure(provider, options.model, turnStartedAt, 'the request was aborted')
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was aborted', code: 'ABORTED' } } }
      return
    }
    let cwd
    try { cwd = await this.resolveTurnCwd(options) } catch (error) {
      this.recordFailure(provider, options.model, turnStartedAt, error.message)
      throw error
    }
    if (options.signal?.aborted) {
      this.recordFailure(provider, options.model, turnStartedAt, 'the request was aborted')
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was aborted', code: 'ABORTED' } } }
      return
    }

    // A missing cwd makes spawn fail with an ENOENT that names the binary, so
    // the turn looks like a missing CLI instead of a bad config path.
    let cwdIsDirectory = false
    try {
      cwdIsDirectory = typeof cwd === 'string' && isAbsolute(cwd) && statSync(cwd).isDirectory()
    } catch {
      cwdIsDirectory = false
    }
    if (!cwdIsDirectory) {
      const message = `llm-cli: the configured cwd is not a directory: ${cwd}`
      this.recordFailure(provider, options.model, turnStartedAt, message)
      throw new Error(message)
    }

    try { await this.setup?.ensure(provider) } catch (error) {
      this.recordFailure(provider, options.model, turnStartedAt, error.message)
      throw error
    }
    if (options.signal?.aborted) {
      this.recordFailure(provider, options.model, turnStartedAt, 'the request was aborted')
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was aborted', code: 'ABORTED' } } }
      return
    }
    const launchError = launchErrorFor(route)
    if (launchError) {
      this.recordFailure(provider, options.model, turnStartedAt, launchError)
      throw new Error(launchError)
    }

    const offeredTools = this.config.toolBridge === 'json' && Array.isArray(options.tools) ? options.tools : []
    const bridgeEnabled = offeredTools.length > 0
    let promptFile
    let promptDir
    let child
    let acpPrompt
    let codexInput
    const removePromptDir = () => { if (promptDir) { try { rmSync(promptDir, { recursive: true, force: true }) } catch { /* best effort */ } } }
    try {
      const prompt = buildPrompt(options, this.config.includeSystemPrompt === true) + (bridgeEnabled ? toolBridgePrompt(offeredTools) : '')
      const blocks = (options.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block?.type === 'image') : [])
      if (blocks.length > 8 || (provider === 'opencode' && blocks.length > 1)) throw new Error('llm-cli: this route supports at most ' + (provider === 'opencode' ? 'one image' : '8 images') + ' per request')
      const images = []
      const imageContent = []
      for (const block of blocks) {
        const store = this.attachments ?? this.ctx.attachments
        if (!store?.readImage || !block.attachment) throw new Error('llm-cli: image bytes require the DSH attachment service; the image was not replaced by text')
        const stored = await store.readImage(block.attachment)
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[stored?.ref?.mediaType]
        if (!extension || !(stored.data instanceof Uint8Array) || stored.data.length > 20 * 1024 * 1024) throw new Error('llm-cli: unsupported or oversized image attachment')
        promptDir ??= mkdtempSync(join(tmpdir(), 'dsh-llm-cli-'))
        const file = join(promptDir, `image-${images.length}.${extension}`)
        writeFileSync(file, stored.data, { mode: 0o600 })
        images.push(file)
        imageContent.push({ type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType })
      }
      if (prompt.length > ARG_PROMPT_LIMIT || route.promptMode === 'file') {
        promptDir ??= mkdtempSync(join(tmpdir(), 'dsh-llm-cli-'))
        promptFile = join(promptDir, 'prompt.txt')
        writeFileSync(promptFile, prompt, { mode: 0o600 })
      }
      options.signal?.throwIfAborted()
      if (provider === 'grok' && images.length && route.imageTransport === 'acp') acpPrompt = [{ type: 'text', text: prompt }, ...imageContent]
      if (provider === 'codex' && route.appServer) codexInput = [{ type: 'text', text: prompt }, ...images.map(path => ({ type: 'localImage', path }))]
      const args = codexInput ? (route.appServerArgs ?? ['app-server', '--listen', 'stdio://']) : route.buildArgs(options.model, prompt, promptFile, { cwd, sandbox: route.sandbox, images })
      child = spawnCommand(route, args, {
        cwd, windowsHide: true, env: process.env,
        stdio: [acpPrompt || codexInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
      child.stdin?.on('error', () => {})
    } catch (error) {
      removePromptDir()
      this.recordFailure(provider, options.model, turnStartedAt, error.message)
      throw error
    }

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

    const timeoutMs = Number.isFinite(route.timeoutMs) && route.timeoutMs > 0
      ? route.timeoutMs
      : this.config.timeoutMs
    let timedOut = false
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill() }, timeoutMs) : undefined

    const finishCleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (child.exitCode === null) child.kill()
      removePromptDir()
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
    let codexCompleted = false
    let codexTurnStarted = false
    let codexThreadId
    let codexTurnId
    const codexTextItems = new Set()
    let acpCompleted = false
    let acpStopReason

    try {
      const closed = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }))
        child.on('error', (error) => resolve({ code: null, signal: null, error }))
      })

      const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
      const send = (packet) => child.stdin?.write(JSON.stringify(packet) + '\n')
      if (codexInput) send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dsh_llm_cli', version: currentVersion() } } })
      if (acpPrompt) send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-llm-cli', version: currentVersion() } } })
      for await (const line of reader) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        stdout += `${line}\n`
        let codexParsed
        if (codexInput) {
          let packet
          try { packet = JSON.parse(trimmed) } catch { continue }
          if (packet?.error) { cliError = packet.error.message ?? 'Codex app-server request failed'; child.kill() }
          else if (packet?.id === 1) {
            send({ method: 'initialized' })
            send({ id: 2, method: 'thread/start', params: { model: options.model, cwd, sandbox: route.sandbox ?? 'read-only', approvalPolicy: 'never', ephemeral: true } })
          } else if (packet?.id === 2) {
            codexThreadId = packet.result?.thread?.id
            if (!codexThreadId) { cliError = 'Codex returned no thread id'; child.kill() }
            else send({ id: 3, method: 'turn/start', params: { threadId: codexThreadId, input: codexInput } })
          } else if (packet?.id === 3) {
            codexTurnId = packet.result?.turn?.id
            codexTurnStarted = !!codexTurnId
          } else if (packet?.method === 'turn/started') {
            codexTurnId = packet.params?.turn?.id
            codexTurnStarted = !!codexTurnId
          } else if (packet?.method === 'turn/completed') {
            const turn = packet.params?.turn
            if (turn?.status === 'completed' && codexTurnStarted && turn.id === codexTurnId) codexCompleted = true
            else cliError = turn?.error?.message ?? 'Codex turn did not complete successfully'
            child.kill()
          } else if (packet?.method && packet.id !== undefined) {
            send({ id: packet.id, error: { code: -32601, message: 'Client request not supported; approvals are disabled' } })
          }
          codexParsed = parseCodexServerPacket(packet)
          if (packet?.method === 'item/agentMessage/delta') codexTextItems.add(packet.params?.itemId)
          if (packet?.method === 'item/completed' && packet.params?.item?.type === 'agentMessage' && !codexTextItems.has(packet.params.item.id)) {
            codexTextItems.add(packet.params.item.id)
            codexParsed = { text: packet.params.item.text }
          }
        }
        if (acpPrompt) {
          let packet
          try { packet = JSON.parse(trimmed) } catch { /* parser below handles non-JSON */ }
          if (packet?.error) { cliError = packet.error.message ?? 'Grok ACP request failed'; child.kill() }
          else if (packet?.id === 1 && packet.result) send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } })
          else if (packet?.id === 2 && packet.result) {
            if (!packet.result.sessionId) { cliError = 'Grok ACP returned no session id'; child.kill() }
            else send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: packet.result.sessionId, prompt: acpPrompt } })
          } else if (packet?.id === 3 && packet.result) {
            acpStopReason = packet.result.stopReason
            if (acpStopReason === 'cancelled') cliError = 'Grok ACP turn was cancelled'
            else acpCompleted = true
            child.kill()
          }
          else if (packet?.method && packet.id !== undefined) {
            send(packet.method === 'session/request_permission'
              ? { jsonrpc: '2.0', id: packet.id, result: { outcome: { outcome: 'cancelled' } } }
              : { jsonrpc: '2.0', id: packet.id, error: { code: -32601, message: 'Client method not supported' } })
          }
        }
        const parsed = codexInput ? codexParsed : route.parseLine ? route.parseLine(trimmed) : null
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
          text += parsed.text
          if (bridgeEnabled && (TOOL_BRIDGE_PREFIX.startsWith(text) || text.startsWith(TOOL_BRIDGE_PREFIX))) continue
          const delta = started ? parsed.text : text
          if (textIndex < 0) {
            textIndex = nextIndex
            nextIndex += 1
            started = true
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          yield { type: 'text-delta', index: textIndex, text: delta }
        }
      }

      const exit = await closed
      if (codexCompleted && !cliError) exit.code = 0
      if (codexInput && !codexCompleted && !cliError && !aborted && !timedOut) cliError = 'Codex app-server exited before completing the turn'
      if (acpCompleted && !cliError) exit.code = 0
      if (acpPrompt && !acpCompleted && !cliError && !aborted && !timedOut) cliError = 'Grok ACP exited before completing the prompt'

      if (aborted) {
        this.recordFailure(provider, options.model, turnStartedAt, 'the request was aborted')
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

      if (cliError || (text.length > 0 && exit?.code !== 0)) {
        const detail = cliError || stderr.trim().slice(0, 500) || 'the CLI did not complete'
        const message = `llm-cli: "${route.displayName}" failed (exit ${exit?.code ?? 'null'}): ${detail}`
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

      let calls = []
      try { if (bridgeEnabled) calls = bridgeCalls(text, offeredTools) } catch (error) {
        const message = `llm-cli: invalid DSH tool request: ${error.message}`
        this.recordFailure(provider, options.model, turnStartedAt, message)
        throw new Error(message)
      }
      if (calls.length) {
        for (const call of calls) {
          const index = nextIndex++
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
          yield { type: 'block-end', index, block: call }
        }
      } else {
        if (!started) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
          yield { type: 'text-delta', index: textIndex, text }
        }
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
      }
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
      yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : acpStopReason === 'max_tokens' ? 'max-tokens' : 'stop' } }
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
    loginArgs: ['auth', 'login', 'opencode', '--method', 'device'],
    statusArgs: ['auth', 'list'],
    signedIn: (out) => /\bstored\b|\boauth\b|\bapi[- ]key\b|\benv\b/i.test(out) && !/no (?:authenticated )?integrations|0 credentials|not authenticated/i.test(out),
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
  text = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const url = /https?:\/\/[^\s'"]+/.exec(text)?.[0]
  const fromUrl = url ? /user_code=([A-Za-z0-9._-]+)/.exec(url)?.[1] : undefined
  const code = fromUrl ?? /\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/.exec(text)?.[1]
  return { url, code }
}

/** Resolve executables without a shell, including a VM's own PATH. */
function executablePath(bin) {
  if (typeof bin !== 'string' || !bin) return null
  if (isAbsolute(bin) || /[/\\]/.test(bin)) return existsSync(bin) ? bin : null
  if (process.platform === 'win32') return findOnPath(bin)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const file = join(dir, bin)
    try { if (statSync(file).isFile()) return file } catch { /* next PATH entry */ }
  }
  return null
}

/** Installs only on the machine running this plugin, never through prompt text. */
class CliSetupManager {
  constructor(config) {
    this.config = config
    this.pending = new Map()
    this.errors = new Map()
    this.controller = new AbortController()
  }

  route(provider) {
    if (typeof provider !== 'string' || !Object.hasOwn(this.config.providers, provider) || !Object.hasOwn(LOGIN, provider)) throw new Error('llm-cli: unknown or disabled provider')
    const route = this.config.providers[provider]
    if (!route || !LOGIN[provider]) throw new Error(`llm-cli: unknown or disabled provider "${provider}"`)
    return route
  }

  target(provider) {
    const root = join(this.config.cliInstallDir, provider)
    return provider === 'grok' ? join(root, process.platform === 'win32' ? 'grok.exe' : 'grok')
      : join(root, 'node_modules', '.bin', provider + (process.platform === 'win32' ? '.cmd' : ''))
  }

  adopt(provider, file, prefix) {
    const route = this.route(provider)
    const launch = prefix ? { bin: file, prefix } : resolveWindowsShim(file)
    if (!launch || !executablePath(launch.bin) || launch.prefix.some(arg => /\.(?:m?js|cjs)$/.test(arg) && isAbsolute(arg) && !existsSync(arg))) return false
    route.bin = launch.bin
    route.binArgs = launch.prefix
    delete route.launchError
    return true
  }

  status(provider) {
    const route = this.route(provider)
    if (!executablePath(route.bin) && !route.binExplicit) this.adopt(provider, this.target(provider))
    return { installed: !route.launchError && !!executablePath(route.bin), installing: this.pending.has(provider), error: this.errors.get(provider) ?? '' }
  }

  async ensure(provider, { manual = false } = {}) {
    const route = this.route(provider)
    if (this.status(provider).installed) return this.status(provider)
    if (route.launchError && !route.installCommand) throw new Error(`llm-cli: ${route.launchError}`)
    if (!manual && this.config.autoInstall === false) throw new Error(`llm-cli: ${provider} is not installed; autoInstall is disabled`)
    if (route.binExplicit && !route.installCommand) throw new Error(`llm-cli: configured ${provider} binary is missing; fix providers.${provider}.bin or provide installCommand`)
    if (this.pending.has(provider)) return this.pending.get(provider)
    const job = this.install(provider).catch(error => { this.errors.set(provider, error.message); throw error }).finally(() => this.pending.delete(provider))
    this.pending.set(provider, job)
    return job
  }

  async install(provider) {
    const route = this.route(provider), root = join(this.config.cliInstallDir, provider)
    mkdirSync(root, { recursive: true })
    this.errors.delete(provider)
    let command = route.installCommand
    let scriptDir
    try {
      if (!command && provider !== 'grok') {
        const npm = executablePath('npm') ?? join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
        command = { bin: npm, args: ['install', '--prefix', root, '--no-audit', '--no-fund', '--package-lock=false', provider === 'codex' ? '@openai/codex' : '@opencode/cli'], binPath: this.target(provider) }
      } else if (!command) {
        const windows = process.platform === 'win32'
        const response = await fetch(`https://x.ai/cli/install.${windows ? 'ps1' : 'sh'}`, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]) })
        if (!response.ok) throw new Error(`llm-cli: Grok installer download failed (HTTP ${response.status})`)
        const script = await response.text()
        if (!script.length || script.length > 1024 * 1024) throw new Error('llm-cli: invalid Grok installer download')
        scriptDir = mkdtempSync(join(tmpdir(), 'dsh-cli-install-'))
        const file = join(scriptDir, windows ? 'install.ps1' : 'install.sh')
        writeFileSync(file, script, { mode: 0o600 })
        command = { bin: windows ? 'powershell.exe' : 'bash', args: windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] : [file], env: { ...process.env, GROK_BIN_DIR: root }, binPath: this.target(provider) }
      }
      if (typeof command.bin !== 'string' || !Array.isArray(command.args) || !command.args.every(arg => typeof arg === 'string') || typeof command.binPath !== 'string') throw new Error('llm-cli: invalid installCommand configuration')
      const executable = executablePath(command.bin) ?? command.bin
      const launch = resolveWindowsShim(executable)
      if (!launch) throw new Error('llm-cli: cannot resolve installer executable')
      const result = await runCapture({ bin: launch.bin, binArgs: launch.prefix }, command.args, { cwd: root, env: command.env ?? process.env, signal: this.controller.signal, timeoutMs: this.config.installTimeoutMs })
      if (result.code !== 0) throw new Error(`llm-cli: ${provider} installation failed (exit ${result.code ?? 'timeout'}); check network and file permissions`)
      const previous = { bin: route.bin, binArgs: route.binArgs, launchError: route.launchError }
      if (!this.adopt(provider, command.binPath, command.binArgs)) throw new Error(`llm-cli: ${provider} installer completed but its executable is missing`)
      try {
        const version = await runCapture(route, ['--version'], { cwd: root, timeoutMs: 30000, signal: this.controller.signal })
        if (version.code !== 0 || !version.stdout.trim()) throw new Error(`llm-cli: installed ${provider} failed its version check`)
      } catch (error) { Object.assign(route, previous); throw error }
      return { ...this.status(provider), installing: false }
    } finally { if (scriptDir) rmSync(scriptDir, { recursive: true, force: true }) }
  }

  dispose() { this.controller.abort() }
}

/** Drives one CLI's sign-in at a time and remembers what is waiting. */
class SignInManager {
  constructor(config, setup) {
    this.config = config
    this.setup = setup
    this.pending = new Map()
    this.failures = new Map()
    this.ttlMs = Number.isFinite(config?.signInTtlMs) && config.signInTtlMs > 0 ? config.signInTtlMs : DEFAULT_SIGN_IN_TTL_MS
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
    if (this.setup && !this.setup.status(provider).installed) return { signedIn: false, text: 'CLI not installed' }
    const { code, stdout, stderr } = await runCapture(route, statusArgs, {
      cwd: this.config.cwd,
      timeoutMs: 30000,
    }).catch(() => ({ code: null, stdout: '', stderr: '' }))
    const text = `${stdout}\n${stderr}`
    // A status probe must both succeed and identify an authenticated account.
    // OpenCode's negative-text predicate alone also accepts empty/error output.
    return { signedIn: code === 0 && signedIn(text), text: text.trim(), error: this.failures.get(provider) ?? '' }
  }

  /**
   * Start a sign-in and return the device instruction as soon as the CLI
   * prints it, leaving the process waiting for the human to approve.
   */
  async start(provider, signal) {
    if (signal?.aborted) throw new Error('llm-cli: sign-in was aborted')
    await this.setup?.ensure(provider)
    if (signal?.aborted) throw new Error('llm-cli: sign-in was aborted')
    const existing = this.pending.get(provider)
    if (existing) return { url: existing.url, code: existing.code, resumed: true }
    this.failures.delete(provider)
    const { route, loginArgs, note } = this.routeFor(provider)
    const child = spawnCommand(route, loginArgs, {
      cwd: this.config.cwd,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    let entry
    const collect = (chunk) => {
      text += chunk
      if (entry) {
        const info = parseDeviceInfo(text)
        entry.url = info.url
        entry.code = info.code
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    let closed = false
    const done = new Promise((resolve) => {
      child.on('close', (code) => resolve({ code, text }))
      child.on('error', (error) => resolve({ code: null, text: `${text}\n${error.message}` }))
    })

    entry = { child, done, url: undefined, code: undefined, timer: undefined }
    this.pending.set(provider, entry)
    const onAbort = () => this.cancel(provider)
    signal?.addEventListener('abort', onAbort, { once: true })
    done.then((result) => {
      closed = true
      if (!entry.cancelled && result.code !== 0) this.failures.set(provider, `The ${provider} sign-in failed (exit ${result.code ?? 'unknown'})`)
      clearTimeout(entry.timer)
      signal?.removeEventListener('abort', onAbort)
      if (this.pending.get(provider) === entry) this.pending.delete(provider)
    })

    // Poll for the prompt rather than reading one line: the CLI may print the
    // URL and the code on separate writes.
    const deadline = Date.now() + 15000
    let partialAt = 0
    let info = parseDeviceInfo(text)
    while (Date.now() < deadline && !closed && !signal?.aborted) {
      if (info.url && info.code) break
      if (info.url || info.code) {
        partialAt ||= Date.now()
        if (Date.now() - partialAt >= 1000) break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      info = parseDeviceInfo(text)
    }

    if (signal?.aborted) throw new Error('llm-cli: sign-in was aborted')
    if (closed) {
      const settled = await done
      if (settled.code !== 0) throw new Error(`llm-cli: "${provider}" sign-in failed (exit ${settled.code ?? 'unknown'})`)
      if (!info.url && !info.code) throw new Error(`llm-cli: "${provider}" sign-in exited before printing a code`)
    }

    entry.url = info.url
    entry.code = info.code
    if (!closed) {
      entry.timer = setTimeout(() => this.cancel(provider), this.ttlMs)
      entry.timer.unref?.()
    }

    return { url: info.url, code: info.code, note }
  }

  /** Close a waiting login when its caller or plugin goes away. */
  cancel(provider) {
    const entry = this.pending.get(provider)
    if (!entry) return false
    entry.cancelled = true
    this.pending.delete(provider)
    clearTimeout(entry.timer)
    if (entry.child.exitCode === null) entry.child.kill()
    return true
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
    clearTimeout(entry.timer)
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

/** How long a writer waits for the lock before leaving its turn pending. */
const LOCK_WAIT_MS = 250
/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 10000

/** Block this thread briefly. Only used to wait out another writer. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Take an exclusive lock file; returns a release function, or null on timeout. */
function acquireLedgerLock(file) {
  const lockFile = `${file}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(lockFile, 'wx'))
      return () => {
        try {
          unlinkSync(lockFile)
        } catch {
          /* already released */
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockFile)
          continue
        }
      } catch {
        /* raced with the holder, try again */
      }
      if (Date.now() >= deadline) return null
      sleepSync(10)
    }
  }
}

/** Read the ledger file, or null when it is missing or unusable. */
function readLedgerFile(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
  const totals = readTotals(parsed?.totals) ?? totalsFrom(entries)
  return { entries, totals }
}

/** Replace the ledger in one step, so a reader never sees half a write. */
function writeLedgerFile(file, payload) {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(payload), 'utf8')
  renameSync(temporary, file)
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
    this.pending = []
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
    const stored = entry?.id ? entry : { ...entry, id: randomUUID() }
    this.entries.push(stored)
    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit)
    addToTotals(this.totals, stored)
    this.pending.push(stored)
    // A write that never succeeds must not grow this list without bound.
    if (this.pending.length > this.limit) this.pending = this.pending.slice(-this.limit)
    this.flush()
  }

  /**
   * Merge this process's turns into the file under a lock. Two profiles can
   * point at one usageFile, so the write never replaces the file with this
   * process's view alone. A write that cannot take the lock leaves its turn
   * pending and retries on the next one.
   */
  flush() {
    if (!this.file || this.pending.length === 0) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
    } catch {
      return
    }
    const release = acquireLedgerLock(this.file)
    if (!release) return
    try {
      const onDisk = readLedgerFile(this.file)
      const totals = onDisk?.totals ?? emptyTotals()
      const entries = [...(onDisk?.entries ?? [])]
      for (const entry of this.pending) {
        addToTotals(totals, entry)
        entries.push(entry)
      }
      const trimmed = entries.slice(-this.limit)
      writeLedgerFile(this.file, { version: 2, totals, entries: trimmed })
      this.totals = totals
      this.entries = trimmed
      this.pending = []
    } catch {
      /* keep the turn pending: the next record tries again */
    } finally {
      release()
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

/**
 * Compare two dotted versions. Returns 1 when `a` is newer, -1 when older, and
 * 0 when they match. A pre-release suffix is ignored, so 1.2.3 and 1.2.3-beta
 * compare equal and an update is not offered for a suffix change.
 */
function compareVersions(a, b) {
  const parse = (value) =>
    String(value ?? '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

/** The version this copy of the plugin reports. */
function currentVersion() {
  const manifest = readJsonFile(join(pluginDir(), 'package.json'))
  return typeof manifest?.version === 'string' ? manifest.version : '0.0.0'
}

/** The directory this module was loaded from. */
function pluginDir() {
  return dirname(fileURLToPath(import.meta.url))
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The nearest ancestor directory that is a DSH profile. */
function findProfileDir(startDir) {
  let dir = startDir
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = readJsonFile(join(dir, 'package.json'))
    if (manifest?.dsh?.profile) return { dir, manifest }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * How this copy was installed, which decides how it can be updated. An npm
 * dependency is refreshed with the spec the profile already declares, so a fork
 * or a private mirror keeps working. A checkout, or a junction to one, is
 * refreshed with a fast-forward pull.
 */
function detectInstall(startDir = pluginDir(), cwd = process.cwd()) {
  const profile = findProfileDir(startDir) ?? findProfileDir(cwd)
  if (profile) {
    const spec = profile.manifest?.dependencies?.['dsh-llm-cli']
    if (typeof spec === 'string' && spec.length > 0) {
      return { method: 'npm', dir: profile.dir, spec, profile: profile.dir }
    }
    const linked = join(profile.dir, 'node_modules', 'dsh-llm-cli')
    let target = null
    try {
      if (lstatSync(linked).isSymbolicLink()) target = realpathSync(linked)
    } catch {
      target = null
    }
    if (target && existsSync(join(target, '.git'))) {
      return { method: 'git', dir: target, profile: profile.dir }
    }
    if (profile.dir) return { method: 'unknown', dir: profile.dir, profile: profile.dir }
  }
  if (existsSync(join(startDir, '.git'))) return { method: 'git', dir: startDir }
  return { method: 'unknown', dir: startDir }
}

/** The command that refreshes this install, or null when there is none. */
function updateCommand(install) {
  if (install?.method === 'npm' && install.spec) {
    return { bin: 'npm', args: ['install', install.spec], cwd: install.dir }
  }
  if (install?.method === 'git' && install.dir) {
    return { bin: 'git', args: ['-C', install.dir, 'pull', '--ff-only'], cwd: install.dir }
  }
  return null
}

/**
 * Pull the owner, repository and ref out of any GitHub spec a profile might
 * declare: the shorthand, a `git+https` URL, or a plain URL.
 */
function githubRepo(spec) {
  const value = String(spec ?? '').trim()
  const patterns = [
    /^(?:github:)?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:#(.+))?$/,
    /^git\+(?:https|ssh):\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:#(.+))?$/,
    /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:#(.+))?$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(value)
    if (match) return { owner: match[1], repo: match[2], ref: match[3] }
  }
  return null
}

/**
 * npm resolves a `github:owner/repo` shorthand over SSH, which fails on a host
 * with no key even when the repository is public. npm 11 also rewrites an
 * explicit `git+https` GitHub URL to ssh, so a git URL is not a reliable second
 * attempt either. The tarball endpoint needs no git and no credentials at all.
 */
function httpsFallbackSpec(spec) {
  const found = githubRepo(spec)
  return found ? `git+https://github.com/${found.owner}/${found.repo}.git${found.ref ? `#${found.ref}` : ''}` : null
}

function tarballFallbackUrl(spec) {
  const found = githubRepo(spec)
  if (!found) return null
  return `https://github.com/${found.owner}/${found.repo}/tarball/${found.ref ?? 'HEAD'}`
}

/**
 * The install commands to try in order for a dependency install. The declared
 * spec comes first, because a fork or a private mirror must keep working.
 */
function updateAttempts(install) {
  if (install?.method !== 'npm') return [updateCommand(install)].filter(Boolean)
  const specs = [install.spec, httpsFallbackSpec(install.spec), tarballFallbackUrl(install.spec)]
  const seen = new Set()
  const attempts = []
  for (const spec of specs) {
    if (!spec || seen.has(spec)) continue
    seen.add(spec)
    attempts.push({ bin: 'npm', args: ['install', spec], cwd: install.dir })
  }
  return attempts
}

/** Run an update command to completion, keeping the tail of its output. */
function runUpdateCommand(command) {
  return new Promise((resolve) => {
    let child
    try {
      const launch = resolveWindowsShim(findOnPath(command.bin) ?? command.bin) ?? { bin: command.bin, prefix: [] }
      child = spawn(launch.bin, [...launch.prefix, ...command.args], {
        cwd: command.cwd,
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, code: null, output: String(error?.message ?? error) })
      return
    }
    let output = ''
    const collect = (chunk) => {
      output += chunk
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => child.kill(), UPDATE_TIMEOUT_MS)
    const finish = (code, error) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0 && !error,
        code,
        output: `${error ? `${error.message}\n` : ''}${output}`.trim().slice(-4000),
      })
    }
    child.on('close', (code) => finish(code))
    child.on('error', (error) => finish(null, error))
  })
}

/**
 * Checks for a newer published version and, when asked, installs it. Reading
 * the version is one GET; installing runs npm or git in the profile, which is
 * why the endpoint that does it is loopback-only and needs an action token.
 */
class UpdateManager {
  constructor(config = {}, options = {}) {
    this.config = config
    // A direct construction should not have to know the default source.
    this.source = options.source ?? config?.updateSource ?? UPDATE_SOURCE
    this.install = options.install ?? detectInstall()
    this.logger = options.logger
    this.actionToken = randomUUID()
    this.latest = null
    this.lastError = ''
    this.checkedAt = 0
    this.applying = false
    this.restartRequired = false
    this.lastResult = null
    this.pending = null
  }

  /** Ask the source for the published version, reusing a recent answer. */
  async check({ force = false } = {}) {
    if (!force && this.checkedAt > 0 && Date.now() - this.checkedAt < UPDATE_TTL_MS) return this.status()
    if (this.pending) return this.pending
    this.pending = (async () => {
      try {
        const response = await fetch(this.source, {
          signal: AbortSignal.timeout(10000),
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const manifest = await response.json()
        this.latest = typeof manifest?.version === 'string' ? manifest.version : null
        this.lastError = this.latest ? '' : 'the update source has no version field'
      } catch (error) {
        this.lastError = String(error?.message ?? error)
      } finally {
        this.checkedAt = Date.now()
        this.pending = null
      }
      return this.status()
    })()
    return this.pending
  }

  status() {
    const current = currentVersion()
    const command = updateCommand(this.install)
    const updateAvailable = Boolean(this.latest) && compareVersions(this.latest, current) > 0
    const method = this.install?.method ?? 'unknown'
    return {
      current,
      latest: this.latest,
      updateAvailable,
      checkedAt: this.checkedAt,
      source: this.source,
      error: this.lastError,
      install: {
        method,
        dir: this.install?.dir,
        detail:
          method === 'npm'
            ? `npm dependency "${this.install.spec}" in ${this.install.dir}`
            : method === 'git'
              ? `git checkout at ${this.install.dir}`
              : 'no known install path',
      },
      canApply: Boolean(command) && !this.applying,
      autoUpdate: this.config.autoUpdate,
      applying: this.applying,
      restartRequired: this.restartRequired,
      actionToken: this.actionToken,
      lastResult: this.lastResult,
      note: command
        ? `Update runs ${command.bin} ${command.args.join(' ')} in ${command.cwd}, then restart the profile to load it.`
        : method === 'unknown'
          ? 'This copy was not installed as a profile dependency or a git checkout, so update it by hand.'
          : 'No update path is available.',
    }
  }

  /** Install the newest version. Returns the command result. */
  async apply() {
    if (this.applying) return { ok: false, output: 'an update is already running' }
    const command = updateCommand(this.install)
    if (!command) {
      const output = 'this install has no known update path, so update it by hand'
      this.lastResult = { at: Date.now(), ok: false, command: '', output }
      return this.lastResult
    }
    this.applying = true
    try {
      const attempts = updateAttempts(this.install)
      let result = { ok: false, code: null, output: 'no update command is available' }
      const tried = []
      for (const attempt of attempts) {
        tried.push(`${attempt.bin} ${attempt.args.join(' ')}`)
        result = await runUpdateCommand(attempt)
        if (result.ok) break
      }
      this.restartRequired = result.ok
      // The published version may now be what is installed, so drop the cache.
      this.latest = null
      this.checkedAt = 0
      this.lastResult = {
        at: Date.now(),
        ok: result.ok,
        command: tried.join(' ; '),
        output: result.output || `exit ${result.code}`,
      }
      return this.lastResult
    } finally {
      this.applying = false
    }
  }
}

/** True when the request came from this machine. */
function isLoopbackRequest(request) {
  // A local reverse proxy is not a local user. Never grant host privileges
  // through a tunnel, even when its upstream socket is loopback.
  const headers = Object.fromEntries(Object.entries(request?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
  if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip'].some(key => headers[key] !== undefined)) return false
  if (headers.host !== undefined) {
    try {
      const hostname = new URL(`http://${headers.host}`).hostname.toLowerCase()
      if (hostname !== 'localhost' && hostname !== '[::1]' && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false
    } catch { return false }
  }
  const raw = String(request?.socket?.remoteAddress ?? '')
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return address === '::1' || address === 'localhost' || address.startsWith('127.')
}

/** Read a dashboard token from a header, the query string, or the cookie. */
function tokenFromRequest(request) {
  const header = request?.headers?.['x-llm-cli-token']
  if (typeof header === 'string' && header.length > 0) return header
  let params
  try {
    params = new URL(request?.url ?? '', 'http://localhost').searchParams
  } catch {
    params = null
  }
  const query = params?.get('token')
  if (query) return query
  for (const part of String(request?.headers?.cookie ?? '').split(';')) {
    const trimmed = part.trim()
    if (!trimmed.startsWith('llm_cli_token=')) continue
    try { return decodeURIComponent(trimmed.slice('llm_cli_token='.length)) } catch { return '' }
  }
  return ''
}

/**
 * The dashboard carries cost, model names and sign-in state. This machine is
 * always allowed to read it. Anything else needs `dashboardToken`, and only a
 * token long enough to not be guessed counts as configured.
 */
function authorizeDashboard(request, token) {
  if (isLoopbackRequest(request)) return { ok: true }
  if (typeof token !== 'string' || token.length < MIN_DASHBOARD_TOKEN) {
    return {
      ok: false,
      reason: `remote dashboard access needs a dashboardToken of ${MIN_DASHBOARD_TOKEN}+ characters in the plugin config`,
    }
  }
  const given = Buffer.from(tokenFromRequest(request))
  const expected = Buffer.from(token)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'a valid dashboard token is required, as ?token=, an x-llm-cli-token header, or the llm_cli_token cookie' }
  }
  let fromQuery = false
  try {
    fromQuery = new URL(request?.url ?? '', 'http://localhost').searchParams.has('token')
  } catch {
    fromQuery = false
  }
  return {
    ok: true,
    // Remember a token that arrived in the URL so the page's own links work.
    setCookie: fromQuery
      ? `llm_cli_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/llm-cli`
      : undefined,
  }
}

/** Read a small request body, from a stream or from a test's plain object. */
function readRequestBody(request, limit = 4096) {
  return new Promise((resolve) => {
    if (typeof request?.body === 'string') {
      resolve(request.body.slice(0, limit))
      return
    }
    if (typeof request?.on !== 'function') {
      resolve('')
      return
    }
    let data = ''
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) request.destroy?.()
    })
    request.on('end', () => resolve(data.slice(0, limit)))
    request.on('error', () => resolve(''))
  })
}

/** Parse `?refresh=off`, so an operator can stop the page reloading itself. */
function autoRefreshFromUrl(url) {
  try {
    const value = new URL(url ?? '', 'http://localhost').searchParams.get('refresh')
    return !(value !== null && /^(0|off|false|no|paused)$/i.test(value))
  } catch {
    return true
  }
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

function forceUsageFromUrl(url) {
  try { return new URL(url ?? '', 'http://localhost').searchParams.get('force') === '1' } catch { return false }
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
async function describeRoutes(adapter, ledger, days = 0, { force = false } = {}) {
  if (force) adapter.invalidateCaches()
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
      'A CLI-backed route reports only what its CLI publishes. The Grok CLI persists per-session token and cost accounting locally (read here for its own totals) and caches per-model context limits, but it exposes no subscription quota, no remaining-request count and no reset time, so any "plan" gauge is your own configured budget. The OpenCode CLI publishes usage through `opencode stats` and model limits through `opencode api GET /api/model`; unavailable model limits use the labelled harness default. Token counts and cost under "this harness" are measured from this harness\u2019s own turns.',
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
function renderUsageHtml(summary, generatedAt, routes, notice, cliUsage, plans, options = {}) {
  const row = (cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`
  const autoRefresh = options.autoRefresh !== false
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
        entry.ok ? '<span class="ok">ok</span>' : `<span class="bad">${escapeHtml(entry.error ?? 'failed')}</span>`,
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
  for (const [title, minutes, limit, key] of [
    ['Codex 5-hour limit', codexLimits.primary?.windowMinutes ?? 300, codexLimits.primary, 'primary'],
    ['Codex weekly limit', codexLimits.secondary?.windowMinutes ?? 10080, codexLimits.secondary, 'secondary'],
  ]) {
    if (limit) {
      planCards.push(
        `<div class="card"><div class="k">${title} (reported by the CLI)</div><div class="v">${(limit.usedPercent ?? 0).toFixed(0)}% ${codexCli?.limitsSource === 'live' ? 'used' : 'recorded'}</div>${gaugeHtml((limit.usedPercent ?? 0) / 100, `${minutes >= 1440 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 60)}h`} window · resets ${stamp(limit.resetsAt)}`)}<div class="k">${codexCli?.limitsSource === 'live' ? 'Live quota checked:' : 'Recorded snapshot:'} ${escapeHtml(stamp(codexCli?.limitsObservedAt?.[key]))}${codexCli?.limitsStale?.[key] ? ' (stale)' : ''}. ${codexCli?.limitsSource === 'live' ? 'Refresh queries Codex account quota.' : 'Live quota unavailable; showing the recorded CLI snapshot.'}</div></div>`,
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
  // The unit column is "Steps" only for OpenCode; Grok and Codex count turns.
  const cliModelTable = (heading, rowsHtml, emptyNote, unit = 'Steps') =>
    `<h2>${heading}</h2><div class="wrap"><table><thead><tr><th>Model</th><th>${unit}</th><th>In</th><th>Out</th><th>Cache read</th><th>Total</th><th>Cost</th></tr></thead><tbody>${rowsHtml || `<tr><td colspan="7">${emptyNote}</td></tr>`}</tbody></table></div>`
  const cliSections =
    (cliCards.length || planCards.length) > 0
      ? `<h2>CLI-recorded usage</h2><div class="cards">${cliCards.join('')}</div>${
          planCards.length ? `<h2>Usage plans and subscription limits</h2><div class="cards">${planCards.join('')}</div>` : ''
        }${grokChart}${codexChart}${opencodeChart}${
          grokModelRows || opencodeModelRows || codexModelRows
            ? `<div class="cli-models">${
                grokModelRows ? cliModelTable('Grok usage by model', grokModelRows, 'No grok model usage recorded.', 'Turns') : ''
              }${
                codexModelRows ? cliModelTable('Codex usage by model', codexModelRows, 'No codex model usage recorded.', 'Turns') : ''
              }${
                opencodeModelRows
                  ? cliModelTable('OpenCode usage by model', opencodeModelRows, 'No OpenCode model usage recorded.')
                  : ''
              }</div>`
            : ''
        }`
      : ''
  const update = options.update
  const updateSection = update
    ? `<h2>Updates</h2>
<div class="card" style="max-width:900px">
  <div class="k">This copy is <strong>${escapeHtml(update.current)}</strong>${
    update.latest ? ` · newest published is <strong>${escapeHtml(update.latest)}</strong>` : ''
  } · ${update.checkedAt ? `checked ${escapeHtml(stamp(update.checkedAt))}` : 'not checked yet'}</div>
  <div class="k" style="margin-top:6px">${escapeHtml(update.error ? `check failed: ${update.error}` : update.note)}</div>
  <div class="k" style="margin-top:6px">installed as ${escapeHtml(update.install?.detail ?? 'unknown')} · auto-update: ${escapeHtml(
    update.autoUpdate || 'off',
  )}</div>
  <div style="margin-top:10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <a href="/llm-cli/usage?check=1" style="color:#6fb3ff">check for updates</a>
    ${
      update.actionToken && update.canApply && update.updateAvailable
        ? `<form method="post" action="/llm-cli/update" style="display:inline"><input type="hidden" name="token" value="${escapeHtml(
            update.actionToken,
          )}"><button type="submit" class="btn">Update now</button></form>`
        : ''
    }
  </div>
  ${update.restartRequired ? '<div class="k" style="margin-top:6px">Restart the profile to load the new version.</div>' : ''}
  ${
    update.lastResult
      ? `<div class="k" style="margin-top:6px">last run ${escapeHtml(stamp(update.lastResult.at))}: ${
          update.lastResult.ok ? 'ok' : 'failed'
        } · <code>${escapeHtml(update.lastResult.command || 'no command')}</code></div><pre class="log">${escapeHtml(
          update.lastResult.output,
        )}</pre>`
      : ''
  }
</div>`
    : ''
  const windowDaysShown = cliUsage?.windowDays ?? 0
  const windowLabel = cliUsage?.windowLabel ?? windowLabelFor(windowDaysShown)
  const windowLink = (query, text) =>
    `<a href="/llm-cli/usage?${query}" style="color:#6fb3ff">${text}</a>`
  // The page used to reload every 20 seconds from a meta tag, which threw the
  // reader back to the top. The script below keeps the scroll position, and
  // this link turns the reload off entirely.
  const refreshLink = autoRefresh
    ? windowLink(`days=${windowDaysShown || 'all'}&refresh=off`, 'pause auto-refresh')
    : windowLink(`days=${windowDaysShown || 'all'}&refresh=on`, 'resume auto-refresh')
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
  .btn { font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 7px; border: 1px solid #2a3140; background: #1b202a; color: inherit; cursor: pointer; }
  .log { background: #12151c; border: 1px solid #232833; border-radius: 8px; padding: 8px; font-size: 11px; max-height: 200px; overflow: auto; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>CLI provider usage</h1>
<div class="sub">OpenCode, Grok and Codex CLI usage · ${windowLabel}${opencodeCli?.available && opencodeCli.scopeDays > 0 && opencodeCli.scopeDays > windowDaysShown ? ` (opencode covers ${opencodeCli.scopeDays}d, whole days only)` : ''} · window ${windowLinks} · ${autoRefresh ? 'refreshes every 20s and keeps your place' : 'auto-refresh is off'} · ${refreshLink} · <a href="/llm-cli/usage.json?days=${windowDaysShown || 'all'}" style="color:#6fb3ff">JSON</a></div>
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
${updateSection}
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
${
  autoRefresh
    ? `<script>
  (() => {
    const key = 'llm-cli:scroll'
    const saved = sessionStorage.getItem(key)
    if (saved !== null) {
      window.scrollTo(0, Number(saved) || 0)
      sessionStorage.removeItem(key)
    }
    setTimeout(() => {
      sessionStorage.setItem(key, String(window.scrollY))
      location.reload()
    }, 20000)
  })()
</script>`
    : ''
}
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
        'Install a missing provider CLI when automatic installation is enabled, then start account sign-in. Returns a real URL and device code for browser approval. Supports Grok, Codex and OpenCode.',
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

/**
 * Normalize a route's configured `models` list.
 *
 * A `models` entry is either a bare id (the original shape) or an object that
 * also states that model's limits. The object form exists for routes whose CLI
 * publishes ids but no limits — OpenCode is the one shipped today — so a
 * profile can state a real context window instead of accepting the harness
 * default for every model on the route.
 *
 * @param {unknown} models - the raw `providers.<id>.models` value.
 * @returns {{id: string, name?: string, contextWindow?: number, maxOutputTokens?: number}[]}
 */
function modelEntries(models) {
  if (!Array.isArray(models)) return []
  const entries = []
  for (const entry of models) {
    if (typeof entry === 'string') {
      if (entry.length > 0) entries.push({ id: entry })
      continue
    }
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length === 0) continue
    entries.push({
      id: entry.id,
      ...(typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {}),
      ...(Number.isFinite(entry.contextWindow) && entry.contextWindow > 0 ? { contextWindow: entry.contextWindow } : {}),
      ...(Number.isFinite(entry.maxOutputTokens) && entry.maxOutputTokens > 0
        ? { maxOutputTokens: entry.maxOutputTokens }
        : {}),
    })
  }
  return entries
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
    merged.binExplicit = override?.bin !== undefined
    const resolvedBin = resolveBin(override?.bin ?? base.bin)
    const launch = resolveWindowsShim(resolvedBin)
    // A shim that cannot be read stays in place and is explained when a turn
    // tries to start it, so one broken route does not fail the whole plugin.
    merged.bin = launch?.bin ?? resolvedBin
    merged.binArgs = launch?.prefix ?? []
    if (!launch) {
      merged.launchError = `cannot launch the Windows shim "${resolvedBin}". Set providers.bin to the real executable, or install a build that ships one.`
    }
    // A profile may set the `opencode stats` invocation once, globally.
    if (id === 'opencode' && Array.isArray(config.opencodeStats?.args) && merged.statsArgs === undefined) {
      merged.statsArgs = config.opencodeStats.args
    }
    // Codex's model catalog lives in its own cache file, not in a CLI command.
    if (id === 'codex' && typeof override?.readModels !== 'function') {
      merged.readModels = () => readCodexModelList(merged.modelsCacheFile ?? codexModelsCache)
    }
    if (id === 'codex') {
      merged.appServer = override?.appServer ?? (typeof override?.buildArgs !== 'function')
      merged.liveQuota = override?.liveQuota ?? merged.appServer
    }
    if (id === 'codex' && merged.sandbox !== undefined && !['read-only', 'workspace-write'].includes(merged.sandbox)) {
      throw new Error('llm-cli: providers.codex.sandbox must be read-only or workspace-write')
    }
    providers[id] = merged
  }
  return {
    cwd: typeof config.cwd === 'string' && config.cwd.length > 0 ? config.cwd : process.cwd(),
    autoInstall: config.autoInstall !== false,
    cliInstallDir: typeof config.cliInstallDir === 'string' && isAbsolute(config.cliInstallDir) ? config.cliInstallDir : profilePath('.dsh', 'clis'),
    installTimeoutMs: Number.isFinite(config.installTimeoutMs) && config.installTimeoutMs > 0 ? config.installTimeoutMs : 300000,
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    usageFile:
      typeof config.usageFile === 'string' && config.usageFile.length > 0
        ? config.usageFile
        : profilePath('.dsh', 'llm-cli-usage.json'),
    includeSystemPrompt: config.includeSystemPrompt !== false,
    resolveCwd: typeof config.resolveCwd === 'function' ? config.resolveCwd : undefined,
    toolBridge: config.toolBridge === false ? false : 'json',
    plan: config.plan && typeof config.plan === 'object' ? config.plan : {},
    grokUsageDir:
      typeof config.grokUsageDir === 'string' && config.grokUsageDir.length > 0
        ? config.grokUsageDir
        : profilePath('.grok', 'sessions'),
    codexUsageDir:
      typeof config.codexUsageDir === 'string' && config.codexUsageDir.length > 0
        ? config.codexUsageDir
        : profilePath('.codex', 'sessions'),
    // Empty means remote reads are refused; loopback never needs it.
    dashboardToken: typeof config.dashboardToken === 'string' ? config.dashboardToken.trim() : '',
    signInTtlMs:
      Number.isFinite(config.signInTtlMs) && config.signInTtlMs > 0
        ? config.signInTtlMs
        : DEFAULT_SIGN_IN_TTL_MS,
    updateSource:
      typeof config.updateSource === 'string' && config.updateSource.length > 0 ? config.updateSource : UPDATE_SOURCE,
    // false (default) never touches the network. 'check' looks for a version,
    // 'apply' installs it. `true` is accepted as 'apply'.
    autoUpdate:
      config.autoUpdate === true || config.autoUpdate === 'apply'
        ? 'apply'
        : config.autoUpdate === 'check'
          ? 'check'
          : false,
    updateIntervalMs:
      Number.isFinite(config.updateIntervalMs) && config.updateIntervalMs >= 60000
        ? config.updateIntervalMs
        : DEFAULT_UPDATE_INTERVAL_MS,
    // An operator whose install detection gets wrong can say how to update.
    updateInstall:
      config.updateInstall && typeof config.updateInstall === 'object' && (config.updateInstall.method === 'npm' || config.updateInstall.method === 'git')
        ? {
            method: config.updateInstall.method,
            dir: typeof config.updateInstall.dir === 'string' ? config.updateInstall.dir : undefined,
            spec: typeof config.updateInstall.spec === 'string' ? config.updateInstall.spec : undefined,
          }
        : null,
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
  const setup = new CliSetupManager(normalized)
  const manager = new SignInManager(normalized, setup)
  ctx.effect?.(() => () => setup.dispose())
  ctx.effect?.(() => () => {
    for (const provider of manager.pending.keys()) manager.cancel(provider)
  })
  const ledger = new UsageLedger(normalized.usageFile)
  const updates = new UpdateManager(normalized, {
    logger: ctx.logger,
    install: normalized.updateInstall ?? undefined,
  })

  // An auto-updating install checks on its own. Nothing here runs unless the
  // profile asked for it; no scheduled update traffic is enabled by default.
  if (normalized.autoUpdate) {
    const tick = async () => {
      try {
        const status = await updates.check({ force: true })
        if (status.updateAvailable && status.canApply && normalized.autoUpdate === 'apply') {
          const result = await updates.apply()
          ctx.logger?.[result.ok ? 'info' : 'warn']?.(
            `llm-cli: auto-update ${result.ok ? 'installed' : 'failed'}`,
          )
        } else if (status.updateAvailable) {
          ctx.logger?.info?.(`llm-cli: version ${status.latest} is available (this copy is ${status.current})`)
        }
      } catch {
        /* the next tick tries again */
      }
    }
    const first = setTimeout(tick, 5000)
    const repeater = setInterval(tick, normalized.updateIntervalMs)
    first.unref?.()
    repeater.unref?.()
    ctx.effect?.(() => () => {
      clearTimeout(first)
      clearInterval(repeater)
    })
  }
  const adapter = new CliAdapter(ctx, normalized, manager, ledger)
  const unregister = ctx.llm.registerAdapter(routeNames, adapter)
  if (typeof unregister === 'function') ctx.effect?.(() => unregister)
  ctx.inject(['sessions'], (child) => {
    const sessions = child.sessions
    adapter.sessions = sessions
    child.effect?.(() => () => { if (adapter.sessions === sessions) adapter.sessions = undefined })
  })
  ctx.inject(['attachments'], (child) => {
    const attachments = child.attachments
    adapter.attachments = attachments
    child.effect?.(() => () => { if (adapter.attachments === attachments) adapter.attachments = undefined })
  })

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
    // This machine may always read the dashboard. Any other caller needs the
    // configured token, so a LAN-bound harness does not publish cost data.
    const guard = (handler) => async (request, response) => {
      const auth = authorizeDashboard(request, normalized.dashboardToken)
      if (!auth.ok) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end(`llm-cli: ${auth.reason}\n`)
        return
      }
      if (auth.setCookie) response.setHeader?.('set-cookie', auth.setCookie)
      return handler(request, response)
    }
    const disposers = [
      child.webServer.register({
        kind: 'exact', path: '/llm-cli/setup.json',
        handler: async (request, response) => {
          response.writeHead(isLoopbackRequest(request) ? 200 : 403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          if (!isLoopbackRequest(request)) { response.end(JSON.stringify({ error: 'CLI setup is available on the host only' })); return }
          response.end(JSON.stringify({ actionToken: updates.actionToken, autoInstall: normalized.autoInstall,
            providers: Object.keys(normalized.providers).map(id => ({ id, ...setup.status(id) })) }))
        },
      }),
      child.webServer.register({
        kind: 'exact', path: '/llm-cli/setup',
        handler: async (request, response) => {
          const reply = (code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
          const token = request?.headers?.['x-llm-cli-setup']
          if (!isLoopbackRequest(request) || typeof token !== 'string' || token !== updates.actionToken) { reply(403, { error: 'Host setup action token required' }); return }
          if (request.method !== 'POST') { reply(405, { error: 'Use POST' }); return }
          try {
            const body = JSON.parse(await readRequestBody(request))
            const provider = body.provider
            setup.route(provider)
            let result
            if (body.action === 'install') result = await setup.ensure(provider, { manual: true })
            else if (body.action === 'cancel') result = { cancelled: manager.cancel(provider) }
            else if (body.action === 'signin') {
              const before = await manager.status(provider)
              result = before.signedIn ? { signedIn: true } : { signedIn: false, pending: true, ...await manager.start(provider) }
            } else if (body.action === 'status') {
              const status = await manager.status(provider)
              const pending = manager.pending.get(provider)
              result = { signedIn: status.signedIn, pending: !!pending, url: pending?.url, code: pending?.code, error: status.signedIn ? '' : status.error }
              if (status.signedIn && pending) manager.cancel(provider)
            } else throw new Error('Unknown setup action')
            adapter.invalidateCaches()
            reply(200, { ...result, ...setup.status(provider) })
          } catch (error) { reply(400, { error: String(error?.message ?? error) }) }
        },
      }),
      child.webServer.register({
        kind: 'exact',
        path: '/llm-cli/usage',
        handler: guard(async (request, response) => {
          try {
            let url
            try {
              url = new URL(request?.url ?? '', 'http://localhost')
            } catch {
              url = new URL('http://localhost/llm-cli/usage')
            }
            if (url.searchParams.has('check')) await updates.check({ force: true })
            const payload = await describeRoutes(adapter, ledger, windowDaysFromUrl(request?.url), { force: forceUsageFromUrl(request?.url) })
            // Another machine may read the numbers with a token, but the update
            // action token stays on this host.
            const updateView = updates.status()
            if (!isLoopbackRequest(request)) updateView.actionToken = ''
            response.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            })
            response.end(
              renderUsageHtml(payload, Date.now(), payload.routes, payload.limitsNotice, payload.cliUsage, payload.plans, {
                autoRefresh: autoRefreshFromUrl(request?.url),
                update: updateView,
              }),
            )
          } catch (error) {
            response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            response.end(`llm-cli: could not build the usage view: ${String(error?.message ?? error)}`)
          }
        }),
      }),
      child.webServer.register({
        kind: 'exact',
        path: '/llm-cli/usage.json',
        handler: guard(async (request, response) => {
          try {
            const payload = await describeRoutes(adapter, ledger, windowDaysFromUrl(request?.url), { force: forceUsageFromUrl(request?.url) })
            response.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            response.end(JSON.stringify(payload))
          } catch (error) {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ error: String(error?.message ?? error) }))
          }
        }),
      }),
      child.webServer.register({
        kind: 'exact',
        path: '/llm-cli/update.json',
        handler: async (request, response) => {
          // The status carries the install path and the action token, so this
          // one never answers another machine, token or not.
          if (!isLoopbackRequest(request)) {
            response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            response.end('llm-cli: the update endpoint answers this machine only\n')
            return
          }
          let force = false
          try {
            force = new URL(request?.url ?? '', 'http://localhost').searchParams.has('force')
          } catch {
            force = false
          }
          const status = await updates.check({ force })
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify(status))
        },
      }),
      child.webServer.register({
        kind: 'exact',
        path: '/llm-cli/update',
        handler: async (request, response) => {
          const wantsJson = String(request?.headers?.accept ?? '').includes('application/json')
          const reply = (code, payload) => {
            if (wantsJson) {
              response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              response.end(JSON.stringify(payload))
              return
            }
            const body = `<pre>${escapeHtml(payload.output ?? '')}</pre>`
            response.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            response.end(
              `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>llm-cli update</title></head><body style="font:14px/1.5 ui-sans-serif,system-ui;background:#0f1115;color:#e6e8eb;padding:24px"><p>${payload.ok ? 'Update finished.' : 'Update did not finish.'}</p>${body}${
                payload.restartRequired ? '<p>Restart the profile to load the new version.</p>' : ''
              }<p><a href="/llm-cli/usage" style="color:#6fb3ff">back to the dashboard</a></p></body></html>`,
            )
          }
          if (!isLoopbackRequest(request)) {
            reply(403, { ok: false, output: 'the update endpoint answers this machine only' })
            return
          }
          if (String(request?.method ?? '').toUpperCase() !== 'POST') {
            reply(405, { ok: false, output: 'POST to this path to update' })
            return
          }
          // A cross-site form can post, but it cannot read the token, and a
          // cross-site fetch cannot set the header without a preflight.
          let token = String(request?.headers?.['x-llm-cli-update'] ?? '')
          if (!token) {
            const body = await readRequestBody(request)
            token = new URLSearchParams(body).get('token') ?? ''
          }
          const given = Buffer.from(token)
          const expected = Buffer.from(updates.actionToken)
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            reply(403, { ok: false, output: 'a valid action token is required' })
            return
          }
          const result = await updates.apply()
          reply(200, { ...result, restartRequired: updates.restartRequired, status: updates.status() })
        },
      }),
    ]
    child.effect(() => () => {
      for (const dispose of disposers) dispose()
    })
    ctx.logger?.info?.('llm-cli: usage dashboard at /llm-cli/usage')
  })

  ctx.logger?.info?.(
    `llm-cli: registered routes ${routeNames.join(', ')}`,
  )
}

export {
  buildTools,
  compareVersions,
  computePlans,
  currentVersion,
  describeRoutes,
  detectInstall,
  parseDeviceInfo,
  periodWindow,
  readGrokCliUsage,
  readGrokModelLimits,
  readCodexCliUsage,
  resolveWindowsShim,
  updateCommand,
  UpdateManager,
  readCodexModelList,
  renderUsageHtml,
  SignInManager,
  toOpencodeCliUsage,
  UsageLedger,
  windowCliUsage,
  windowGrokUsage,
}
