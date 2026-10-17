/**
 * Per-model limit overrides.
 *
 * A route whose CLI publishes model ids but no limits (OpenCode is the shipped
 * one) can state one model's context window in the profile instead of accepting
 * the harness default for every model on the route.
 */
import { mount } from './_harness.mjs'
import { assertEqual } from './_assert.mjs'

const { adapter, routes } = mount({
  cwd: process.cwd(),
  providers: {
    opencode: {
      bin: process.execPath,
      models: [
        'opencode/plain',
        { id: 'opencode/configured', name: 'Configured', contextWindow: 272000, maxOutputTokens: 64000 },
      ],
    },
    codex: false,
    grok: false,
  },
})

assertEqual(routes, ['opencode'], 'the configured route is registered')

const models = await adapter.listModels('opencode')
assertEqual(
  models.map((model) => model.id),
  ['opencode/plain', 'opencode/configured'],
  'a bare id and an object entry are both offered',
)
assertEqual(models[0].name, 'opencode/plain', 'a bare id keeps itself as the name')
assertEqual(models[1].name, 'Configured', 'an object entry carries its display name')

const plain = await adapter.resolveModel('opencode', 'opencode/plain')
assertEqual(plain.context.contextWindow, 200000, 'an entry without a window keeps the harness default')

const configured = await adapter.resolveModel('opencode', 'opencode/configured')
assertEqual(configured.context.contextWindow, 272000, 'a configured window wins over the default')

const limits = adapter.limitsFor('opencode', 'opencode/configured')
assertEqual(limits.source, 'configured for this model', 'the dashboard says the window was configured')
assertEqual(limits.maxOutputTokens, 64000, 'max output tokens are reported')

const fallback = adapter.limitsFor('opencode', 'opencode/plain')
assertEqual(fallback.maxOutputTokens, undefined, 'a model without an override reports no max output')
