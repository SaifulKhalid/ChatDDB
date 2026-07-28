/**
 * Guest mode store — manages unauthenticated user quotas and local message storage.
 * All state is persisted in localStorage to survive page refreshes.
 */
import { create } from "zustand";
import type { ChatMessage } from "@/lib/api";

/* ─── Constants ─────────────────────────────────────── */

const GUEST_QUOTA = {
  maxMessages: 10,
  maxFileUploads: 2,
  maxImageGens: 2,
};

const STORAGE_KEYS = {
  enabled: "chatddb-guest-enabled",
  messages: "chatddb-guest-messages",
  messageCount: "chatddb-guest-msg-count",
  fileUploadCount: "chatddb-guest-file-count",
  imageGenCount: "chatddb-guest-img-count",
} as const;

/* ─── Helpers ────────────────────────────────────────── */

function loadFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const val = localStorage.getItem(key);
    if (val === null) return fallback;
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

/** Generate or retrieve a persistent anonymous client ID for guest requests. */
export function getGuestClientId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    let id = sessionStorage.getItem("chatddb-guest-cid");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("chatddb-guest-cid", id);
    }
    return id;
  } catch {
    return null;
  }
}

function saveToStorage(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota exceeded — silently ignore */ }
}

/* ─── Types ──────────────────────────────────────────── */

interface GuestState {
  /** Whether guest mode is active */
  isGuest: boolean;
  /** Guest chat messages stored locally */
  messages: ChatMessage[];
  /** Number of messages sent in this session */
  messageCount: number;
  /** Number of file uploads used */
  fileUploadCount: number;
  /** Number of image generations used */
  imageGenCount: number;

  /** Max quotas (read-only) */
  readonly maxMessages: number;
  readonly maxFileUploads: number;
  readonly maxImageGens: number;

  /** Enable guest mode, restoring any saved state */
  enableGuestMode: () => void;
  /** Disable guest mode and clear storage */
  disableGuestMode: () => void;
  /** Add a message (increments count, saves to localStorage) */
  addMessage: (msg: ChatMessage) => void;
  /** Set all messages (e.g. when loading) */
  setMessages: (msgs: ChatMessage[]) => void;
  /** Try to add a file upload. Returns false if quota exceeded. */
  tryAddFileUpload: () => boolean;
  /** Try to add an image generation. Returns false if quota exceeded. */
  tryAddImageGen: () => boolean;
  /** Get remaining message count */
  remainingMessages: () => number;
  /** Get remaining file uploads */
  remainingFileUploads: () => number;
  /** Get remaining image generations */
  remainingImageGens: () => number;
  /** Whether the guest has exhausted all quotas */
  isQuotaExhausted: () => boolean;
  /** Reset all guest quotas */
  resetQuota: () => void;
}

/* ─── Store ──────────────────────────────────────────── */

export const useGuestStore = create<GuestState>((set, get) => ({
  isGuest: loadFromStorage<boolean>(STORAGE_KEYS.enabled, false),
  messages: loadFromStorage<ChatMessage[]>(STORAGE_KEYS.messages, []),
  messageCount: loadFromStorage<number>(STORAGE_KEYS.messageCount, 0),
  fileUploadCount: loadFromStorage<number>(STORAGE_KEYS.fileUploadCount, 0),
  imageGenCount: loadFromStorage<number>(STORAGE_KEYS.imageGenCount, 0),

  maxMessages: GUEST_QUOTA.maxMessages,
  maxFileUploads: GUEST_QUOTA.maxFileUploads,
  maxImageGens: GUEST_QUOTA.maxImageGens,

  enableGuestMode: () => {
    set({
      isGuest: true,
      messages: loadFromStorage<ChatMessage[]>(STORAGE_KEYS.messages, []),
      messageCount: loadFromStorage<number>(STORAGE_KEYS.messageCount, 0),
      fileUploadCount: loadFromStorage<number>(STORAGE_KEYS.fileUploadCount, 0),
      imageGenCount: loadFromStorage<number>(STORAGE_KEYS.imageGenCount, 0),
    });
    saveToStorage(STORAGE_KEYS.enabled, true);
  },

  disableGuestMode: () => {
    set({
      isGuest: false,
      messages: [],
      messageCount: 0,
      fileUploadCount: 0,
      imageGenCount: 0,
    });
    // Clear all guest storage
    Object.values(STORAGE_KEYS).forEach((key) => {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    });
  },

  addMessage: (msg: ChatMessage) => {
    const state = get();
    const newCount = state.messageCount + 1;
    const newMessages = [...state.messages, msg];
    set({ messageCount: newCount, messages: newMessages });
    saveToStorage(STORAGE_KEYS.messageCount, newCount);
    saveToStorage(STORAGE_KEYS.messages, newMessages);
  },

  setMessages: (msgs: ChatMessage[]) => {
    // Calculate message count as number of chat turns (user+assistant = 1 turn)
    const messageCount = Math.ceil(msgs.length / 2);
    set({ messages: msgs, messageCount });
    saveToStorage(STORAGE_KEYS.messages, msgs);
    saveToStorage(STORAGE_KEYS.messageCount, messageCount);
  },

  tryAddFileUpload: () => {
    const state = get();
    if (state.fileUploadCount >= GUEST_QUOTA.maxFileUploads) return false;
    const newCount = state.fileUploadCount + 1;
    set({ fileUploadCount: newCount });
    saveToStorage(STORAGE_KEYS.fileUploadCount, newCount);
    return true;
  },

  tryAddImageGen: () => {
    const state = get();
    if (state.imageGenCount >= GUEST_QUOTA.maxImageGens) return false;
    const newCount = state.imageGenCount + 1;
    set({ imageGenCount: newCount });
    saveToStorage(STORAGE_KEYS.imageGenCount, newCount);
    return true;
  },

  remainingMessages: () => {
    return Math.max(0, GUEST_QUOTA.maxMessages - get().messageCount);
  },

  remainingFileUploads: () => {
    return Math.max(0, GUEST_QUOTA.maxFileUploads - get().fileUploadCount);
  },

  remainingImageGens: () => {
    return Math.max(0, GUEST_QUOTA.maxImageGens - get().imageGenCount);
  },

  isQuotaExhausted: () => {
    const s = get();
    return s.messageCount >= GUEST_QUOTA.maxMessages;
  },

  resetQuota: () => {
    set({
      messageCount: 0,
      fileUploadCount: 0,
      imageGenCount: 0,
      messages: [],
    });
    Object.values(STORAGE_KEYS).forEach((key) => {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    });
  },
}));
