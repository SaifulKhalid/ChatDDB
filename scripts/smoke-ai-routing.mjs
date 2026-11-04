#!/usr/bin/env node

/**
 * Multi-AI Routing & Public Boundary Smoke Test
 *
 * Verifies:
 *  1. Strict Public Boundary:
 *     - GET /api/ai-services returns clean public AI services from the static catalog.
 *     - GET /api/models returns clean legacy public aliases only.
 *     - Zero leakage of private upstream model IDs or provider names.
 *     - GET /api/health no longer exposes hardcoded model names.
 *     - Cache-Control header is present with max-age=300 on discovery routes.
 *  2. Security Guards:
 *     - Unauthenticated requests to /api/admin/provider-health are rejected (401/403).
 *     - Deleted admin AI routes return 404.
 *  3. Admin Provider Health (when CHATDDB_TOKEN is provided):
 *     - GET /api/admin/provider-health returns two-provider health, in-memory circuits, and model ladders.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'
const TOKEN = process.env.CHATDDB_TOKEN

let passed = 0
let failed = 0

async function test(label, fn) {
  try {
    await fn()
    console.log(`  ✓ ${label}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${label}: ${err.message}`)
    failed++
  }
}

// Strictly forbidden substrings in public responses
const FORBIDDEN_STRINGS = [
  'CodeCraft',
  'codecraft',
  'OpenRouter',
  'openrouter',
  'api.openai.com',
  'circuit_until',
  'consecutive_failures',
]

async function main() {
  console.log(`\n======================================================`)
  console.log(`ChatDDB Multi-AI Routing Smoke Test (${BASE})`)
  console.log(`======================================================\n`)

  // -------------------------------------------------------------------------
  // Part 1: Public Discovery & Strict Boundary Verification
  // -------------------------------------------------------------------------
  console.log('--- 1. Public Discovery & Strict Boundary Verification ---')

  await test('GET /api/health — sanitized health endpoint without private model ID', async () => {
    const res = await fetch(`${BASE}/api/health`)
    if (!res.ok) throw new Error(`Status ${res.status}`)
    const text = await res.text()
    const body = JSON.parse(text)

    if (!body.ok) throw new Error('Expected ok: true')
    if (body.platform !== 'ChatDDB') throw new Error(`Expected platform: 'ChatDDB', got ${body.platform}`)
    if (body.model) throw new Error(`Leaked model in /api/health: ${body.model}`)

    for (const forbidden of FORBIDDEN_STRINGS) {
      if (text.toLowerCase().includes(forbidden.toLowerCase())) {
        throw new Error(`Leaked forbidden private string "${forbidden}" in /api/health response!`)
      }
    }
  })

  await test('GET /api/ai-services — public AI services discovery from catalog with cache headers', async () => {
    const res = await fetch(`${BASE}/api/ai-services`)
    if (!res.ok) throw new Error(`Status ${res.status}`)
    const cc = res.headers.get('cache-control') ?? ''
    if (!cc.includes('max-age=300')) {
      throw new Error(`Expected Cache-Control: max-age=300, got: "${cc}"`)
    }

    const text = await res.text()
    const body = JSON.parse(text)

    if (!Array.isArray(body.services)) throw new Error('Expected services array')
    if (body.services.length === 0) throw new Error('Expected catalogue AI services, got empty array')

    const names = body.services.map((s) => s.name)
    console.log(`    Discovered catalogue services: ${names.join(', ')}`)

    // Verify capability flags exist on public services
    for (const s of body.services) {
      if (typeof s.vision !== 'boolean') throw new Error(`Missing boolean vision on ${s.name}`)
      if (typeof s.documents !== 'boolean') throw new Error(`Missing boolean documents on ${s.name}`)
      if (typeof s.reasoning !== 'boolean') throw new Error(`Missing boolean reasoning on ${s.name}`)
    }

    // Strict boundary enforcement: verify zero forbidden strings in the raw HTTP response
    for (const forbidden of FORBIDDEN_STRINGS) {
      if (text.toLowerCase().includes(forbidden.toLowerCase())) {
        throw new Error(`STRICT BOUNDARY VIOLATION: Found "${forbidden}" in /api/ai-services response!`)
      }
    }
  })

  await test('GET /api/models — legacy models compatibility with cache headers', async () => {
    const res = await fetch(`${BASE}/api/models`)
    if (!res.ok) throw new Error(`Status ${res.status}`)
    const cc = res.headers.get('cache-control') ?? ''
    if (!cc.includes('max-age=300')) {
      throw new Error(`Expected Cache-Control: max-age=300, got: "${cc}"`)
    }

    const text = await res.text()
    const body = JSON.parse(text)

    if (!Array.isArray(body.models)) throw new Error('Expected models array')
    if (!body.default) throw new Error('Expected default model key')

    for (const forbidden of FORBIDDEN_STRINGS) {
      if (text.toLowerCase().includes(forbidden.toLowerCase())) {
        throw new Error(`STRICT BOUNDARY VIOLATION: Found "${forbidden}" in /api/models response!`)
      }
    }
  })

  // -------------------------------------------------------------------------
  // Part 2: Security Guards & Auth Enforcement
  // -------------------------------------------------------------------------
  console.log('\n--- 2. Security Guards & Auth Enforcement ---')

  await test('GET /api/admin/provider-health — rejects unauthenticated caller', async () => {
    const res = await fetch(`${BASE}/api/admin/provider-health`)
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`Expected 401/403, got ${res.status}`)
    }
  })

  await test('Deleted admin AI routes return 404', async () => {
    const deadRoutes = [
      '/api/admin/ai-services',
      '/api/admin/api-providers',
      '/api/admin/ai-routes',
      '/api/admin/verify-all',
      '/api/admin/ai-health',
    ]
    for (const path of deadRoutes) {
      const res = await fetch(`${BASE}${path}`)
      if (res.status !== 404) {
        throw new Error(`Expected 404 for deleted route ${path}, got ${res.status}`)
      }
    }
  })

  // -------------------------------------------------------------------------
  // Part 3: Authenticated Admin Operations (if token supplied)
  // -------------------------------------------------------------------------
  if (TOKEN) {
    console.log('\n--- 3. Authenticated Admin Operations ---')

    const adminHeaders = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    }

    await test('GET /api/admin/provider-health — returns two providers and circuit states', async () => {
      const res = await fetch(`${BASE}/api/admin/provider-health`, { headers: adminHeaders })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      const body = await res.json()
      if (!body.providers?.agentrouter || !body.providers?.apinex) {
        throw new Error('Expected both agentrouter and apinex in provider health')
      }
      if (!Array.isArray(body.models)) throw new Error('Expected models array')
      if (typeof body.circuits !== 'object') throw new Error('Expected circuits object')
      console.log(`    AgentRouter configured: ${body.providers.agentrouter.configured}, ApiNex configured: ${body.providers.apinex.configured}`)
    })
  } else {
    console.log('\n(Skipping authenticated admin tests — run with CHATDDB_TOKEN=<admin_token> to test)')
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n======================================================`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log(`======================================================\n`)

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Test runner fatal error:', err)
  process.exit(1)
})
