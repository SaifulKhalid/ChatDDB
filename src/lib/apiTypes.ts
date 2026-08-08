/**
 * The API's wire shapes, mirrored from the Worker.
 *
 * Hand-written rather than generated: the Worker and the frontend are separate
 * TypeScript projects (`worker/tsconfig.json` targets the Workers runtime, the
 * app targets the DOM), so importing across them would pull Workers globals into
 * the browser build. Keeping these declarations here is the seam.
 *
 * Each interface names its source, so a change on one side has an obvious
 * counterpart on the other. Fields that are optional here are optional in the
 * Worker's response too — never "optional because I was not sure".
 */

/** `worker/db/users.ts` → `PublicUser`. No `firebase_uid`, deliberately. */
export interface PublicUser {
  id: string
  email: string
  name: string | null
  picture: string | null
  role: 'user' | 'admin'
  status: 'active' | 'suspended'
  createdAt: number
  lastLogin: number | null
}

/** `worker/models.ts` → `ModelSpec`. */
export interface ModelSpec {
  id: string
  label: string
  provider: 'agentrouter'
  vision: boolean
  documents: boolean
  contextTokens: number
  maxOutputTokens: number
  reasoning: boolean
  default?: boolean
  note?: string
}

/** `worker/db/users.ts` → `UsageSummary`. */
export interface UsageSummary {
  sessions: number
  messages: number
  messagesToday: number
  files: number
  storageBytes: number
}

/** `worker/routes/auth.ts` → the `quota` block of `GET /api/me`. */
export interface Quota {
  chatPerDay: number
  chatUsedToday: number
  /** null when the daily chat limit is disabled (`RATE_CHAT_PER_DAY=0`). */
  chatRemainingToday: number | null
  uploadPerDay: number
  maxImageBytes: number
  maxPdfBytes: number
  maxAttachmentsPerMessage: number
  /** Generated images per day, per user. `0` disables the daily window. */
  imagePerDay: number
  imageUsedToday: number
  /** null when the daily image limit is disabled (`RATE_IMAGE_PER_DAY=0`). */
  imageRemainingToday: number | null
}

export type PdfExtractMode = 'client' | 'worker'

/** `POST /api/auth/session`. */
export interface SessionResponse {
  user: PublicUser
}

/** `GET /api/me`. */
export interface MeResponse {
  user: PublicUser
  usage: UsageSummary
  quota: Quota
  models: ModelSpec[]
  pdfExtractMode: PdfExtractMode
  /** False when the Worker has no `AI` binding, or `IMAGE_ENABLED` is "false". */
  imageGeneration: boolean
}

/** `GET /api/models`. */
export interface ModelsResponse {
  models: ModelSpec[]
  default: string
}

/** `worker/db/files.ts` → `PublicFile`. */
export interface PublicFile {
  id: string
  filename: string
  type: 'image' | 'pdf'
  mimeType: string
  size: number
  uploadStatus: 'pending' | 'stored' | 'failed'
  processingStatus: 'none' | 'pending' | 'done' | 'failed'
  extractedChars: number | null
  extractedPages: number | null
  extractionSource: 'client' | 'worker' | null
  /**
   * Where the bytes came from. `'generated'` renders full-size in the transcript
   * instead of as a 36px chip, so this is a display decision as much as a
   * provenance one. Only the Worker can set it.
   */
  origin: 'upload' | 'generated'
  /** The prompt that produced it. Non-null only for `origin: 'generated'`. */
  genPrompt: string | null
  genModel: string | null
  createdAt: number
}

/** `worker/db/sessions.ts` → `TitleSource`. */
export type TitleSource = 'placeholder' | 'auto' | 'manual'

/** `worker/db/sessions.ts` → `PublicSession`. The sidebar row. */
export interface SessionSummary {
  id: string
  title: string
  titleSource: TitleSource
  model: string | null
  messageCount: number
  createdAt: number
  updatedAt: number
}

/** `worker/routes/sessions.ts` → `TranscriptMessage`. */
export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  model?: string | null
  attachmentCount?: number
  error?: string | null
  finishReason?: string | null
  attachments: PublicFile[]
}

/** `GET /api/sessions`. */
export interface SessionListResponse {
  sessions: SessionSummary[]
  total: number
  limit: number
  offset: number
}

/** `GET /api/sessions/:id`. */
export interface TranscriptResponse {
  session: SessionSummary
  messages: TranscriptMessage[]
}

/** `POST /api/sessions`. */
export interface CreateSessionResponse {
  session: SessionSummary
}

/** `POST /api/sessions/import`. */
export interface ImportResponse {
  imported: { sessions: number; messages: number }
}

/** `POST /api/files`. */
export interface UploadResponse {
  file: PublicFile
}

/** `POST /api/images`. Plain JSON, not SSE — one image arrives in one shot. */
export interface ImageResponse {
  sessionId: string
  /** The assistant message the image is attached to. */
  messageId: string
  userMessageId: string
  file: PublicFile
}

/** `GET /api/files/:id/url`. */
export interface SignedViewUrl {
  url: string
  expiresAt: number
  mimeType: string
}
