import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readCodexCliUsage, windowCliUsage } from '../index.js'
import { assertEqual } from './_assert.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-overflow-'))
try {
  const now = Date.now()
  const context = (hours, model) => ({ timestamp: new Date(now - hours * 3600000).toISOString(), type: 'turn_context', payload: { model } })
  const token = (hours, input, output, total = input + output) => ({ timestamp: new Date(now - hours * 3600000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: total },
    last_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    model_context_window: 128000,
  } } })
  const write = (name, events) => writeFileSync(join(root, `rollout-${name}.jsonl`), events.map(JSON.stringify).join('\n'))
  write('healthy', [context(9, 'old-model'), token(9, 100, 10), context(1, 'new-model'), token(1, 160, 20)])
  const recent = () => windowCliUsage(readCodexCliUsage(root), now - 7 * 3600000, 'codex', 7 / 24)
  assertEqual(recent().totalTokens, 70, 'baseline recent usage is 70 tokens')
  // Codex fill_to_context_window zeroes component counters and reports context
  // occupancy in total_tokens. It is not a billable-usage counter reset.
  write('overflow', [context(50, 'overflow-model'), token(50, 300, 30), token(49, 0, 0, 128000)])
  assertEqual(recent().totalTokens, 70, 'an old overflow rollout cannot inflate a healthy session in 7h')
  assertEqual(recent().models.map(row => [row.id, row.totalTokens]), [['new-model', 70]], 'old usage is not reassigned to the new model')
  assertEqual(readCodexCliUsage(root).totalTokens, 510, 'context occupancy does not replace recorded lifetime token counters')
  // Even truly incomplete timestamp coverage must remain local to its rollout.
  write('incomplete', [{ type: 'turn_context', payload: { model: 'unknown-time' } }, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, output_tokens: 2 } } } }])
  assertEqual(recent().totalTokens, 70, 'an unrelated undated rollout cannot downgrade exact recent history')
  // After a context-full marker, subsequent component counters start again.
  write('resumed', [context(3, 'resumed'), token(3, 100, 10), token(2, 0, 0, 128000), token(1, 20, 3, 128023)])
  assertEqual(recent().models.find(row => row.id === 'resumed')?.totalTokens, 133, 'usage before and after context-full is retained once')
  // Approximate timestamp coverage is explicitly local to this active session.
  write('incomplete', [{ type: 'turn_context', payload: { model: 'unknown-time' } }, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, output_tokens: 2 } } } }, { timestamp: new Date(now - 2 * 3600000).toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: 'later activity' } }])
  const mixed = recent()
  assertEqual(mixed.timelinePrecision, 'mixed', 'mixed histories identify their approximate sessions')
  assertEqual(mixed.models.find(row => row.id === 'new-model')?.totalTokens, 70, 'approximation stays local to the incomplete rollout')
  for (const session of mixed.sessions) {
    assertEqual(session.models.reduce((sum, row) => sum + row.totalTokens, 0), session.totalTokens, 'each session agrees with its model details')
  }
  assertEqual(mixed.sessions.reduce((sum, row) => sum + row.totalTokens, 0), mixed.totalTokens, 'session details agree with the selected window total')
} finally { rmSync(root, { recursive: true, force: true }) }
console.log('ok  codex-overflow.test')
