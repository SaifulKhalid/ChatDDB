/**
 * Failover unit tests — no network, no API key, no Worker.
 *
 * `worker/failover.ts` decides when to abandon the primary gateway for the
 * OpenRouter free-tier backup. Getting that wrong is expensive in both
 * directions: too eager and it spends the free daily allowance on a hiccup, too
 * patient and the user waits out a 3×3 retry ladder against a gateway that is
 * already down. Neither failure is visible from a happy-path manual test, so
 * the branches are pinned here.
 *
 * `globalThis.fetch` is replaced with a scripted stub that counts calls per
 * host, which is how "crossed over on the *first* 503" is distinguished from
 * "crossed over eventually".
 *
 *   npm run test:failover
 *
 * The `--experimental-strip-types` flag in that script is what lets a .mjs file
 * import the Worker's .ts modules directly. Node 22 needs it; 24 does not, but
 * accepts it. Nothing here is compiled, so the code under test is the code that
 * ships.
 */

import { chainFor, completeWithFailover, fallbackReady, fallbackModel, resolveProviders } from '../worker/failover.ts'
import { UpstreamError } from '../worker/provider.ts'
import { findModel } from '../worker/models.ts'

const PRIMARY = 'agentrouter.org'
const BACKUP = 'openrouter.ai'

