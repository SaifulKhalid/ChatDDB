/**
 * Public service-discovery endpoints for AI services.
 *
 * Enforces the strict public boundary:
 *  - Only public AI services (ChatGPT, Gemini, Grok, Claude, DeepSeek, GLM) are returned.
 *  - No routes, providers, upstream model IDs, health, circuits, or backend implementations are ever exposed.
 */

import { json } from '../lib/http.ts'
import { listLiveServices, toPublicCapabilities } from '../db/aiRouting.ts'
import type { RequestContext } from '../auth/middleware.ts'

export interface PublicAiService {
  id: string
  name: string
  description: string | null
  vision: boolean
  documents: boolean
  reasoning: boolean
  tools: boolean
  default: boolean
}

/**
 * `GET /api/ai-services` — The canonical public service-discovery endpoint.
 * Only returns live, working AI services (status !== 'down').
 */
export async function getAiServices(ctx: RequestContext): Promise<Response> {
  const services = await listLiveServices(ctx.env.DB)
  const defaultService = services.find((s) => s.default_service === 1) ?? services[0]

  const publicServices: PublicAiService[] = services.map((s) => ({
    id: s.key,
    name: s.public_name,
    description: s.description,
    ...toPublicCapabilities(s.capabilities),
    default: defaultService ? s.id === defaultService.id : false,
  }))

  return json(
    { services: publicServices },
    200,
    ctx.request,
    ctx.env,
  )
}

/**
 * `GET /api/models` — Backward compatibility endpoint.
 *
 * Formats public AI services into the legacy model shape expected by older
 * clients without ever exposing private upstream model identifiers. Only returns
 * live, working models.
 *
 * No in-tree client calls this: `/api/me` carries the same list on a response the
 * app already fetches, and `src/lib/api.ts` no longer ships a helper for it. It
 * stays mounted because it is a published contract with a strict public boundary,
 * and `scripts/smoke-ai-routing.mjs` asserts that boundary on every run.
 */
export async function getLegacyModels(ctx: RequestContext): Promise<Response> {
  const services = await listLiveServices(ctx.env.DB)
  const defaultService = services.find((s) => s.default_service === 1) ?? services[0]

  const models = services.map((s) => ({
    id: s.key,
    name: s.public_name,
    label: s.public_name,
    short: s.public_name,
    modelId: s.public_name, // Public name only, never raw upstream model
    ...toPublicCapabilities(s.capabilities),
    default: defaultService ? s.id === defaultService.id : false,
    description: s.description ?? undefined,
  }))

  return json(
    {
      models,
      default: defaultService ? defaultService.key : (models[0]?.id ?? 'deepseek'),
    },
    200,
    ctx.request,
    ctx.env,
  )
}
