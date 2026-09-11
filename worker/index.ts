/**
 * ChatDDB backend Worker — the router.
 *
 * This file does four things and nothing else: normalise the path, look the route
 * up in one table, apply that route's guard, and render whatever the handler
 * throws. All logic lives in `routes/*`, all data access in `db/*`.
 *
 * ## The guard is a type, not a habit
 *
 * Every entry in `ROUTES` declares `guard: 'public' | 'user' | 'admin'`, and a
 * `'user'`/`'admin'` handler is typed to take an `AuthedContext` — which only
 * `requireAuth`/`requireAdmin` can produce. So a new route cannot forget to
 * authenticate: a handler that touches `ctx.user` will not compile as `'public'`.
 *
 * ## Ordering
 *
 * Literal segments are listed before parameterised ones (`/api/sessions/import`
 * above `/api/sessions/:id`), and the first match wins. `:id` also has to be a
 * UUID, so the two could not collide anyway — the ordering is for clarity.
 *
 * Everything that is not `/api/*` falls through to the static SPA in dist/ via
 * `run_worker_first: ["/api/*"]` in wrangler.jsonc, so a non-API path arriving
 * here means the asset handler already passed on it.
 */

import { NotConfiguredError, resolveConfig } from './provider.ts'
import { imageFallbackReady, imageReady, resolvePollinations } from './images.ts'
import { bucketReady, dbReady } from './db/client.ts'
import { errorResponse, json, methodNotAllowed, preflight } from './lib/http.ts'
import {
  buildContext,
  requireAdmin,
  requireAuth,
  type AuthedContext,
  type RequestContext,
} from './auth/middleware.ts'
import type { WorkerEnv } from './env.ts'
import * as auth from './routes/auth.ts'
import * as chat from './routes/chat.ts'
import * as services from './routes/services.ts'
import * as adminAi from './routes/adminAi.ts'
import * as sessions from './routes/sessions.ts'
import * as files from './routes/files.ts'
import * as images from './routes/images.ts'
import * as admin from './routes/admin.ts'

type Handler<C> = (ctx: C, id: string) => Response | Promise<Response>

interface PublicRoute {
  method: string
  pattern: string
  guard: 'public'
  handler: Handler<RequestContext>
}

interface GuardedRoute {
  method: string
  pattern: string
  guard: 'user' | 'admin'
  handler: Handler<AuthedContext>
}

type Route = PublicRoute | GuardedRoute

/**
 * The whole API surface.
 *
 * Worth reading as a privacy summary: the only `public` entries are a health
 * check, service discovery, the sign-in exchange, and the HMAC-signed file view
 * (whose signature is its authorisation). Everything that touches a conversation,
 * a file, or a user record is behind `user` or `admin`.
 */
