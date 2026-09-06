/**
 * AgentRouter provider unit tests — no network, no external API key, no Worker.
 *
 * Verifies that `worker/provider.ts`:
 *   - Resolves AgentRouter configuration correctly.
 *   - Rotates through multiple API keys on 401/403 or network failure.
 *   - Retries in place with exponential backoff on 429/408.
 *   - Rejects unconfigured environments with NotConfiguredError.
 *   - Propagates abort signals without unnecessary retries.
 *   - Formats headers and errors accurately for AgentRouter.
 *
 * Run via:
 *   node --experimental-strip-types scripts/test-provider.mjs
 */

import {
  createChatCompletion,
  NotConfiguredError,
  resolveConfig,
  UpstreamError,
} from '../worker/provider.ts'

const env = {
  AGENTROUTER_API_KEY: 'sk-ar-key-1',
  AGENTROUTER_API_KEY_2: 'sk-ar-key-2',
  AGENTROUTER_MODEL: 'deepseek-v4-flash',
  AGENTROUTER_BASE_URL: 'https://agentrouter.org/v1',
}

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks++
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function stubFetch(plan) {
  const counts = {}
  globalThis.fetch = async (url, init) => {
    const host = Object.keys(plan).find((h) => String(url).includes(h))
    if (!host) throw new Error(`unstubbed fetch to ${url}`)
    counts[host] = (counts[host] ?? 0) + 1
    return plan[host](counts[host], init)
  }
  return counts
}

const streamOk = () => new Response('data: [DONE]\n\n', { status: 200 })
const status = (code, body = '{"error":{"message":"boom","type":"server_error"}}') =>
  new Response(body, { status: code })
const unreachable = () => {
  throw new TypeError('fetch failed')
}

async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (err) {
    return err
  }
}

console.log('\nAgentRouter configuration resolution')
{
  const cfg = resolveConfig(env)
  check('provider is agentrouter', cfg.provider === 'agentrouter')
  check('baseUrl defaults or resolves correctly', cfg.baseUrl === 'https://agentrouter.org/v1')
  check('model resolves correctly', cfg.model === 'deepseek-v4-flash')
  check('collects both API keys', cfg.apiKeys.length === 2 && cfg.apiKeys[0] === 'sk-ar-key-1' && cfg.apiKeys[1] === 'sk-ar-key-2')

  const modelOverride = resolveConfig(env, 'deepseek-chat')
  check('model override parameter sets model', modelOverride.model === 'deepseek-chat')

  const legacyEnv = { PROVIDER_API_KEY: 'sk-legacy' }
  const legacyCfg = resolveConfig(legacyEnv)
  check('supports legacy PROVIDER_API_KEY', legacyCfg.apiKeys[0] === 'sk-legacy')

  const err = await expectThrow(async () => resolveConfig({}))
  check('unconfigured env throws NotConfiguredError', err instanceof NotConfiguredError)
}

console.log('\nAgentRouter completion — happy path')
{
  stubFetch({
    'agentrouter.org': (_count, init) => {
      check('Authorization header contains active key', init.headers.Authorization === 'Bearer sk-ar-key-1')
      check('User-Agent includes claude-cli', init.headers['User-Agent'].includes('claude-cli'))
      return streamOk()
    },
  })

  const cfg = resolveConfig(env)
  const res = await createChatCompletion(cfg, [{ role: 'user', content: 'hello' }], new AbortController().signal)
  check('response returned with status 200', res.status === 200)
}

console.log('\nAgentRouter completion — multi-key rotation on 401')
{
  let keysSeen = []
  stubFetch({
    'agentrouter.org': (count, init) => {
      keysSeen.push(init.headers.Authorization)
      if (count === 1) return status(401, '{"error":{"message":"invalid key","type":"invalid_api_key"}}')
      return streamOk()
    },
  })

  const cfg = resolveConfig(env)
  const res = await createChatCompletion(cfg, [{ role: 'user', content: 'test' }], new AbortController().signal)
  check('eventually succeeds on key 2', res.status === 200)
  check('first attempt used key 1', keysSeen[0] === 'Bearer sk-ar-key-1')
  check('second attempt used key 2', keysSeen[1] === 'Bearer sk-ar-key-2')
}