const env = {
  PROVIDER_API_KEY: 'sk-primary',
  OPENROUTER_API_KEY: 'sk-or-backup',
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

/**
 * Installs a fetch stub. `plan` maps a host substring to a handler receiving the
 * 1-based call count for that host, so a handler can fail twice and then succeed.
 */
function stubFetch(plan) {
  const counts = {}
  globalThis.fetch = async (url) => {
    const host = Object.keys(plan).find((h) => String(url).includes(h))
    if (!host) throw new Error(`unstubbed fetch to ${url}`)
    counts[host] = (counts[host] ?? 0) + 1
    return plan[host](counts[host])
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

// ---------------------------------------------------------------------------

console.log('\nresolveProviders / fallbackReady')
{
  const chain = resolveProviders(env)
  check('primary first, backup second', chain.map((c) => c.provider).join(',') === 'provider,openrouter')
  check('the requested model overrides the primary only', resolveProviders(env, 'gpt-5.6-sol')[0].model === 'gpt-5.6-sol')
  check('the backup keeps its own catalogue', chain[1].model === 'z-ai/glm-5.2:free', chain[1].model)
  check('single provider without an OpenRouter key', resolveProviders({ PROVIDER_API_KEY: 'sk-x' }).length === 1)
  check('kill switch disarms the backup', resolveProviders({ ...env, OPENROUTER_ENABLED: 'false' }).length === 1)
  // A typo in the kill switch must leave the backup armed, not silently off.
  check(
    'a typo in OPENROUTER_ENABLED fails safe (still armed)',
    resolveProviders({ ...env, OPENROUTER_ENABLED: 'no' }).length === 2,
  )
  const err = await expectThrow(async () => resolveProviders({ OPENROUTER_API_KEY: 'or-only' }))
  check('a backup alone is not a configuration', err?.name === 'NotConfiguredError', String(err))
  check('fallbackReady is true with a key', fallbackReady(env) === true)
  check('fallbackReady is false without one', fallbackReady({ PROVIDER_API_KEY: 'sk-x' }) === false)
  check(
    'fallbackModel reports the backup id',
    fallbackModel(env) === 'z-ai/glm-5.2:free',
    String(fallbackModel(env)),
  )
  check('the backup sends max_tokens by default', chain[1].tokenParam === 'max_tokens', chain[1].tokenParam)
  check(
    'the token param can be switched',
    resolveProviders({ ...env, OPENROUTER_TOKEN_PARAM: 'max_completion_tokens' })[1].tokenParam ===
      'max_completion_tokens',
  )
  check(
    'reasoning_effort can be dropped',
    resolveProviders({ ...env, OPENROUTER_REASONING_EFFORT: 'false' })[1].sendReasoningEffort === false,
  )
}

// The vision half of the chainFor contract. An image turn may only cross to a
// backup declared vision-capable — an unverified claim would forward the image
// to a model that refuses it upstream, after the user waited out the primary
// failing first. Both directions are pinned: filtering every image turn would
// silently halve reliability for vision-verified deployments.
console.log('\nchainFor — an image turn only crosses to a declared-vision backup')
{
  const providers = resolveProviders(env)
  const gpt = findModel('gpt-5.6-sol')
  check('the registry id resolves', gpt?.vendor === 'openai')

  const text = chainFor(providers, gpt, false)
  check('a text turn keeps the backup', text.length === 2, `${text.length}`)

  const image = chainFor(providers, gpt, true)
  check('an image turn drops an undeclared backup', image.length === 1, `${image.length}`)
  check('the primary is never filtered', image[0].provider === 'provider')

  const vision = resolveProviders({ ...env, OPENROUTER_VISION: 'true' })
  check('an image turn keeps a declared-vision backup', chainFor(vision, gpt, true).length === 2)
}

// Every model crosses over now, explicit picks included — the substitution is
// announced in headers and activity logs rather than prevented. The old vendor
// rule (an explicit Claude pick never answered by a GPT model) was dropped
// deliberately; this pins its removal so the change is a decision, not a drift.
console.log('\nchainFor — an explicit pick keeps the backup too')
{
  const providers = resolveProviders(env)
  const claude = findModel('claude-opus-5')
  check('an explicit Claude pick keeps the backup', chainFor(providers, claude, false).length === 2)
  check('the primary still answers as Claude', resolveProviders(env, 'claude-opus-5')[0].model === 'claude-opus-5')
}

console.log('\ncompleteWithFailover — happy path')
{
  const chain = resolveProviders(env)
  const counts = stubFetch({ [PRIMARY]: streamOk, [BACKUP]: streamOk })
  const attempt = await completeWithFailover(chain, [], new AbortController().signal)
  check('primary answers', attempt.provider === 'provider')
  check('crossedOver is false', attempt.crossedOver === false)
  check('backup never touched', counts[BACKUP] === undefined)
}

console.log('\ncompleteWithFailover — crosses fast')
{
  for (const [label, handler] of [
    ['503', () => status(503)],
    ['500', () => status(500)],
    ['unreachable', unreachable],
  ]) {
    const chain = resolveProviders(env)
    const counts = stubFetch({ [PRIMARY]: handler, [BACKUP]: streamOk })
    const attempt = await completeWithFailover(chain, [], new AbortController().signal)
    check(`${label}: backup answers`, attempt.provider === 'openrouter')
    check(`${label}: crossedOver is true`, attempt.crossedOver === true)
    // The whole point of "cross over fast": one try, not MAX_ATTEMPTS.
    check(`${label}: primary tried exactly once`, counts[PRIMARY] === 1, `was ${counts[PRIMARY]}`)
    check(`${label}: model recorded is the backup's`, attempt.model === 'z-ai/glm-5.2:free')
  }
}

console.log('\ncompleteWithFailover — 401 walks the keys first')
{
  const chain = resolveProviders({ ...env, PROVIDER_API_KEY_2: 'sk-second' })
  const counts = stubFetch({ [PRIMARY]: () => status(401), [BACKUP]: streamOk })
  const attempt = await completeWithFailover(chain, [], new AbortController().signal)
  check('backup answers once both keys are rejected', attempt.provider === 'openrouter')
  // One revoked key of two is not an outage — try the other before crossing.
  check('both primary keys tried, no backoff ladder', counts[PRIMARY] === 2, `was ${counts[PRIMARY]}`)
}

console.log('\ncompleteWithFailover — 429 retries in place, then crosses')
{
  const chain = resolveProviders(env)
  const counts = stubFetch({ [PRIMARY]: () => status(429), [BACKUP]: streamOk })
  const attempt = await completeWithFailover(chain, [], new AbortController().signal)
  check('backup answers after the ladder', attempt.provider === 'openrouter')
  // Waiting genuinely helps a rate limit, so this is the one that stays patient.
  check('primary retried 3× in place', counts[PRIMARY] === 3, `was ${counts[PRIMARY]}`)
}

console.log('\ncompleteWithFailover — does not cross for our own bad request')
{
  const chain = resolveProviders(env)
  const counts = stubFetch({
    [PRIMARY]: () => status(400, '{"error":{"message":"messages[0] is malformed","type":"invalid_request_error"}}'),
    [BACKUP]: streamOk,
  })
  const err = await expectThrow(() => completeWithFailover(chain, [], new AbortController().signal))
  check('throws instead of crossing', err instanceof UpstreamError, String(err))
  check('crossable is false', err?.crossable === false)
  check('backup never charged for the same refusal', counts[BACKUP] === undefined)
}

console.log('\ncompleteWithFailover — a 400 about the model IS an outage shape')
{
  const chain = resolveProviders(env)
  stubFetch({
    [PRIMARY]: () => status(400, '{"error":{"message":"model gpt-5.6-sol is not available","type":"invalid_request_error"}}'),
    [BACKUP]: streamOk,
  })
  const attempt = await completeWithFailover(chain, [], new AbortController().signal)
  check('crosses to a gateway with a different catalogue', attempt.provider === 'openrouter')
}

console.log('\ncompleteWithFailover — reports every crossover')
{
  const chain = resolveProviders(env)
  stubFetch({ [PRIMARY]: () => status(502), [BACKUP]: streamOk })
  const seen = []
  await completeWithFailover(chain, [], new AbortController().signal, (from, to, err) =>
    seen.push([from, to, err.upstreamStatus]),
  )
  check('called once', seen.length === 1, JSON.stringify(seen))
  check('with from/to/status', JSON.stringify(seen[0]) === '["provider","openrouter",502]', JSON.stringify(seen[0]))
}

console.log('\ncompleteWithFailover — Stop is not a failure to route around')
{
  const chain = resolveProviders(env)
  const ac = new AbortController()
  const counts = stubFetch({
    [PRIMARY]: () => {
      ac.abort()
      throw new DOMException('Aborted', 'AbortError')
    },
    [BACKUP]: streamOk,
  })
  const err = await expectThrow(() => completeWithFailover(chain, [], ac.signal))
  check('abort propagates', err?.name === 'AbortError', String(err))
  check('backup not started', counts[BACKUP] === undefined)
}

console.log('\nboth gateways down')
{
  const chain = resolveProviders(env)
  const counts = stubFetch({ [PRIMARY]: () => status(503), [BACKUP]: () => status(503) })
  const err = await expectThrow(() => completeWithFailover(chain, [], new AbortController().signal))
  check('the error surfaces', err instanceof UpstreamError, String(err))
  // Never 502/503: the frontend reads those as "no backend" and swaps in a mock.
  check('status is not 404/502/503', ![404, 502, 503].includes(err.status), `was ${err.status}`)
  // The last gateway has nothing to cross to, so it keeps the old retry ladder.
  check('backup exhausted its own ladder', counts[BACKUP] === 3, `was ${counts[BACKUP]}`)
}

console.log('\nno backup configured — the old behaviour is unchanged')
{
  const chain = resolveProviders({ PROVIDER_API_KEY: 'sk-only' })
  const counts = stubFetch({ [PRIMARY]: () => status(503) })
  const err = await expectThrow(() => completeWithFailover(chain, [], new AbortController().signal))
  check('still fails', err instanceof UpstreamError, String(err))
  // With nowhere to cross to, retrying a bad minute is the only move left —
  // crossFast must not have silently made a single-provider setup less patient.
  check('the 3× ladder is still spent', counts[PRIMARY] === 3, `was ${counts[PRIMARY]}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