const ROUTES: Route[] = [
  // ---- Public -------------------------------------------------------------
  { method: 'GET', pattern: '/api/health', guard: 'public', handler: health },
  { method: 'GET', pattern: '/api/ai-services', guard: 'public', handler: services.getAiServices },
  { method: 'GET', pattern: '/api/models', guard: 'public', handler: services.getLegacyModels },
  { method: 'POST', pattern: '/api/auth/session', guard: 'public', handler: auth.postSession },
  { method: 'GET', pattern: '/api/files/view', guard: 'public', handler: files.viewFile },

  // ---- Signed in ----------------------------------------------------------
  { method: 'POST', pattern: '/api/auth/logout', guard: 'user', handler: auth.postLogout },
  { method: 'GET', pattern: '/api/me', guard: 'user', handler: auth.getMe },
  { method: 'POST', pattern: '/api/chat', guard: 'user', handler: chat.postChat },
  { method: 'POST', pattern: '/api/images', guard: 'user', handler: images.postImage },

  { method: 'GET', pattern: '/api/sessions', guard: 'user', handler: sessions.listSessions },
  { method: 'POST', pattern: '/api/sessions', guard: 'user', handler: sessions.createSession },
  { method: 'POST', pattern: '/api/sessions/import', guard: 'user', handler: sessions.importSessions },
  { method: 'GET', pattern: '/api/sessions/:id', guard: 'user', handler: sessions.getSession },
  { method: 'PATCH', pattern: '/api/sessions/:id', guard: 'user', handler: sessions.renameSession },
  { method: 'DELETE', pattern: '/api/sessions/:id', guard: 'user', handler: sessions.deleteSession },

  { method: 'GET', pattern: '/api/files', guard: 'user', handler: files.listFiles },
  { method: 'POST', pattern: '/api/files', guard: 'user', handler: files.postUpload },
  { method: 'GET', pattern: '/api/files/:id', guard: 'user', handler: files.getFile },
  { method: 'DELETE', pattern: '/api/files/:id', guard: 'user', handler: files.deleteFile },
  { method: 'GET', pattern: '/api/files/:id/url', guard: 'user', handler: files.getFileUrl },

  // ---- Admin --------------------------------------------------------------
  { method: 'GET', pattern: '/api/admin/stats', guard: 'admin', handler: admin.getStats },
  { method: 'GET', pattern: '/api/admin/users', guard: 'admin', handler: admin.listUsers },
  { method: 'GET', pattern: '/api/admin/users/:id', guard: 'admin', handler: admin.getUser },
  { method: 'PATCH', pattern: '/api/admin/users/:id', guard: 'admin', handler: admin.patchUser },
  { method: 'GET', pattern: '/api/admin/activity', guard: 'admin', handler: admin.getActivity },
  { method: 'GET', pattern: '/api/admin/sessions', guard: 'admin', handler: admin.listAdminSessions },
  { method: 'GET', pattern: '/api/admin/sessions/:id', guard: 'admin', handler: admin.getAdminSession },
  { method: 'GET', pattern: '/api/admin/files', guard: 'admin', handler: admin.listAdminFiles },
  { method: 'GET', pattern: '/api/admin/files/:id/url', guard: 'admin', handler: admin.getAdminFileUrl },
  { method: 'GET', pattern: '/api/admin/files/:id/text', guard: 'admin', handler: admin.getAdminFileText },

  // ---- Admin: AI Services & Routing ---------------------------------------
  { method: 'GET', pattern: '/api/admin/ai-services', guard: 'admin', handler: adminAi.listAdminServices },
  { method: 'POST', pattern: '/api/admin/ai-services', guard: 'admin', handler: adminAi.createAdminService },
  { method: 'PATCH', pattern: '/api/admin/ai-services/:id', guard: 'admin', handler: adminAi.patchAdminService },
  { method: 'DELETE', pattern: '/api/admin/ai-services/:id', guard: 'admin', handler: adminAi.deleteAdminService },

  { method: 'POST', pattern: '/api/admin/api-providers/:id/test', guard: 'admin', handler: adminAi.testAdminProvider },
  { method: 'GET', pattern: '/api/admin/api-providers', guard: 'admin', handler: adminAi.listAdminProviders },
  { method: 'POST', pattern: '/api/admin/api-providers', guard: 'admin', handler: adminAi.createAdminProvider },
  { method: 'PATCH', pattern: '/api/admin/api-providers/:id', guard: 'admin', handler: adminAi.patchAdminProvider },
  { method: 'DELETE', pattern: '/api/admin/api-providers/:id', guard: 'admin', handler: adminAi.deleteAdminProvider },

  { method: 'POST', pattern: '/api/admin/ai-routes/:id/test', guard: 'admin', handler: adminAi.testAdminRoute },
  { method: 'GET', pattern: '/api/admin/ai-routes', guard: 'admin', handler: adminAi.listAdminRoutes },
  { method: 'POST', pattern: '/api/admin/ai-routes', guard: 'admin', handler: adminAi.createAdminRoute },
  { method: 'PATCH', pattern: '/api/admin/ai-routes/:id', guard: 'admin', handler: adminAi.patchAdminRoute },
  { method: 'DELETE', pattern: '/api/admin/ai-routes/:id', guard: 'admin', handler: adminAi.deleteAdminRoute },

  { method: 'POST', pattern: '/api/admin/verify-all', guard: 'admin', handler: adminAi.verifyAllRoutes },
  { method: 'GET', pattern: '/api/admin/ai-health', guard: 'admin', handler: adminAi.getAdminAiHealth },
]