console.log('\nAgentRouter completion — multi-key rotation on unreachable key 1')
{
  let attempts = 0
  stubFetch({
    'agentrouter.org': (count) => {
      attempts++
      if (count <= 3) return unreachable()
      return streamOk()
    },
  })

  const cfg = resolveConfig(env)
  const res = await createChatCompletion(cfg, [{ role: 'user', content: 'test' }], new AbortController().signal)
  check('succeeds after falling back to key 2', res.status === 200)
  check('key 1 tried 3 times before rotating', attempts === 4)
}

console.log('\nAgentRouter completion — abort signal')
{
  stubFetch({
    'agentrouter.org': () => streamOk(),
  })

  const controller = new AbortController()
  controller.abort()

  const cfg = resolveConfig(env)
  const err = await expectThrow(async () =>
    createChatCompletion(cfg, [{ role: 'user', content: 'test' }], controller.signal),
  )
  check('pre-aborted controller throws AbortError', err?.name === 'AbortError')
}

// ---------------------------------------------------------------------------

console.log('\nAgentRouter completion — UpstreamError on 400')
{
  stubFetch({
    'agentrouter.org': () => status(400, '{"error":{"message":"malformed request","type":"invalid_request_error"}}'),
  })

  const cfg = resolveConfig(env)
  const err = await expectThrow(async () =>
    createChatCompletion(cfg, [{ role: 'user', content: 'bad' }], new AbortController().signal),
  )
  check('throws UpstreamError on 400', err instanceof UpstreamError && err.status === 400)
}

// ---------------------------------------------------------------------------
// Model Registry & Auto Mode Tests
// ---------------------------------------------------------------------------

import {
  MODELS,
  resolveModel,
  isKnownModel,
  isUpstreamModelId,
  toPublicModel,
  routeAutoModel,
  defaultModel,
} from '../worker/models.ts'
import {
  resolveCodeCraftConfig,
  CodeCraftProvider,
  AgentRouterProvider,
  resolveTextProvider,
} from '../worker/provider.ts'

console.log('\nModel Registry validation & projection')
{
  check('MODELS has exactly 5 active models', MODELS.length === 5)
  const keys = MODELS.map((m) => m.key).sort()
  check('MODELS has exact 5 public keys', JSON.stringify(keys) === JSON.stringify(['claude-opus-5', 'deepseek-v4-flash', 'gemini-3.7-flash', 'glm-5.3', 'gpt-5.6-sol']))

  check('isKnownModel accepts full model IDs', isKnownModel('gpt-5.6-sol') && isKnownModel('gemini-3.7-flash') && isKnownModel('claude-opus-5') && isKnownModel('glm-5.3') && isKnownModel('deepseek-v4-flash'))
  check('isKnownModel accepts backward-compatible aliases', isKnownModel('chatgpt-5.6') && isKnownModel('gpt') && isKnownModel('gemini-3.7') && isKnownModel('claude-5') && isKnownModel('glm') && isKnownModel('deepseek'))
  check('isKnownModel rejects unknown model IDs', !isKnownModel('unknown-model') && !isKnownModel('gpt-unknown'))

  check('isUpstreamModelId identifies upstream IDs', isUpstreamModelId('gpt-5.6-sol') && isUpstreamModelId('gemini-3.7-flash') && isUpstreamModelId('claude-opus-5') && isUpstreamModelId('glm-5.3') && isUpstreamModelId('deepseek-v4-flash'))
  check('isUpstreamModelId rejects invalid keys', !isUpstreamModelId('unknown-id') && !isUpstreamModelId('auto'))

  const publicGpt = toPublicModel(MODELS.find((m) => m.key === 'gpt-5.6-sol'))
  check('toPublicModel produces id = gpt-5.6-sol', publicGpt.id === 'gpt-5.6-sol')
  check('toPublicModel produces modelId = gpt-5.6-sol', publicGpt.modelId === 'gpt-5.6-sol')
  check('toPublicModel strips provider and vendor', !('provider' in publicGpt) && !('vendor' in publicGpt))
}

