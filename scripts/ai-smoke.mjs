// Smoke test (M0, extended in M1): drive a real pi Agent end to end (faux provider + one dummy tool) under plain Node, through the
// app's own entrypoint (src/main/ai/providers.ts, loaded via Node's type stripping, Node >= 22.18), with every
// network path blocked and counted. Run: node scripts/ai-smoke.mjs
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import dns from 'node:dns'
import net from 'node:net'

// --- network guard: installed before pi loads, so module-init calls would be caught too ---
const ALLOWED_HOSTS = new Set() // the faux provider needs none
const attempts = []
const block = (kind, target) => {
  attempts.push(`${kind} ${target}`)
  throw new Error(`network blocked: ${kind} ${target}`)
}
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname
  return ALLOWED_HOSTS.has(host) ? realFetch(input, init) : block('fetch', host)
}
// Every TCP/TLS client (http, https, undici, SDKs) ends in net.Socket#connect.
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === 'object' ? (Array.isArray(args[0]) ? args[0][0] : args[0]) : { port: args[0], host: args[1] }
  if (o?.path || ALLOWED_HOSTS.has(o?.host)) return realConnect.apply(this, args)
  block('connect', `${o?.host ?? 'localhost'}:${o?.port}`)
}
const realLookup = dns.lookup
dns.lookup = (host, ...rest) => (ALLOWED_HOSTS.has(host) ? realLookup(host, ...rest) : block('dns', host))
dgram.createSocket = () => block('udp', '*')

const { Type, calculateCost, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import('@earendil-works/pi-ai')
const { APP_IDENTITY, createAppAgent, createAppModels, testModel } = await import('../src/main/ai/providers.ts')

const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] })
const models = createAppModels()
models.setProvider(faux.provider)

const seenOptions = []
const record = (step) => (context, options, state, model) => {
  seenOptions.push(options)
  return typeof step === 'function' ? step(context, options, state, model) : step
}
faux.setResponses([
  record(fauxAssistantMessage([fauxText('Checking. '), fauxToolCall('whoami', { verbose: true })], { stopReason: 'toolUse' })),
  record((context) => {
    const result = context.messages.at(-1)
    assert.equal(result.role, 'toolResult')
    return fauxAssistantMessage(`You are ${result.content[0].text}.`)
  })
])

/** The dummy tool, shaped like M1's real ones (AgentTool from pi-agent-core). */
const whoami = {
  name: 'whoami',
  label: 'Who am I',
  description: 'Return the current AWS account.',
  parameters: Type.Object({ verbose: Type.Optional(Type.Boolean()) }),
  execute: async (_id, params) => ({
    content: [{ type: 'text', text: 'arn:aws:sts::123456789012:assumed-role/Dev/me' }],
    details: { verbose: params.verbose ?? false }
  })
}

const agent = createAppAgent(models, {
  initialState: { systemPrompt: 'test', model: faux.getModel(), tools: [whoami] },
  getApiKey: () => 'sk-faux',
  toolExecution: 'sequential'
})
const events = []
agent.subscribe((e) => {
  events.push(e.type)
  const extra =
    e.type === 'message_update' ? e.assistantMessageEvent.type :
    e.type === 'tool_execution_start' ? `${e.toolName} ${JSON.stringify(e.args)}` :
    e.type === 'tool_execution_end' ? `${e.toolName} isError=${e.isError} ${e.durationMs ?? '?'}ms` :
    e.type === 'message_end' ? e.message.role : ''
  console.log(`  ${e.type}${extra ? ` · ${extra}` : ''}`)
})

console.log('run 1: prompt → tool call → answer')
await agent.prompt('who am I?')
const last = agent.state.messages.at(-1)
assert.equal(last.role, 'assistant')
assert.equal(last.content[0].text, 'You are arn:aws:sts::123456789012:assumed-role/Dev/me.')
assert.ok(events.includes('tool_execution_end'))
assert.equal(faux.state.callCount, 2)
for (const o of seenOptions) {
  assert.equal(o.telemetry, undefined, 'telemetry must never reach a provider')
  assert.deepEqual(o.identity, APP_IDENTITY, 'pi attribution must be off')
  assert.equal(o.apiKey, 'sk-faux', 'key comes from getApiKey')
}
// The faux provider reports cost 0; real providers price usage with calculateCost over the catalog's $/1M rates.
console.log(`  usage: ${JSON.stringify(last.usage)}; calculateCost at $1/$2 per 1M: ${JSON.stringify(calculateCost(faux.getModel(), last.usage))}`)

console.log('run 2: abort on the first streamed delta')
const slow = fauxProvider({ provider: 'faux-slow', models: [{ id: 'slow' }], tokensPerSecond: 50 })
models.setProvider(slow.provider)
slow.setResponses([fauxAssistantMessage('word '.repeat(200))])
agent.state.model = slow.getModel()
const stop = agent.subscribe((e) => {
  if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') agent.abort()
})
await agent.prompt('talk a lot')
stop()
const aborted = agent.state.messages.at(-1)
assert.equal(aborted.stopReason, 'aborted')
console.log(`  stopReason=${aborted.stopReason}, partial chars=${aborted.content[0]?.text?.length ?? 0}`)

console.log('run 3: settings "测试连接" (testModel) through the same entrypoint')
const probe3 = fauxProvider({ provider: 'faux-test', models: [{ id: 'probe' }] })
models.setProvider(probe3.provider)
let testOptions
probe3.setResponses([
  (_context, options) => {
    testOptions = options
    return fauxAssistantMessage([fauxToolCall('ping', {})], { stopReason: 'toolUse' })
  }
])
const tested = await testModel(models, probe3.getModel(), 'sk-faux')
assert.equal(tested.ok, true)
assert.equal(tested.toolCalling, true)
assert.equal(testOptions.telemetry, undefined)
assert.deepEqual(testOptions.identity, APP_IDENTITY)
console.log(`  ${JSON.stringify(tested)}`)

// The guard must actually bite, or "0 attempts" proves nothing.
await assert.rejects(fetch('https://example.com'), /network blocked/)
const probe = attempts.pop()
console.log(`network guard self-test blocked: ${probe}`)
assert.deepEqual(attempts, [], `pi made network calls: ${attempts.join(', ')}`)
console.log('network attempts by pi: 0')
console.log('OK')
