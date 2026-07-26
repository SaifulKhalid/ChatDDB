import { create } from "zustand";
import type { ChatMessage, Conversation, ModelInfo, AttachmentMeta } from "@/lib/api";
import * as api from "@/lib/api";

/* ─── Types ─────────────────────────────────────────── */

interface ChatState {
  // Models
  models: ModelInfo[];
  currentModelId: string;
  modelsLoaded: boolean;

  // Conversations
  conversations: Conversation[];
  currentConversationId: string | null;
  activeConversationTitle: string;

  // Messages
  messages: ChatMessage[];

  // Streaming
  isStreaming: boolean;
  streamedContent: string;
  abortController: AbortController | null;

  // Pending attachments
  pendingAttachments: AttachmentMeta[];

  // Actions
  loadModels: () => Promise<void>;
  setCurrentModel: (id: string) => void;

  loadConversations: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  deleteConversation: (id: string) => Promise<void>;

  addPendingAttachment: (att: AttachmentMeta) => void;
  removePendingAttachment: (id: string) => void;

  sendMessage: (text: string) => Promise<void>;
  stopStreaming: () => void;
  appendToStream: (text: string) => void;
  finishStream: (fullText: string) => void;
  failStream: (error: string) => void;
}

/* ─── Store ─────────────────────────────────────────── */

export const useChatStore = create<ChatState>((set, get) => ({
  // State
  models: [],
  currentModelId: "",
  modelsLoaded: false,

  conversations: [],
  currentConversationId: null,
  activeConversationTitle: "ChatDDB",

  messages: [],

  isStreaming: false,
  streamedContent: "",
  abortController: null,

  pendingAttachments: [],

  // Actions
  loadModels: async () => {
    try {
      const models = await api.getModels();
      const saved = localStorage.getItem("chatddb-model") || "";
      const currentModelId =
        models.find((m) => m.id === saved)?.id || models[0]?.id || "";
      set({ models, currentModelId, modelsLoaded: true });
    } catch (err) {
      console.error("Failed to load models", err);
      set({ modelsLoaded: true });
    }
  },

  setCurrentModel: (id: string) => {
    localStorage.setItem("chatddb-model", id);
    set({ currentModelId: id });
    const { currentConversationId } = get();
    if (currentConversationId) {
      api.updateConversation(currentConversationId, { model: id }).catch(() => {});
    }
  },

  loadConversations: async () => {
    try {
      const conversations = await api.listConversations();
      set({ conversations });
    } catch (err) {
      console.error("Failed to load conversations", err);
    }
  },

  selectConversation: async (id: string) => {
    if (get().currentConversationId === id) return;
    try {
      const { conversation, messages } = await api.getConversation(id);
      set({
        currentConversationId: id,
        activeConversationTitle: conversation.title,
        messages,
      });
      if (
        conversation.model &&
        get().models.some((m) => m.id === conversation.model)
      ) {
        set({ currentModelId: conversation.model });
      }
    } catch (err) {
      console.error("Failed to load conversation", err);
    }
  },

  newConversation: () => {
    set({
      currentConversationId: null,
      activeConversationTitle: "ChatDDB",
      messages: [],
      pendingAttachments: [],
    });
  },

  addPendingAttachment: (att: AttachmentMeta) => {
    set((state) => ({
      pendingAttachments: [...state.pendingAttachments, att],
    }));
  },

  removePendingAttachment: (id: string) => {
    set((state) => ({
      pendingAttachments: state.pendingAttachments.filter((a) => a.id !== id),
    }));
  },

  deleteConversation: async (id: string) => {
    try {
      await api.deleteConversation(id);
      const { currentConversationId } = get();
      if (currentConversationId === id) {
        get().newConversation();
      }
      get().loadConversations();
    } catch (err) {
      console.error("Failed to delete conversation", err);
    }
  },

  sendMessage: async (text: string) => {
    const {
      currentConversationId,
      currentModelId,
      pendingAttachments,
      messages,
    } = get();
    if ((!text && !pendingAttachments.length) || get().isStreaming) return;

    // Generate conversation ID if new
    const convId =
      currentConversationId || crypto.randomUUID();

    // Build user message
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: "user",
      content: text,
      attachments: [...pendingAttachments],
      model: null,
      created_at: Math.floor(Date.now() / 1000),
    };

    // Build assistant placeholder
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: "assistant",
      content: "",
      attachments: [],
      model: currentModelId,
      created_at: Math.floor(Date.now() / 1000),
    };

    const updatedMessages = [...messages, userMsg, assistantMsg];
    set({
      currentConversationId: convId,
      messages: updatedMessages,
      pendingAttachments: [],
      isStreaming: true,
      streamedContent: "",
    });

    // Update title for new conversations
    if (!currentConversationId) {
      set({ activeConversationTitle: text.slice(0, 50) });
    }

    const controller = api.streamChat(
      convId,
      text,
      currentModelId,
      pendingAttachments,
      {
        onDelta: (chunk) => {
          const state = get();
          state.appendToStream(chunk);
        },
        onDone: (fullText) => {
          get().finishStream(fullText);
        },
        onError: (error) => {
          get().failStream(error);
        },
      }
    );

    set({ abortController: controller });
  },

  stopStreaming: () => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
      set({ abortController: null, isStreaming: false });
    }
  },

  appendToStream: (text: string) => {
    const { messages, streamedContent } = get();
    const newContent = streamedContent + text;
    const updated = [...messages];
    const last = updated[updated.length - 1];
    if (last && last.role === "assistant") {
      updated[updated.length - 1] = { ...last, content: newContent };
    }
    set({ messages: updated, streamedContent: newContent });
  },

  finishStream: (fullText: string) => {
    const { messages } = get();
    const updated = [...messages];
    const last = updated[updated.length - 1];
    if (last && last.role === "assistant") {
      updated[updated.length - 1] = { ...last, content: fullText };
    }
    set({
      messages: updated,
      isStreaming: false,
      streamedContent: "",
      abortController: null,
    });
    // Refresh conversation list
    get().loadConversations();
  },

  failStream: (error: string) => {
    const { messages } = get();
    const updated = [...messages];
    const errorMsg =
      "\n\n⚠️ **Service Unavailable**\n\n" + friendlyError(error);
    const last = updated[updated.length - 1];
    if (last && last.role === "assistant") {
      updated[updated.length - 1] = {
        ...last,
        content: (last.content || "") + errorMsg,
      };
    }
    set({
      messages: updated,
      isStreaming: false,
      streamedContent: "",
      abortController: null,
    });
    get().loadConversations();
  },
}));

/* ─── Error helper ──────────────────────────────────── */

function friendlyError(msg: string): string {
  if (!msg) return "Something went wrong.";
  if (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("quota")
  ) {
    return "This AI provider's rate limit has been reached. Please wait and try again, or select a different model.";
  }
  if (
    msg.includes("401") ||
    msg.includes("unauthorized") ||
    msg.includes("UNAUTHENTICATED")
  ) {
    return "This AI provider is not properly configured. Please contact the developer.";
  }
  if (
    msg.includes("404") ||
    msg.includes("model_not_found") ||
    msg.includes("does not exist")
  ) {
    return "This model is no longer available. Please try a different model.";
  }
  if (
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("fetch") ||
    msg.includes("Failed to fetch")
  ) {
    return "Unable to reach the AI service. Please check your connection.";
  }
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504")
  ) {
    return "The AI provider is experiencing a temporary outage. Please try again later.";
  }
  return "An unexpected error occurred. Please try again or contact the developer.";
}
