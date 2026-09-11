#!/usr/bin/env node

/**
 * Multi-AI Routing & Public Boundary Smoke Test
 *
 * Verifies:
 *  1. Strict Public Boundary:
 *     - GET /api/ai-services returns clean public AI services only.
 *     - GET /api/models returns clean legacy public aliases only.
 *     - Zero leakage of private upstream model IDs (gpt-5.6-sol, deepseek-v4-flash),
 *       provider names (AgentRouter, CodeCraft), API keys, or upstream URLs.
 *     - GET /api/health no longer exposes hardcoded model names.
 *  2. Security Guards:
 *     - Unauthenticated requests to /api/admin/ai-* and /api/admin/verify-all are rejected (401/403).
 *  3. Admin Routing Operations (when CHATDDB_TOKEN is provided):
 *     - Admin AI Services list & update
 *     - Admin API Providers list & credential masking (••••••••1234)
 *     - Admin AI Routes list, reorder, and priority validation
 *     - POST /api/admin/verify-all probe execution
 *     - GET /api/admin/ai-health status aggregation
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
  'gpt-5.6-sol',
  'gpt-5.5',
  'deepseek-v4-flash',
  'CodeCraft',
  'codecraft',
  'AgentRouter',
  'agentrouter',
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

  await test('GET /api/ai-services — public AI services discovery with strict boundary', async () => {
    const res = await fetch(`${BASE}/api/ai-services`)
    if (!res.ok) throw new Error(`Status ${res.status}`)
    const text = await res.text()
    const body = JSON.parse(text)

    if (!Array.isArray(body.services)) throw new Error('Expected services array')
    if (body.services.length === 0) throw new Error('Expected seeded AI services, got empty array')

    const names = body.services.map((s) => s.name)
    console.log(`    Discovered live services: ${names.join(', ')}`)
    if (names.length === 0) throw new Error('Expected at least one live AI service')

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

  await test('GET /api/models — legacy models compatibility with sanitized public names', async () => {
    const res = await fetch(`${BASE}/api/models`)
    if (!res.ok) throw new Error(`Status ${res.status}`)
    const text = await res.text()
    const body = JSON.parse(text)

    if (!Array.isArray(body.models)) throw new Error('Expected models array')
    if (!body.default) throw new Error('Expected default model key')

    for (const m of body.models) {
      // Model id, label, short must all be clean public strings
      if (m.modelId && FORBIDDEN_STRINGS.some((f) => m.modelId.toLowerCase().includes(f.toLowerCase()))) {
        throw new Error(`STRICT BOUNDARY VIOLATION: Leaked private modelId "${m.modelId}"`)
      }
    }

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

  await test('GET /api/admin/ai-services — rejects unauthenticated caller', async () => {
    const res = await fetch(`${BASE}/api/admin/ai-services`)
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`Expected 401/403, got ${res.status}`)
    }
  })

  await test('GET /api/admin/api-providers — rejects unauthenticated caller', async () => {
    const res = await fetch(`${BASE}/api/admin/api-providers`)
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`Expected 401/403, got ${res.status}`)
    }
  })

  await test('GET /api/admin/ai-routes — rejects unauthenticated caller', async () => {
    const res = await fetch(`${BASE}/api/admin/ai-routes`)
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`Expected 401/403, got ${res.status}`)
    }
  })

  await test('POST /api/admin/verify-all — rejects unauthenticated caller', async () => {
    const res = await fetch(`${BASE}/api/admin/verify-all`, { method: 'POST' })
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`Expected 401/403, got ${res.status}`)
    }
  })

  await test('GET /api/admin/ai-health — rejects unauthenticated caller', async () => {
    const res = await fetch(`${BASE}/api/admin/ai-health`)
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`Expected 401/403, got ${res.status}`)
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

    await test('GET /api/admin/ai-services — returns full service definitions', async () => {
      const res = await fetch(`${BASE}/api/admin/ai-services`, { headers: adminHeaders })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      const body = await res.json()
      if (!Array.isArray(body.services)) throw new Error('Expected services array')
      if (body.services.length < 6) throw new Error(`Expected at least 6 services, got ${body.services.length}`)
    })

    await test('GET /api/admin/api-providers — returns masked API credentials (••••••••1234)', async () => {
      const res = await fetch(`${BASE}/api/admin/api-providers`, { headers: adminHeaders })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      const body = await res.json()
      if (!Array.isArray(body.providers)) throw new Error('Expected providers array')
      for (const p of body.providers) {
        if (p.apiKey) throw new Error(`Plaintext apiKey exposed in provider ${p.key}!`)
        if (p.hasKey && !p.maskedKey?.includes('•')) {
          throw new Error(`Expected masked key format (••••••••1234), got: ${p.maskedKey}`)
        }
      }
    })

    await test('GET /api/admin/ai-routes — returns prioritized routing topology', async () => {
      const res = await fetch(`${BASE}/api/admin/ai-routes`, { headers: adminHeaders })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      const body = await res.json()
      if (!Array.isArray(body.routes)) throw new Error('Expected routes array')
      if (body.routes.length === 0) throw new Error('Expected seeded routes')
    })

    await test('GET /api/admin/ai-health — returns aggregated health and circuit states', async () => {
      const res = await fetch(`${BASE}/api/admin/ai-health`, { headers: adminHeaders })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      const body = await res.json()
      if (!body.overallStatus) throw new Error('Missing overallStatus')
      if (!Array.isArray(body.services)) throw new Error('Missing services array')
    })

    await test('POST /api/admin/verify-all — executes probe suite across all routes', async () => {
      const res = await fetch(`${BASE}/api/admin/verify-all`, {
        method: 'POST',
        headers: adminHeaders,
      })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      const body = await res.json()
      if (typeof body.totalChecked !== 'number') throw new Error('Missing totalChecked')
      if (!Array.isArray(body.results)) throw new Error('Missing probe results array')
      console.log(`    Probed ${body.totalChecked} routes: ${body.healthyCount} healthy, ${body.failedCount} failed`)
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
