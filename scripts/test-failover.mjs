/**
 * Failover unit tests — no network, no API key, no Worker.
 *
 * `worker/failover.ts` decides when to abandon AgentRouter for the metered
 * backup. Getting that wrong is expensive in both directions: too eager and it
 * spends freemodel credit on a hiccup, too patient and the user waits out a
 * 3×3 retry ladder against a gateway that is already down. Neither failure is
 * visible from a happy-path manual test, so the branches are pinned here.
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

import { completeWithFailover, resolveFallback, resolveProviders } from '../worker/failover.ts'
import { UpstreamError } from '../worker/agentrouter.ts'

const PRIMARY = 'agentrouter.org'
const BACKUP = 'freemodel.dev'

const env = {
  AGENTROUTER_API_KEY: 'sk-primary',
  FREEMODEL_API_KEY: 'fm-backup',
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

console.log('\nresolveFallback')
{
  check('null with no key', resolveFallback({}) === null)
  check(
    'null when the kill switch is off',
    resolveFallback({ ...env, FALLBACK_ENABLED: 'false' }) === null,
  )
  check(
    'armed with a key',
    resolveFallback(env)?.provider === 'freemodel',
  )
  const fb = resolveFallback(env)
  check('defaults to gpt-5.5', fb.model === 'gpt-5.5', fb.model)
  check('uses the bare host, not api.', fb.baseUrl === 'https://freemodel.dev/v1', fb.baseUrl)
  check('sends no User-Agent', fb.userAgent === undefined)
  check('defaults to max_completion_tokens', fb.tokenParam === 'max_completion_tokens')
  check(
    'probe can switch the token param',
    resolveFallback({ ...env, FREEMODEL_TOKEN_PARAM: 'max_tokens' }).tokenParam === 'max_tokens',
  )
  check(
    'probe can drop reasoning_effort',
    resolveFallback({ ...env, FREEMODEL_REASONING_EFFORT: 'false' }).sendReasoningEffort === false,
  )
  // A typo in the kill switch must leave the backup armed, not silently off.
  check(
    'a typo in FALLBACK_ENABLED fails safe (still armed)',
    resolveFallback({ ...env, FALLBACK_ENABLED: 'no' }) !== null,
  )
}

console.log('\nresolveProviders')
{
  const chain = resolveProviders(env, 'gpt-5.6-sol')
  check('primary first, backup second', chain.map((c) => c.provider).join(',') === 'agentrouter,freemodel')
  check('the requested model overrides the primary only', chain[0].model === 'gpt-5.6-sol')
  check('the backup keeps its own catalogue', chain[1].model === 'gpt-5.5', chain[1].model)
  check('single provider without a freemodel key', resolveProviders({ AGENTROUTER_API_KEY: 'sk-x' }).length === 1)
  const err = await expectThrow(async () => resolveProviders({ FREEMODEL_API_KEY: 'fm-only' }))
  check('a backup alone is not a configuration', err?.name === 'NotConfiguredError', String(err))
}

console.log('\ncompleteWithFailover — happy path')
{
  const chain = resolveProviders(env)
  const counts = stubFetch({ [PRIMARY]: streamOk, [BACKUP]: streamOk })
  const attempt = await completeWithFailover(chain, [], new AbortController().signal)
  check('primary answers', attempt.provider === 'agentrouter')
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
    check(`${label}: backup answers`, attempt.provider === 'freemodel')
    check(`${label}: crossedOver is true`, attempt.crossedOver === true)
    // The whole point of "cross over fast": one try, not MAX_ATTEMPTS.
    check(`${label}: primary tried exactly once`, counts[PRIMARY] === 1, `was ${counts[PRIMARY]}`)
    check(`${label}: model recorded is the backup's`, attempt.model === 'gpt-5.5')
  }
}

console.log('\ncompleteWithFailover — 401 walks the keys first')
{
  const chain = resolveProviders({ ...env, AGENTROUTER_API_KEY_2: 'sk-second' })
  const counts = stubFetch({ [PRIMARY]: () => status(401), [BACKUP]: streamOk })
  const attempt = await completeWithFailover(chain, [], new AbortController().signal)
  check('backup answers once both keys are rejected', attempt.provider === 'freemodel')
  // One revoked key of two is not an outage — try the other before paying.
  check('both primary keys tried, no backoff ladder', counts[PRIMARY] === 2, `was ${counts[PRIMARY]}`)
}

console.log('\ncompleteWithFailover — 429 retries in place, then crosses')
{
  const chain = resolveProviders(env)
  const counts = stubFetch({ [PRIMARY]: () => status(429), [BACKUP]: streamOk })
  const attempt = await completeWithFailover(chain, [], new AbortController().signal)
  check('backup answers after the ladder', attempt.provider === 'freemodel')
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
  check('crosses to a gateway with a different catalogue', attempt.provider === 'freemodel')
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
  check('with from/to/status', JSON.stringify(seen[0]) === '["agentrouter","freemodel",502]', JSON.stringify(seen[0]))
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
  const chain = resolveProviders({ AGENTROUTER_API_KEY: 'sk-only' })
  const counts = stubFetch({ [PRIMARY]: () => status(503) })
  const err = await expectThrow(() => completeWithFailover(chain, [], new AbortController().signal))
  check('still fails', err instanceof UpstreamError, String(err))
  // With nowhere to cross to, retrying a bad minute is the only move left —
  // crossFast must not have silently made a single-provider setup less patient.
  check('the 3× ladder is still spent', counts[PRIMARY] === 3, `was ${counts[PRIMARY]}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
