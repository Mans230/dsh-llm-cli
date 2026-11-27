import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readCodexCliUsage, windowCliUsage } from '../index.js'
import { assertEqual, assert } from './_assert.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-timeline-'))
try {
  const now = Date.now()
  const events = [
    { timestamp: new Date(now - 9 * 3600000).toISOString(), type: 'turn_context', payload: { model: 'old-model' } },
    { timestamp: new Date(now - 9 * 3600000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
    { timestamp: new Date(now - 3600000).toISOString(), type: 'turn_context', payload: { model: 'new-model' } },
    { timestamp: new Date(now - 3600000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 160, output_tokens: 20 } } } },
  ]
  // Repeated snapshots must not double-count the last turn.
  events.push(events.at(-1))
  writeFileSync(join(root, 'rollout-timeline.jsonl'), events.map(JSON.stringify).join('\n'))
  const full = readCodexCliUsage(root)
  assert(Array.isArray(full.timeline), 'Codex exposes timestamped usage')
  assertEqual(full.timeline.map(row => [row.model, row.totalTokens]), [['old-model', 110], ['new-model', 70]], 'deltas retain the model active at each event and deduplicate repeated snapshots')
  assertEqual(full.models.map(row => [row.id, row.totalTokens]), [['old-model', 110], ['new-model', 70]], 'lifetime model totals retain model switches within a session')
  const short = windowCliUsage(full, now - 7 * 3600000, 'codex', 7 / 24)
  assertEqual(short.totalTokens, 70, '7h totals exclude the old part of a still-active session')
  assertEqual(short.models.map(row => row.id), ['new-model'], '7h model totals follow token events')
  assertEqual(short.timeline.length, 1, 'the series uses the same window as totals')
  assertEqual(windowCliUsage(full, now - 24 * 3600000, 'codex', 1).totalTokens, 180, '24h includes both events')
} finally { rmSync(root, { recursive: true, force: true }) }
console.log('ok  timeline.test')
