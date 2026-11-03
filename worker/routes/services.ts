/**
 * Public service-discovery endpoints for AI services.
 * Served directly from worker/catalog.ts with zero database queries.
 */

import { json } from '../lib/http.ts'
import { MODELS } from '../catalog.ts'
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
 * `GET /api/ai-services` — Canonical public service-discovery endpoint.
 * Cached for 5 minutes (Cache-Control: public, max-age=300).
 */
export async function getAiServices(ctx: RequestContext): Promise<Response> {
  const defaultModel = MODELS.find((m) => m.default) ?? MODELS[0]
  const publicServices: PublicAiService[] = MODELS.map((m) => ({
    id: m.key,
    name: m.name,
    description: m.description,
    vision: m.capabilities.vision,
    documents: m.capabilities.documents,
    reasoning: m.capabilities.reasoning,
    tools: m.capabilities.tools,
    default: m.key === defaultModel.key,
  }))

  const res = json({ services: publicServices }, 200, ctx.request, ctx.env)
  res.headers.set('Cache-Control', 'public, max-age=300')
  return res
}

/**
 * `GET /api/models` — Backward compatibility endpoint.
 * Cached for 5 minutes (Cache-Control: public, max-age=300).
 */
export async function getLegacyModels(ctx: RequestContext): Promise<Response> {
  const defaultModel = MODELS.find((m) => m.default) ?? MODELS[0]
  const models = MODELS.map((m) => ({
    id: m.key,
    name: m.name,
    label: m.name,
    short: m.name,
    modelId: m.name,
    vision: m.capabilities.vision,
    documents: m.capabilities.documents,
    reasoning: m.capabilities.reasoning,
    tools: m.capabilities.tools,
    default: m.key === defaultModel.key,
    description: m.description,
  }))

  const res = json(
    {
      models,
      default: defaultModel.key,
    },
    200,
    ctx.request,
    ctx.env,
  )
  res.headers.set('Cache-Control', 'public, max-age=300')
  return res
}
