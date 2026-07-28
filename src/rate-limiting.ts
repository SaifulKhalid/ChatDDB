/**
 * Rate limiting and guest quota enforcement.
 *
 * Extracted from index.ts for testability.
 */
import type { Env } from "./types";

/* ─── Rate Limiting ─────────────────────────────────── */

export const DEFAULT_RATE_LIMIT_MAX = 60;
export const DEFAULT_RATE_LIMIT_WINDOW = 60; // seconds

/**
 * Check rate limit for a given identifier and endpoint.
 * Uses D1 to track request counts per window.
 * Returns a Response (429) if rate limited, or null if allowed.
 */
export async function checkRateLimit(
  identifier: string,
  endpoint: string,
  env: Env
): Promise<Response | null> {
  const maxReq = parseInt(env.RATE_LIMIT_MAX || String(DEFAULT_RATE_LIMIT_MAX), 10);
  const windowSec = parseInt(env.RATE_LIMIT_WINDOW || String(DEFAULT_RATE_LIMIT_WINDOW), 10);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSec) * windowSec;

  try {
    // Upsert the rate limit counter
    const result = await env.DB.prepare(
      `INSERT INTO rate_limits (identifier, endpoint, window_start, request_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(identifier, endpoint, window_start)
       DO UPDATE SET request_count = request_count + 1
       RETURNING request_count`
    ).bind(identifier, endpoint, windowStart).first<{ request_count: number }>();

    if (result && result.request_count > maxReq) {
      return rateLimitResponse(maxReq, windowStart + windowSec - now);
    }
  } catch {
    // If rate limiting DB fails, allow through (better than blocking everyone)
  }

  return null;
}

/** Build the HTTP 429 rate limit response. */
export function rateLimitResponse(
  maxAllowed: number,
  retryAfterSec: number
): Response {
  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded. Please slow down and try again.",
      code: "RATE_LIMITED",
      maxAllowed,
      retryAfter: retryAfterSec,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
        ...corsHeaders(),
      },
    }
  );
}

/**
 * Determine the rate limit identifier for a request.
 * Authenticated users are identified by UID; unauthenticated by IP.
 */
export function rateLimitIdentifier(req: Request, user?: { uid?: string }): string {
  if (user?.uid) return "user:" + user.uid;
  const cfIp = (req as any).cf?.ip || req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For") || "unknown";
  return "ip:" + cfIp;
}

/* ─── Guest Quota Enforcement ──────────────────────── */

export const GUEST_MAX_MESSAGES = 10;
export const GUEST_MAX_UPLOADS = 2;
export const GUEST_MAX_IMAGE_GENS = 2;

/**
 * Get a guest's current usage for a resource type from D1.
 * Returns the number used so far, or 0 if not found.
 */
export async function getGuestUsage(clientId: string, resourceType: string, env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      "SELECT used FROM guest_usage WHERE client_id = ? AND resource_type = ?"
    ).bind(clientId, resourceType).first<{ used: number }>();
    return row?.used || 0;
  } catch {
    return 0;
  }
}

/**
 * Increment guest usage for a resource type in D1.
 * Returns a promise that resolves when the increment is complete.
 */
export function incrementGuestUsage(clientId: string, resourceType: string, env: Env): Promise<void> {
  return env.DB.prepare(
    `INSERT INTO guest_usage (client_id, resource_type, used, last_used_at)
     VALUES (?, ?, 1, unixepoch())
     ON CONFLICT(client_id, resource_type)
     DO UPDATE SET used = used + 1, last_used_at = unixepoch()`
  ).bind(clientId, resourceType).run().then(() => {});
}

/**
 * Check if a guest has exceeded their quota for a given resource.
 * Returns a Response (403) if quota exceeded, or null if allowed.
 */
export async function checkGuestQuota(
  clientId: string | undefined,
  resourceType: 'chat' | 'upload' | 'image_gen',
  env: Env
): Promise<Response | null> {
  if (!clientId) return null; // No client ID means we can't enforce — allow through

  const maxMap: Record<string, number> = {
    chat: parseInt(env.GUEST_MAX_MESSAGES || String(GUEST_MAX_MESSAGES), 10),
    upload: parseInt(env.GUEST_MAX_UPLOADS || String(GUEST_MAX_UPLOADS), 10),
    image_gen: parseInt(env.GUEST_MAX_IMAGE_GENS || String(GUEST_MAX_IMAGE_GENS), 10),
  };
  const maxAllowed = maxMap[resourceType] || 10;

  const used = await getGuestUsage(clientId, resourceType, env);
  if (used >= maxAllowed) {
    return guestQuotaExceededResponse(resourceType, used, maxAllowed);
  }

  return null;
}

/** Build the HTTP 403 guest quota exceeded response. */
export function guestQuotaExceededResponse(
  resourceType: string,
  used: number,
  maxAllowed: number
): Response {
  return new Response(
    JSON.stringify({
      error: `Guest quota exceeded for ${resourceType}. Please sign in to continue.`,
      code: "GUEST_QUOTA_EXCEEDED",
      resourceType,
      used,
      maxAllowed,
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(),
      },
    }
  );
}

/* ─── Helpers ───────────────────────────────────────── */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}
