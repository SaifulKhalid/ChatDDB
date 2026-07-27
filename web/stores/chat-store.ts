import { create } from "zustand";
import type { ChatMessage, Conversation, ModelInfo, AttachmentMeta } from "@/lib/api";
import * as api from "@/lib/api";
import { AUTO_MODEL_ID } from "@/lib/constants";
import { useGuestStore } from "./guest-store";

/* ─── Selection Info ────────────────────────────────── */

export interface SelectionInfo {
  modelId: string;
  label: string;
  reason: string;
}

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

  // Auto-selection info for 'Why this model?' display
  // DEPRECATED: kept for backward compat, use per-message selectionInfo instead
  lastSelectionInfo: SelectionInfo | null;

  // Image generation
  isImageGenMode: boolean;
  isGeneratingImage: boolean;

  // Actions
  loadModels: () => Promise<void>;
  setCurrentModel: (id: string) => void;

  loadConversations: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  deleteConversation: (id: string) => Promise<void>;

  addPendingAttachment: (att: AttachmentMeta) => void;
  removePendingAttachment: (id: string) => void;
  setSelectionInfo: (info: SelectionInfo | null) => void;
  setMessageSelectionInfo: (messageId: string, info: SelectionInfo) => void;
  setMessages: (msgs: ChatMessage[]) => void;

  sendMessage: (text: string) => Promise<void>;
  stopStreaming: () => void;
  appendToStream: (text: string) => void;
  finishStream: (fullText: string) => void;
  failStream: (error: string) => void;

  // Image generation actions
  setImageGenMode: (enabled: boolean) => void;
  generateImage: (prompt: string) => Promise<void>;
  /** Regenerate with a specific model (used by "Try again" button). */
  retryGenerateImage: (prompt: string, usedModelId: string, conversationId: string) => Promise<void>;
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
  lastSelectionInfo: null,

  isImageGenMode: false,
  isGeneratingImage: false,

  // Actions
  loadModels: async () => {
    try {
      const models = await api.getModels();
      const saved = localStorage.getItem("chatddb-model") || "";
      // Default new users to Auto mode; preserve existing preference
      const currentModelId =
        saved === AUTO_MODEL_ID
          ? AUTO_MODEL_ID
          : models.find((m) => m.id === saved)?.id || AUTO_MODEL_ID;
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
        lastSelectionInfo: null, // Clear selection badge when switching conversations
      });
      if (conversation.model) {
        if (conversation.model === AUTO_MODEL_ID) {
          set({ currentModelId: AUTO_MODEL_ID });
        } else if (
          get().models.some((m) => m.id === conversation.model)
        ) {
          set({ currentModelId: conversation.model });
        }
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
      lastSelectionInfo: null,
    });
  },

  setSelectionInfo: (info: SelectionInfo | null) => {
    set({ lastSelectionInfo: info });
  },

  setMessageSelectionInfo: (messageId: string, info: SelectionInfo) => {
    const { messages } = get();
    const updated = messages.map((m) =>
      m.id === messageId ? { ...m, selectionInfo: info } : m
    );
    set({ messages: updated });
  },

  setMessages: (msgs: ChatMessage[]) => {
    set({ messages: msgs });
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

  setImageGenMode: (enabled: boolean) => {
    set({ isImageGenMode: enabled });
  },

  generateImage: async (prompt: string) => {
    const { currentConversationId, messages, models, currentModelId, pendingAttachments } = get();
    if (!prompt.trim() || get().isGeneratingImage) return;

    // Find the first image generation model
    const imageGenModels = models.filter((m) => m.supportsImageGen);
    const imageModel = imageGenModels.find(
      (m) => currentModelId === "auto" || m.id === currentModelId
    ) || imageGenModels[0];

    if (!imageModel) {
      // Add error message if no models available
      const convId = currentConversationId || crypto.randomUUID();
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: "assistant",
        content: "⚠️ **Image generation not available**: No image generation models are available. Please check your model configuration.",
        attachments: [],
        model: null,
        created_at: Math.floor(Date.now() / 1000),
      };
      set({ messages: [...messages, errorMsg] });
      return;
    }

    set({ isGeneratingImage: true, isStreaming: true });

    const convId = currentConversationId || crypto.randomUUID();
    const modelName = imageModel.label || imageModel.id;

    // Check if we have any image attachments for image-to-image editing
    const imageAttachments = pendingAttachments.filter((a) => a.kind === "image");
    const sourceImage = imageAttachments.length > 0 ? imageAttachments[0] : undefined;
    const isEditing = !!sourceImage;

    // Build user message with the attachments (they'll be displayed in chat)
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: "user",
      content: prompt,
      attachments: isEditing ? pendingAttachments : [],
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
      model: imageModel.id,
      created_at: Math.floor(Date.now() / 1000),
    };

    const updatedMessages = [...messages, userMsg, assistantMsg];
    set({
      currentConversationId: convId,
      messages: updatedMessages,
      pendingAttachments: [], // Clear pending attachments after using them
      streamedContent: "",
    });

    if (!currentConversationId) {
      set({ activeConversationTitle: prompt.slice(0, 50) });
    }

    try {
      // Call API to generate image (also persists both messages server-side)
      // Pass r2Key and type directly to avoid race conditions with R2 metadata writes
      const result = await api.generateImage({
        prompt,
        model: imageModel.id,
        conversationId: convId,
        imageR2Key: sourceImage?.r2Key,
        imageMimeType: sourceImage?.type,
      });

      // Store selection info on the assistant message (from API response when auto-selected)
      if (result.modelSelection) {
        get().setMessageSelectionInfo(assistantMsg.id, {
          modelId: result.modelSelection.modelId,
          label: result.modelSelection.label,
          reason: result.modelSelection.reason,
        });
      } else {
        // Manual mode — still show which model was used
        get().setMessageSelectionInfo(assistantMsg.id, {
          modelId: imageModel.id,
          label: imageModel.label || imageModel.id,
          reason: isEditing ? "Image editing" : "Image generation",
        });
      }

      // Use the content string returned by the API (which uses /api/files/ URLs instead of base64)
      // This matches exactly what was persisted in D1 and avoids the 2MB row limit.
      const content = result.content || buildImageFallbackContent(result.images, isEditing, modelName, prompt);

      // Update the assistant message with the server-side content
      const finalMessages = get().messages;
      const updated = [...finalMessages];
      const last = updated[updated.length - 1];
      if (last && last.role === "assistant") {
        updated[updated.length - 1] = { ...last, content };
        set({
          messages: updated,
          isStreaming: false,
          isGeneratingImage: false,
        });
      }
    } catch (err) {
      const finalMessages = get().messages;
      const updated = [...finalMessages];
      const last = updated[updated.length - 1];
      if (last && last.role === "assistant") {
        updated[updated.length - 1] = {
          ...last,
          content: `⚠️ **Image generation failed**: ${(err as Error).message}`,
        };
        set({
          messages: updated,
          isStreaming: false,
          isGeneratingImage: false,
        });
      }
    }

    get().loadConversations();
  },

  retryGenerateImage: async (prompt: string, usedModelId: string, convId: string) => {
    const { messages, models } = get();
    if (!prompt.trim() || get().isGeneratingImage) return;

    // Find a different image gen model than the one that was used
    const differentModels = models.filter(
      (m) => m.supportsImageGen && m.id !== usedModelId
    );
    if (differentModels.length === 0) {
      // Add error if no alternative models
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        conversation_id: convId,
        role: "assistant",
        content: "⚠️ **No alternative models**: No other image generation models are available. Try selecting a different model manually.",
        attachments: [],
        model: null,
        created_at: Math.floor(Date.now() / 1000),
      };
      set({ messages: [...messages, errorMsg] });
      return;
    }

    // Pick the first alternative
    const altModel = differentModels[0];

    set({ isGeneratingImage: true, isStreaming: true });

    // Build both user and assistant messages (matching what the backend persists)
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: "user",
      content: prompt,
      attachments: [],
      model: null,
      created_at: Math.floor(Date.now() / 1000),
    };
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: "assistant",
      content: "",
      attachments: [],
      model: altModel.id,
      created_at: Math.floor(Date.now() / 1000),
    };

    const updatedMessages = [...messages, userMsg, assistantMsg];
    set({
      messages: updatedMessages,
      streamedContent: "",
    });

    try {
      const result = await api.generateImage({
        prompt,
        model: altModel.id,
        conversationId: convId,
      });

      // Store selection info
      get().setMessageSelectionInfo(assistantMsg.id, {
        modelId: result.modelSelection?.modelId || altModel.id,
        label: result.modelSelection?.label || altModel.label || altModel.id,
        reason: "Retry with different model",
      });

      const modelName = altModel.label || altModel.id;
      const content = result.content || buildImageFallbackContent(result.images, false, modelName, prompt);

      const finalMessages = get().messages;
      const updated = [...finalMessages];
      const last = updated[updated.length - 1];
      if (last && last.role === "assistant") {
        updated[updated.length - 1] = { ...last, content };
        set({
          messages: updated,
          isStreaming: false,
          isGeneratingImage: false,
        });
      }
    } catch (err) {
      const finalMessages = get().messages;
      const updated = [...finalMessages];
      const last = updated[updated.length - 1];
      if (last && last.role === "assistant") {
        updated[updated.length - 1] = {
          ...last,
          content: `⚠️ **Retry failed**: ${(err as Error).message}`,
        };
        set({
          messages: updated,
          isStreaming: false,
          isGeneratingImage: false,
        });
      }
    }

    get().loadConversations();
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
        onModelSelection: (modelId, label, reason) => {
          // Store selection info on the current assistant message (per-message, not global)
          const state = get();
          const lastMsg = state.messages[state.messages.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            get().setMessageSelectionInfo(lastMsg.id, { modelId, label, reason });
          }
          // Also set legacy global state for any remaining uses
          get().setSelectionInfo({ modelId, label, reason });
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
    // Persist guest messages to localStorage
    if (useGuestStore.getState().isGuest) {
      useGuestStore.getState().setMessages(updated);
    }
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
    // Persist guest messages to localStorage
    if (useGuestStore.getState().isGuest) {
      useGuestStore.getState().setMessages(updated);
    }
    get().loadConversations();
  },
}));

/* ─── Image content fallback ────────────────────────── */

/** Build image markdown from base64 data (fallback for older API responses). */
function buildImageFallbackContent(
  images: { b64_json: string; media_type: string }[],
  isEditing: boolean,
  modelName: string,
  prompt: string
): string {
  const modeLabel = isEditing ? "Edited" : "Generated";
  const imageMarkdown = images
    .map((img, i) => `![${modeLabel} Image ${i + 1}](data:${img.media_type};base64,${img.b64_json})`)
    .join("\n\n");
  return `🎨 **${modeLabel} with ${modelName}**\n\n${imageMarkdown}\n\n*Prompt: ${prompt}*`;
}

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
