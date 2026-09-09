/**
 * Public service-discovery endpoints for AI services.
 *
 * Enforces the strict public boundary:
 *  - Only public AI services (ChatGPT, Gemini, Grok, Claude, DeepSeek, GLM) are returned.
 *  - No routes, providers, upstream model IDs, health, circuits, or backend implementations are ever exposed.
 */

import { json } from '../lib/http.ts'
import { listServices, type ServiceCapabilities } from '../db/aiRouting.ts'
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
 */
export async function getAiServices(ctx: RequestContext): Promise<Response> {
  const services = await listServices(ctx.env.DB, false)

  const publicServices: PublicAiService[] = services.map((s) => {
    let caps: ServiceCapabilities = {}
    try {
      caps = JSON.parse(s.capabilities) as ServiceCapabilities
    } catch {
      caps = {}
    }

    return {
      id: s.key,
      name: s.public_name,
      description: s.description,
      vision: Boolean(caps.vision),
      documents: caps.documents !== false,
      reasoning: Boolean(caps.reasoning),
      tools: caps.tools !== false,
      default: s.default_service === 1,
    }
  })

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
 * Formats public AI services into the legacy model shape expected by older clients
 * without ever exposing private upstream model identifiers.
 */
export async function getLegacyModels(ctx: RequestContext): Promise<Response> {
  const services = await listServices(ctx.env.DB, false)
  const defaultService = services.find((s) => s.default_service === 1) ?? services[0]

  const models = services.map((s) => {
    let caps: ServiceCapabilities = {}
    try {
      caps = JSON.parse(s.capabilities) as ServiceCapabilities
    } catch {
      caps = {}
    }

    return {
      id: s.key,
      name: s.public_name,
      label: s.public_name,
      short: s.public_name,
      modelId: s.public_name, // Public name only, never raw upstream model
      vision: Boolean(caps.vision),
      documents: caps.documents !== false,
      reasoning: Boolean(caps.reasoning),
      default: s.default_service === 1,
      description: s.description ?? undefined,
    }
  })

  return json(
    {
      models,
      default: defaultService ? defaultService.key : 'deepseek',
    },
    200,
    ctx.request,
    ctx.env,
  )
}
