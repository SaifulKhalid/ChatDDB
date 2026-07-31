#!/usr/bin/env node

/**
 * File upload smoke tests.
 *
 * Usage:
 *   CHATDDB_TOKEN=<id-token> node scripts/smoke-files.mjs
 *
 * Get a token from the browser console:
 *   await firebase.auth().currentUser.getIdToken()
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'
const TOKEN = process.env.CHATDDB_TOKEN

if (!TOKEN) {
  console.error('error: CHATDDB_TOKEN is required')
  process.exit(1)
}

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

// A valid 1×1 PNG (8 bytes of actual PNG data)
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  // Minimal IDAT chunk for a 1×1 red pixel
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x26, 0x13, 0xfe,
  0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
])

async function main() {
  console.log(`File smoke tests (${BASE})`)

  const headers = { Authorization: `Bearer ${TOKEN}` }
  let fileId = null

  // 1. Upload a valid PNG
  await test('POST /api/files (PNG) → 201', async () => {
    const form = new FormData()
    form.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'test.png')
    const res = await fetch(`${BASE}/api/files`, { method: 'POST', headers, body: form })
    if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}`)
    const body = await res.json()
    if (body?.file?.uploadStatus !== 'stored') throw new Error(`Expected stored, got ${body?.file?.uploadStatus}`)
    fileId = body.file.id
  })

  // 2. Upload a .txt renamed to .png — magic bytes don't match
  await test('POST /api/files (.txt→.png) → 400 unsupported_file_type', async () => {
    const form = new FormData()
    form.append('file', new Blob(['not a png'], { type: 'image/png' }), 'fake.png')
    const res = await fetch(`${BASE}/api/files`, { method: 'POST', headers, body: form })
    const body = await res.json()
    if (res.status !== 400 || body?.error?.type !== 'unsupported_file_type') {
      throw new Error(`Expected 400 unsupported_file_type, got ${res.status} ${body?.error?.type}`)
    }
  })

  // 3. Upload a PDF with extraction JSON
  // Minimal PDF: "%PDF-1.4" header + a single empty page
  const PDF_BYTES = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF',
  )

  let pdfFileId = null
  await test('POST /api/files (PDF + extraction) → 201', async () => {
    const form = new FormData()
    form.append('file', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'test.pdf')
    form.append('extraction', JSON.stringify({ text: 'Mock extracted text', pages: 1 }))
    const res = await fetch(`${BASE}/api/files`, { method: 'POST', headers, body: form })
    if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}`)
    const body = await res.json()
    if (body?.file?.extractionSource !== 'client') throw new Error(`Expected client source`)
    pdfFileId = body.file.id
  })

  // 4. Get signed URL
  if (fileId) {
    await test('GET /api/files/:id/url → 200, then fetch url → 200', async () => {
      const res = await fetch(`${BASE}/api/files/${fileId}/url`, { headers })
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
      const body = await res.json()
      if (!body.url) throw new Error('Missing url')
      // Fetch the signed URL
      const view = await fetch(`${BASE}${body.url}`)
      if (view.status !== 200) throw new Error(`Expected 200, got ${view.status}`)
      if (!view.headers.get('content-type')?.startsWith('image/')) {
        throw new Error(`Expected image content type`)
      }
    })
  }

  // 5. Tampered signature
  if (fileId) {
    await test('GET /api/files?tampered → 401 invalid_signature', async () => {
      const res = await fetch(`${BASE}/api/files/${fileId}/url`, { headers })
      const body = await res.json()
      const url = body.url
      // Replace the sig parameter with garbage
      const tampered = url.replace(/sig=[^&]+/, 'sig=deadbeef')
      const view = await fetch(`${BASE}${tampered}`)
      if (view.status !== 401) throw new Error(`Expected 401, got ${view.status}`)
      const errorBody = await view.json()
      if (errorBody?.error?.type !== 'invalid_signature') throw new Error('Expected invalid_signature type')
    })
  }

  // 6. Delete
  if (fileId) {
    await test('DELETE /api/files/:id → 200, then re-fetch → 404', async () => {
      const del = await fetch(`${BASE}/api/files/${fileId}`, { method: 'DELETE', headers })
      if (del.status !== 200) throw new Error(`Expected 200 on delete, got ${del.status}`)
      const get = await fetch(`${BASE}/api/files/${fileId}`, { headers })
      if (get.status !== 404) throw new Error(`Expected 404 after delete, got ${get.status}`)
    })
  }

  // Clean up PDF file
  if (pdfFileId) {
    await fetch(`${BASE}/api/files/${pdfFileId}`, { method: 'DELETE', headers }).catch(() => {})
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
