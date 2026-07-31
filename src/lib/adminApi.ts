/**
 * Typed wrappers for `/api/admin/*` endpoints.
 *
 * All methods require the caller to be authenticated as an admin — the
 * Worker enforces this server-side via `requireAdmin`. The client-side
 * route guard in App.tsx is cosmetic only.
 *
 * Every interface below is transcribed field-for-field from
 * `worker/routes/admin.ts` and the `db/*` helpers it returns. These are the only
 * contract the client has: `tsc` cannot catch a name that drifts from the
 * Worker, so a rename on either side has to be mirrored here by hand.
 */

import { apiJson } from './apiClient'
import type {
  PublicFile,
  PublicUser,
  SessionSummary,
  SignedViewUrl,
  TranscriptMessage,
  UsageSummary,
} from './apiTypes'

/** `worker/db/users.ts` → `PlatformStats`. */
export interface AdminPlatformStats {
  totalUsers: number
  activeUsers: number
  suspendedUsers: number
  adminUsers: number
  newUsersToday: number
  totalSessions: number
  totalMessages: number
  messagesToday: number
  totalFiles: number
  storageBytes: number
  /** Distinct users with a message per day, oldest first. 14 days. */
  dau: { day: number; users: number }[]
}

/** `worker/db/files.ts` → `StorageStats`. */
export interface AdminStorageStats {
  totalFiles: number
  totalBytes: number
  images: number
  pdfs: number
  pendingProcessing: number
  failedProcessing: number
  /** Files with no `message_id` older than 24h. */
  orphans: number
  topUsers: { userId: string; email: string | null; files: number; bytes: number }[]
}

/** `GET /api/admin/stats`. */
export interface AdminStats {
  platform: AdminPlatformStats
  storage: AdminStorageStats
  /** `activity.actionCounts` — an ARRAY, not a map. Last 7 days. */
  actions: { action: string; n: number }[]
  generatedAt: number
}

/** The user shape in `GET /api/admin/users/:id` — no `counts`. */
export interface AdminUserBase extends PublicUser {
  loginCount: number
}

/** `GET /api/admin/users` row. */
export interface AdminUserRow extends AdminUserBase {
  counts: { sessions: number; messages: number; files: number }
}

/** `GET /api/admin/users` */
export interface AdminUserList {
  users: AdminUserRow[]
  total: number
  limit: number
  offset: number
}

/** `GET /api/admin/users/:id` */
export interface AdminUserDetail {
  user: AdminUserBase
  usage: UsageSummary
  activity: AdminActivityRow[]
  sessions: AdminSessionSummary[]
}

/**
 * `worker/routes/admin.ts` → `PublicActivity`.
 *
 * `timestamp`, not `createdAt` — the column is `activity_logs.timestamp`.
 * `user` is only joined on `GET /api/admin/activity`; the copy embedded in a
 * user detail drawer omits it, hence optional.
 */
export interface AdminActivityRow {
  id: string
  action: string
  severity: 'info' | 'warn' | 'alert'
  timestamp: number
  metadata: unknown
  ipHash: string | null
  userAgent: string | null
  user?: { id: string; email: string; name: string | null } | null
}

/** `GET /api/admin/activity` */
export interface AdminActivityList {
  activity: AdminActivityRow[]
  total: number
  limit: number
  offset: number
  /** `ACTIVITY_ACTIONS` — the only values the `action` filter accepts. */
  actions: string[]
}

/** A session with its soft-delete stamp, as returned by the admin routes. */
export interface AdminSessionSummary extends SessionSummary {
  deletedAt: number | null
}

/** `GET /api/admin/sessions` row. */
export interface AdminSessionRow extends AdminSessionSummary {
  user: { id: string; email: string; name: string | null }
}

/** `GET /api/admin/sessions` */
export interface AdminSessionList {
  sessions: AdminSessionRow[]
  total: number
  limit: number
  offset: number
}

/** A transcript message, with the admin-only token accounting. */
export interface AdminTranscriptMessage extends TranscriptMessage {
  tokens: {
    prompt: number | null
    completion: number | null
    total: number | null
    source: string | null
  }
}

/**
 * `GET /api/admin/sessions/:id`
 *
 * `user` is nullable: the owner row can be gone while a soft-deleted session
 * survives, and this endpoint deliberately still returns the transcript.
 */
export interface AdminTranscript {
  session: AdminSessionSummary
  user: PublicUser | null
  messages: AdminTranscriptMessage[]
  audited: true
}

/** `GET /api/admin/files` row */
export interface AdminFileRow extends PublicFile {
  sessionId: string | null
  messageId: string | null
  sha256: string
  user: { id: string; email: string; name: string | null }
}

/** `GET /api/admin/files` */
export interface AdminFileList {
  files: AdminFileRow[]
  total: number
  limit: number
  offset: number
}

/** `GET /api/admin/files/:id/text` */
export interface AdminFileText {
  preview: string | null
  chars: number | null
  pages: number | null
  source: 'client' | 'worker' | null
  status: 'none' | 'pending' | 'done' | 'failed'
  truncated: boolean
  audited: true
}

function clean<T extends Record<string, string | number | boolean | undefined | null>>(
  q: T,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '' && v !== false) out[k] = String(v)
  }
  return out
}

export const adminApi = {
  stats: () => apiJson<AdminStats>('/api/admin/stats'),

  users: (q: { search?: string; status?: string; role?: string; limit?: number; offset?: number } = {}) =>
    apiJson<AdminUserList>(`/api/admin/users?${new URLSearchParams(clean(q))}`),

  user: (id: string) => apiJson<AdminUserDetail>(`/api/admin/users/${id}`),

  patchUser: (id: string, body: { status?: 'active' | 'suspended'; role?: 'user' | 'admin' }) =>
    apiJson<{ user: PublicUser; changed: boolean; changes?: Record<string, unknown> }>(
      `/api/admin/users/${id}`,
      { method: 'PATCH', json: body },
    ),

  activity: (
    q: {
      userId?: string
      action?: string
      severity?: string
      from?: number
      to?: number
      limit?: number
      offset?: number
    } = {},
  ) => apiJson<AdminActivityList>(`/api/admin/activity?${new URLSearchParams(clean(q))}`),

  sessions: (
    q: { userId?: string; search?: string; includeDeleted?: boolean; limit?: number; offset?: number } = {},
  ) =>
    apiJson<AdminSessionList>(
      `/api/admin/sessions?${new URLSearchParams(clean({ ...q, includeDeleted: q.includeDeleted ? '1' : undefined }))}`,
    ),

  session: (id: string) => apiJson<AdminTranscript>(`/api/admin/sessions/${id}`),

  files: (
    q: { userId?: string; search?: string; type?: string; processing?: string; limit?: number; offset?: number } = {},
  ) => apiJson<AdminFileList>(`/api/admin/files?${new URLSearchParams(clean(q))}`),

  fileUrl: (id: string) => apiJson<SignedViewUrl & { audited: true }>(`/api/admin/files/${id}/url`),

  fileText: (id: string) => apiJson<AdminFileText>(`/api/admin/files/${id}/text`),
}