console.log('\nAuto mode intelligent routing')
{
  const fullEnv = {
    CODECRAFT_API_KEY: 'cc-secret-key',
    AGENTROUTER_API_KEY: 'sk-ar-key',
  }

  // 1. Coding intent -> ChatGPT 5.6 (gpt-5.6-sol)
  const codeChoice = routeAutoModel({ text: 'Write a typescript function to parse JSON with error handling ```ts const x = 1 ```' }, fullEnv)
  check('routes coding tasks to gpt-5.6-sol', codeChoice.key === 'gpt-5.6-sol')

  // 2. Reasoning intent -> GLM (glm-5.3)
  const reasoningChoice = routeAutoModel({ text: 'Provide a step-by-step mathematical proof for the theorem' }, fullEnv)
  check('routes reasoning tasks to glm-5.3', reasoningChoice.key === 'glm-5.3')

  // 3. Creative / writing / nuanced intent -> Claude 5 (claude-opus-5)
  const writingChoice = routeAutoModel({ text: 'Critique and edit this essay draft to improve flow, tone, and prose nuance' }, fullEnv)
  check('routes creative writing and essay analysis to claude-opus-5', writingChoice.key === 'claude-opus-5')

  // 4. Vision / multimodality intent -> Gemini 3.7 (gemini-3.7-flash)
  const visionChoice = routeAutoModel({ hasImages: true, text: 'Analyze this photo' }, fullEnv)
  check('routes vision requests to gemini-3.7-flash', visionChoice.key === 'gemini-3.7-flash')

  // 5. General queries -> DeepSeek (deepseek-v4-flash)
  const generalChoice = routeAutoModel({ text: 'What is the capital of France?' }, fullEnv)
  check('routes general queries to deepseek-v4-flash', generalChoice.key === 'deepseek-v4-flash')

  // 6. Provider fallback when CodeCraft is missing
  const noCcEnv = { AGENTROUTER_API_KEY: 'sk-ar-key' }
  const fallbackCoding = routeAutoModel({ text: 'Write a python script: def hello(): pass' }, noCcEnv)
  check('falls back to glm-5.3 when CodeCraft is missing for coding', fallbackCoding.key === 'glm-5.3')

  // 7. Provider fallback when AgentRouter is missing
  const noArEnv = { CODECRAFT_API_KEY: 'cc-secret-key' }
  const fallbackGeneral = routeAutoModel({ text: 'Brief greeting' }, noArEnv)
  check('falls back to gpt-5.6-sol when AgentRouter is missing for general query', fallbackGeneral.key === 'gpt-5.6-sol')
}

console.log('\nCodeCraft provider configuration & completion')
{
  const ccEnv = { CODECRAFT_API_KEY: 'cc-test-key-123' }
  const gptCfg = resolveCodeCraftConfig(ccEnv, 'gpt-5.6-sol')
  check('CodeCraft provider is codecraft', gptCfg.provider === 'codecraft')
  check('CodeCraft baseUrl is https://codecraftapi.com/v1', gptCfg.baseUrl === 'https://codecraftapi.com/v1')
  check('CodeCraft model is gpt-5.6-sol', gptCfg.model === 'gpt-5.6-sol')
  check('CodeCraft collects API key', gptCfg.apiKeys[0] === 'cc-test-key-123')
  check('CodeCraft tokenParam is max_tokens', gptCfg.tokenParam === 'max_tokens')
  check('CodeCraft sendReasoningEffort is false', gptCfg.sendReasoningEffort === false)

  // Key normalization: quotes and Bearer prefix stripping
  const quotedKeyEnv = { CODECRAFT_API_KEY: '"Bearer cc-quoted-token"' }
  const quotedCfg = resolveCodeCraftConfig(quotedKeyEnv, 'gpt-5.6-sol')
  check('CodeCraft normalizes quoted and Bearer-prefixed API key', quotedCfg.apiKeys[0] === 'cc-quoted-token')

  // Model resolution for Gemini & Claude
  const geminiCfg = resolveCodeCraftConfig(ccEnv, 'gemini-3.7-flash')
  check('CodeCraft Gemini model is gemini-3.7-flash', geminiCfg.model === 'gemini-3.7-flash')
  const claudeCfg = resolveCodeCraftConfig(ccEnv, 'claude-opus-5')
  check('CodeCraft Claude model is claude-opus-5', claudeCfg.model === 'claude-opus-5')

  const unconfiguredErr = await expectThrow(async () => resolveCodeCraftConfig({}))
  check('unconfigured CodeCraft throws NotConfiguredError', unconfiguredErr instanceof NotConfiguredError)
  check('unconfigured message uses user-safe model name', unconfiguredErr.message.includes('gpt-5.6-sol'))

  // CodeCraft Happy path
  stubFetch({
    'codecraftapi.com': (_count, init) => {
      check('CodeCraft Authorization header has bearer token', init.headers.Authorization === 'Bearer cc-test-key-123')
      check('CodeCraft Content-Type is application/json', init.headers['Content-Type'] === 'application/json')
      const body = JSON.parse(init.body)
      check('CodeCraft request body has stream: true', body.stream === true)
      check('CodeCraft request body has model ID', body.model === 'gpt-5.6-sol')
      check('CodeCraft request body omits reasoning_effort', body.reasoning_effort === undefined)
      check('CodeCraft request body omits stream_options', body.stream_options === undefined)
      check('CodeCraft request body uses max_tokens', body.max_tokens === 65_536)
      return streamOk()
    },
  })

  const provider = resolveTextProvider(ccEnv, MODELS.find((m) => m.key === 'gpt-5.6-sol'))
  check('resolveTextProvider returns CodeCraftProvider', provider instanceof CodeCraftProvider)
  const res = await provider.createChatCompletion([{ role: 'user', content: 'test' }], new AbortController().signal)
  check('CodeCraft completion returns status 200', res.status === 200)
}