export default {
  async fetch(request: Request, env: WorkerEnv, exec: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = normalise(url.pathname)

    if (!path.startsWith('/api/')) {
      return json({ error: { message: 'Not found', type: 'not_found' } }, 404, request, env)
    }
    if (request.method === 'OPTIONS') return preflight(request, env)

    // Tracks whether the path existed at all, so a wrong method gets a 405 with
    // an accurate `Allow` header instead of a misleading 404.
    const allowed = new Set<string>()
    let matched: { route: Route; id: string } | null = null

    for (const route of ROUTES) {
      const id = match(route.pattern, path)
      if (id === null) continue
      allowed.add(route.method)
      if (route.method === request.method && !matched) matched = { route, id }
    }

    if (!matched) {
      if (allowed.size > 0) return methodNotAllowed(request, env, [...allowed].sort().join(', '))
      return json(
        { error: { message: `Unknown endpoint ${path}`, type: 'not_found' } },
        404,
        request,
        env,
      )
    }

    try {
      const ctx = await buildContext(request, env, exec)
      const { route, id } = matched
      if (route.guard === 'public') return await route.handler(ctx, id)
      const authed = route.guard === 'admin' ? await requireAdmin(ctx) : await requireAuth(ctx)
      return await route.handler(authed, id)
    } catch (err) {
      return errorResponse(err, request, env)
    }
  },
} satisfies ExportedHandler<WorkerEnv>

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Drops a trailing slash so `/api/sessions/` and `/api/sessions` are one route. */
function normalise(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

/**
 * Matches a path against a pattern, returning the `:id` segment.
 *
 * Returns `''` for a pattern with no parameter and `null` for no match, so the
 * caller can distinguish "matched with no id" from "did not match" — which
 * `!id` alone could not.
 */
function match(pattern: string, path: string): string | null {
  const want = pattern.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return null

  let id = ''
  for (let i = 0; i < want.length; i++) {
    if (want[i] === ':id') {
      const segment = got[i]
      if (!segment) return null
      id = segment
      continue
    }
    if (want[i] !== got[i]) return null
  }
  return id
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Readiness for every dependency, in one unauthenticated request.
 *
 * Unauthenticated on purpose: this is the endpoint you need *when auth is the
 * thing that is broken*. It therefore reports only booleans and names of missing
 * variables — never a key, a value, or a count of anything real.
 *
 * `ok` and `configured` keep their pre-Phase-2 meaning ("can this Worker answer a
 * chat request?") because `smoke-backend.mjs` gates on `configured` and would
 * otherwise pass against a deployment that cannot sign in.
 */
async function health(ctx: RequestContext): Promise<Response> {
  const rawKey = ctx.env.CODECRAFT_API_KEY?.trim()
  const cleanKey = rawKey ? rawKey.replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim() : undefined
  const codecraftConfigured = Boolean(cleanKey && cleanKey !== 'cc-replace-me')
  let agentrouterConfigured = true
  let detail: string | undefined
  try {
    resolveConfig(ctx.env)
  } catch (err) {
    agentrouterConfigured = false
    detail = err instanceof NotConfiguredError || err instanceof Error ? err.message : String(err)
  }
  const configured = agentrouterConfigured || codecraftConfigured

  const [db, r2] = await Promise.all([dbReady(ctx.env.DB), bucketReady(ctx.env.FILES)])

  const imageFallback = resolvePollinations(ctx.env)

  const missing: string[] = []
  if (!ctx.env.DB) missing.push('DB binding')
  if (!ctx.env.FILES) missing.push('FILES binding')
  if (!ctx.env.FIREBASE_PROJECT_ID) missing.push('FIREBASE_PROJECT_ID')
  if (!ctx.env.FILE_URL_SECRET) missing.push('FILE_URL_SECRET')
  if (!ctx.env.IP_HASH_SALT) missing.push('IP_HASH_SALT (optional)')
  if (ctx.env.POLLINATIONS_ENABLED?.trim() !== 'false' && !ctx.env.POLLINATIONS_API_KEY?.trim()) {
    missing.push('POLLINATIONS_API_KEY (optional; image fallback unconfigured)')
  }

  return json(
    {
      ok: true,
      service: 'chat',
      platform: 'ChatDDB',
      configured,
      ...(detail && !configured ? { detail } : {}),
      ready: {
        upstream: configured,
        db,
        r2,
        auth: Boolean(ctx.env.FIREBASE_PROJECT_ID),
        signedUrls: Boolean(ctx.env.FILE_URL_SECRET),
        image: imageReady(ctx.env),
        imageFallback: imageFallbackReady(ctx.env),
      },
      ...(missing.length > 0 ? { missing } : {}),
      ...(imageFallback
        ? { imageFallbackProvider: imageFallback.provider, imageFallbackModel: imageFallback.model }
        : {}),
      pdfExtractMode: ctx.policy.pdfExtractMode,
    },
    200,
    ctx.request,
    ctx.env,
  )
}