console.log('\nError handling & sanitization')
{
  const ccEnv = { CODECRAFT_API_KEY: 'cc-test-key' }
  const provider = resolveTextProvider(ccEnv, MODELS.find((m) => m.key === 'gpt-5.6-sol'))

  // 401 Authentication error
  stubFetch({
    'codecraftapi.com': () => status(401, '{"error":{"message":"Invalid API key provided: cc-test-key","type":"authentication_error"}}'),
  })
  const err401 = await expectThrow(async () =>
    provider.createChatCompletion([{ role: 'user', content: 'test' }], new AbortController().signal),
  )
  check('401 throws UpstreamError', err401 instanceof UpstreamError && err401.type === 'invalid_api_key')
  check('401 error message hides raw key', !err401.message.includes('cc-test-key'))
  check('401 error message hides provider URL', !err401.message.includes('codecraftapi.com'))

  // 402 Insufficient balance
  stubFetch({
    'codecraftapi.com': () => status(402, '{"error":{"message":"Insufficient account balance","type":"insufficient_funds"}}'),
  })
  const err402 = await expectThrow(async () =>
    provider.createChatCompletion([{ role: 'user', content: 'test' }], new AbortController().signal),
  )
  check('402 maps to quota_exhausted', err402 instanceof UpstreamError && err402.type === 'quota_exhausted')

  // 403 Forbidden
  stubFetch({
    'codecraftapi.com': () => status(403, '{"error":{"message":"Access denied to model","type":"invalid_request_error"}}'),
  })
  const err403 = await expectThrow(async () =>
    provider.createChatCompletion([{ role: 'user', content: 'test' }], new AbortController().signal),
  )
  check('403 maps to forbidden', err403 instanceof UpstreamError && err403.type === 'forbidden')

  // 404 Model not found
  stubFetch({
    'codecraftapi.com': () => status(404, '{"error":{"message":"Model not found: gpt-5.6-sol","type":"model_not_found"}}'),
  })
  const err404 = await expectThrow(async () =>
    provider.createChatCompletion([{ role: 'user', content: 'test' }], new AbortController().signal),
  )
  check('404 maps to model_not_found', err404 instanceof UpstreamError && err404.type === 'model_not_found')

  // 422 Validation error
  stubFetch({
    'codecraftapi.com': () => status(422, '{"error":{"message":"max_tokens out of range","type":"validation_error"}}'),
  })
  const err422 = await expectThrow(async () =>
    provider.createChatCompletion([{ role: 'user', content: 'test' }], new AbortController().signal),
  )
  check('422 maps to validation_error', err422 instanceof UpstreamError && err422.type === 'validation_error')

  // 429 Rate limit with Retry-After header
  globalThis.fetch = async () => new Response('{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}', {
    status: 429,
    headers: { 'retry-after': '30' },
  })
  const err429 = await expectThrow(async () =>
    provider.createChatCompletion([{ role: 'user', content: 'test' }], new AbortController().signal),
  )
  check('429 maps to rate_limited', err429 instanceof UpstreamError && err429.type === 'rate_limited')
  check('429 includes Retry-After hint in message', err429.message.includes('30s'))

  // 502 Upstream provider error
  stubFetch({
    'codecraftapi.com': () => status(502, '{"error":{"message":"Upstream provider timeout","type":"provider_error"}}'),
  })
  const err502 = await expectThrow(async () =>
    provider.createChatCompletion([{ role: 'user', content: 'test' }], new AbortController().signal),
  )
  check('502 maps to upstream_provider_error', err502 instanceof UpstreamError && err502.type === 'upstream_provider_error')
}

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) process.exit(1)

