/**
 * PrototypeChatBot — Frontend application logic.
 * Handles: conversation list, message rendering, SSE streaming, file uploads.
 */
(function () {
  "use strict";

  // ----------------------------- State -----------------------------
  let models = [];
  let currentModel = localStorage.getItem("pcb_model") || "";
  let conversations = [];
  let currentConversationId = null;
  let messages = [];
  let pendingAttachments = []; // AttachmentMeta[]
  let isGenerating = false;
  let abortController = null;
  let currentTheme = localStorage.getItem("chatddb_theme") || "dark";
  let toastTimeout = null;

  // ----------------------------- DOM -----------------------------
  const $ = (sel) => document.querySelector(sel);
  const els = {
    sidebar: $("#sidebar"),
    toggleSidebar: $("#toggle-sidebar"),
    openSidebar: $("#open-sidebar"),
    newChatBtn: $("#new-chat-btn"),
    conversationList: $("#conversation-list"),
    modelSelect: $("#model-select"),
    chatTitle: $("#chat-title"),
    messages: $("#messages"),
    welcome: $("#welcome"),
    input: $("#input"),
    sendBtn: $("#send-btn"),
    stopBtn: $("#stop-btn"),
    attachBtn: $("#attach-btn"),
    fileInput: $("#file-input"),
    attachmentsPreview: $("#attachments-preview"),
    themeBtn: $("#theme-btn"),
    toast: $("#toast"),
    messagesInner: document.querySelector(".messages-inner"),
  };

  // ----------------------------- API helpers -----------------------------
  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j.error || msg;
      } catch {}
      throw new Error(msg);
    }
    return res;
  }

  async function apiJson(path, opts = {}) {
    const res = await api(path, opts);
    return res.json();
  }

  // ----------------------------- Theme -----------------------------
  function applyTheme(theme) {
    currentTheme = theme;
    localStorage.setItem("chatddb_theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }

  function cycleTheme() {
    var order = ["dark", "light", "system"];
    var idx = order.indexOf(currentTheme);
    applyTheme(order[(idx + 1) % order.length]);
    showToast("Theme: " + currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1));
  }

  // ----------------------------- Toast -----------------------------
  function showToast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add("visible");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function() {
      els.toast.classList.remove("visible");
    }, 2000);
  }

  // ----------------------------- Copy -----------------------------
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } catch (e) {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Copied to clipboard");
    }
  }

  // ----------------------------- Init -----------------------------
  async function init() {
    applyTheme(currentTheme);

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function() {
      if (currentTheme === "system") {
        applyTheme("system");
      }
    });

    // Load models
    try {
      const data = await apiJson("/api/models");
      models = data.models || [];
      populateModelSelect();
    } catch (e) {
      console.error("Failed to load models", e);
    }

    // Load conversations
    await loadConversations();

    // Set up event listeners
    setupListeners();

    // Auto-resize textarea
    autoResize();
  }

  function populateModelSelect() {
    els.modelSelect.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      els.modelSelect.appendChild(opt);
    }
    if (!currentModel && models.length) {
      currentModel = models[0].id;
    }
    els.modelSelect.value = currentModel;
  }

  // ----------------------------- Conversations -----------------------------
  async function loadConversations() {
    try {
      const data = await apiJson("/api/conversations");
      conversations = data.conversations || [];
      renderConversationList();
    } catch (e) {
      console.error("Failed to load conversations", e);
    }
  }

  function renderConversationList() {
    els.conversationList.innerHTML = "";
    for (const conv of conversations) {
      const item = document.createElement("div");
      item.className = "conv-item" + (conv.id === currentConversationId ? " active" : "");
      item.dataset.id = conv.id;

      const title = document.createElement("span");
      title.className = "conv-title";
      title.textContent = conv.title;

      const delBtn = document.createElement("button");
      delBtn.className = "conv-delete";
      delBtn.title = "Delete";
      delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteConversation(conv.id);
      });

      item.appendChild(title);
      item.appendChild(delBtn);
      item.addEventListener("click", () => selectConversation(conv.id));
      els.conversationList.appendChild(item);
    }
  }

  async function selectConversation(id) {
    if (currentConversationId === id) return;
    currentConversationId = id;
    try {
      const data = await apiJson(`/api/conversations/${id}`);
      messages = data.messages || [];
      const conv = data.conversation;
      els.chatTitle.textContent = conv.title;
      if (conv.model && models.some((m) => m.id === conv.model)) {
        currentModel = conv.model;
        els.modelSelect.value = currentModel;
      }
      renderConversationList();
      renderMessages();
    } catch (e) {
      console.error("Failed to load conversation", e);
    }
  }

  async function deleteConversation(id) {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await api(`/api/conversations/${id}`, { method: "DELETE" });
      if (currentConversationId === id) {
        currentConversationId = null;
        messages = [];
        els.chatTitle.textContent = "New chat";
        renderMessages();
      }
      await loadConversations();
    } catch (e) {
      alert("Failed to delete: " + e.message);
    }
  }

  function newChat() {
    currentConversationId = null;
    messages = [];
    pendingAttachments = [];
    els.chatTitle.textContent = "New chat";
    renderMessages();
    renderAttachmentsPreview();
    renderConversationList();
    els.input.focus();
  }

  // ----------------------------- Message rendering -----------------------------
  function renderMessages() {
    var container = els.messagesInner || els.messages;
    container.innerHTML = "";
    if (messages.length === 0) {
      container.appendChild(els.welcome);
      return;
    }
    for (const m of messages) {
      renderMessage(m);
    }
    scrollToBottom();
  }

  /** Resolve a user-friendly model label from a model ID like "groq:llama-3.3-70b-versatile". */
  function getModelLabel(modelId) {
    if (!modelId) return "AI";
    const found = models.find((m) => m.id === modelId);
    if (found) return found.label;
    // Fallback: parse provider name from the prefix
    const idx = modelId.indexOf(":");
    if (idx !== -1) {
      const provider = modelId.slice(0, idx);
      return provider.charAt(0).toUpperCase() + provider.slice(1);
    }
    return modelId;
  }

  /** Convert raw API errors into user-friendly messages. */
  function friendlyError(msg) {
    if (!msg) return "Something went wrong.";
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) {
      return "This AI provider's free tier rate limit has been reached. Please wait a moment and try again, or select a different model from the sidebar. If the issue persists, contact the developer.";
    }
    if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("UNAUTHENTICATED")) {
      return "The connection to this AI provider is not properly configured. Please contact the developer to check the API keys and provider settings.";
    }
    if (msg.includes("404") || msg.includes("model_not_found") || msg.includes("does not exist")) {
      return "The selected AI model is no longer available or has been updated. Please try a different model from the sidebar. If the issue persists, contact the developer.";
    }
    if (msg.includes("timeout") || msg.includes("network") || msg.includes("fetch") || msg.includes("Failed to fetch")) {
      return "Unable to reach the AI service. Please check your internet connection and try again. If the issue persists, contact the developer.";
    }
    if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) {
      return "The AI provider is experiencing a temporary outage. Please try again later. If the issue persists, contact the developer.";
    }
    // Generic fallback
    return "An unexpected error occurred. Please try again or contact the developer with the details above.";
  }

  function renderMessage(m) {
    const div = document.createElement("div");
    div.className = "msg";
    div.dataset.id = m.id;

    const row = document.createElement("div");
    row.className = "msg-row";

    const avatar = document.createElement("div");
    avatar.className = "msg-avatar " + (m.role === "user" ? "user" : "");
    avatar.textContent = m.role === "user" ? "🧑" : "🤖";

    const body = document.createElement("div");
    body.className = "msg-body";

    // Role header: shows provider name (e.g. "Groq", "Gemini", "ChatGPT")
    const role = document.createElement("div");
    role.className = "msg-role";
    if (m.role === "user") {
      role.textContent = "You";
    } else {
      role.textContent = getModelLabel(m.model) || "AI";
      // Provider emoji tag (visual flavor, no duplicate text)
      const providerTag = document.createElement("span");
      providerTag.className = "msg-provider-tag";
      if (m.model && m.model.startsWith("groq:")) {
        providerTag.textContent = "⚡";
      } else if (m.model && m.model.startsWith("gemini:")) {
        providerTag.textContent = "✨";
      } else if (m.model && m.model.startsWith("agentrouter:")) {
        providerTag.textContent = "🌐";
      } else {
        providerTag.textContent = "AI";
      }
      role.appendChild(providerTag);
    }

    const content = document.createElement("div");
    content.className = "msg-content";
    content.innerHTML = renderMarkdown(m.content);

    // Attachments
    if (m.attachments && m.attachments.length) {
      const attDiv = document.createElement("div");
      attDiv.className = "msg-attachments";
      for (const att of m.attachments) {
        attDiv.appendChild(renderAttachmentChip(att));
      }
      body.appendChild(attDiv);
    }

    body.appendChild(role);
    body.appendChild(content);

    // Message actions (copy button for assistant messages)
    if (m.role !== "user" && m.content) {
      var actionsDiv = document.createElement("div");
      actionsDiv.className = "msg-actions";
      var copyBtn = document.createElement("button");
      copyBtn.className = "msg-action-btn";
      copyBtn.title = "Copy message";
      copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      copyBtn.addEventListener("click", function() { copyToClipboard(m.content); });
      actionsDiv.appendChild(copyBtn);
      body.appendChild(actionsDiv);
    }

    row.appendChild(avatar);
    row.appendChild(body);
    div.appendChild(row);
    (els.messagesInner || els.messages).appendChild(div);
  }

  function renderAttachmentChip(att) {
    const chip = document.createElement("div");
    chip.className = "msg-attachment";

    if (att.kind === "image") {
      const img = document.createElement("img");
      img.src = `/api/files/${encodeURIComponent(att.r2Key)}`;
      img.alt = att.name;
      chip.appendChild(img);
      const name = document.createElement("span");
      name.textContent = att.name;
      chip.appendChild(name);
    } else {
      const icon = document.createElement("span");
      icon.className = "att-icon";
      icon.textContent = att.kind === "pdf" ? "📄" : "📎";
      chip.appendChild(icon);
      const name = document.createElement("span");
      name.textContent = att.name;
      chip.appendChild(name);
    }
    return chip;
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  // ----------------------------- Streaming chat -----------------------------
  async function sendMessage(textOverride) {
    const text = (textOverride || els.input.value).trim();
    if ((!text && pendingAttachments.length === 0) || isGenerating) return;

    // Create conversation ID if none
    if (!currentConversationId) {
      currentConversationId = crypto.randomUUID();
    }

    const userMessage = {
      id: crypto.randomUUID(),
      conversation_id: currentConversationId,
      role: "user",
      content: text,
      attachments: [...pendingAttachments],
      model: null,
      created_at: Math.floor(Date.now() / 1000),
    };
    messages.push(userMessage);

    // Clear input
    els.input.value = "";
    pendingAttachments = [];
    renderAttachmentsPreview();
    autoResize();

    // Hide welcome, render messages
    if (els.welcome.parentElement) els.welcome.remove();
    renderMessage(userMessage);
    scrollToBottom();

    // Start streaming
    setGenerating(true);

    const assistantMessage = {
      id: crypto.randomUUID(),
      conversation_id: currentConversationId,
      role: "assistant",
      content: "",
      attachments: [],
      model: currentModel,
      created_at: Math.floor(Date.now() / 1000),
    };
    messages.push(assistantMessage);
    renderMessage(assistantMessage);

    // Add typing indicator
    const msgEls = (els.messagesInner || els.messages).querySelectorAll(".msg");
    const lastMsgEl = msgEls[msgEls.length - 1];
    const contentEl = lastMsgEl.querySelector(".msg-content");
    contentEl.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    scrollToBottom();

    abortController = new AbortController();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentConversationId,
          message: text,
          attachments: userMessage.attachments,
          model: currentModel,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const evt = JSON.parse(data);
            handleStreamEvent(evt, assistantMessage, contentEl);
          } catch (e) {
            // ignore parse errors
          }
        }
      }
    } catch (e) {
      if (e.name === "AbortError") {
        assistantMessage.content += "\n\n[stopped]";
      } else {
        // Show a user-friendly error instead of raw API error
        const friendlyMsg = friendlyError(e.message);
        assistantMessage.content += `\n\n⚠️ Service Unavailable\n\n${friendlyMsg}`;
      }
      contentEl.innerHTML = renderMarkdown(assistantMessage.content);
    } finally {
      setGenerating(false);
      abortController = null;
      // Reload conversation list to reflect new title
      loadConversations();
      // Update title
      if (els.chatTitle.textContent === "New chat") {
        els.chatTitle.textContent = text.slice(0, 50);
      }
    }
  }

  function handleStreamEvent(evt, assistantMessage, contentEl) {
    if (evt.type === "delta") {
      assistantMessage.content += evt.text;
      contentEl.innerHTML = renderMarkdown(assistantMessage.content) + '<span class="cursor-blink"></span>';
      scrollToBottom();
    } else if (evt.type === "done") {
      assistantMessage.content = evt.text || assistantMessage.content;
      contentEl.innerHTML = renderMarkdown(assistantMessage.content);
    } else if (evt.type === "error") {
      const friendlyMsg = friendlyError(evt.error);
      assistantMessage.content += `\n\n⚠️ Service Unavailable\n\n${friendlyMsg}`;
      contentEl.innerHTML = renderMarkdown(assistantMessage.content);
    }
  }

  function stopGeneration() {
    if (abortController) {
      abortController.abort();
    }
  }

  function setGenerating(val) {
    isGenerating = val;
    els.sendBtn.classList.toggle("hidden", val);
    els.stopBtn.classList.toggle("hidden", !val);
    updateSendButton();
  }

  // ----------------------------- File uploads (optimized) -----------------------------
  async function handleFiles(files) {
    for (const file of files) {
      const previewEl = createAttachmentPreview(file);
      els.attachmentsPreview.appendChild(previewEl);

      // Show immediate feedback
      var statusEl = previewEl.querySelector(".att-preview-status");
      if (statusEl) statusEl.textContent = "Uploading...";

      try {
        const formData = new FormData();
        formData.append("file", file);

        // Fast upload — returns immediately, processing happens in background
        const data = await apiJson("/api/upload", { method: "POST", body: formData });
        const att = data.attachment;
        pendingAttachments.push(att);

        // Update preview with real data
        previewEl.dataset.id = att.id;
        previewEl.classList.remove("uploading");
        const nameEl = previewEl.querySelector(".att-preview-name");
        if (nameEl) nameEl.textContent = att.name;

        // Show processing indicator if file is being processed in background
        if (att.processing) {
          if (statusEl) {
            statusEl.textContent = att.kind === "pdf" ? "Extracting text..." : "Processing...";
            statusEl.className = "att-preview-status status-processing";
          }
          // Poll for processing completion (simple approach: check after delay)
          pollProcessingStatus(att.id, previewEl);
        } else {
          if (statusEl) {
            statusEl.textContent = "\u2713 Ready";
            statusEl.className = "att-preview-status status-ready";
          }
        }
      } catch (e) {
        previewEl.remove();
        alert("Upload failed: " + e.message);
      }
    }
    updateSendButton();
  }

  /** Poll for background processing completion using a simple timeout. */
  async function pollProcessingStatus(attId, previewEl) {
    var statusEl = previewEl.querySelector(".att-preview-status");
    // Wait ~3 seconds then mark as ready (optimistic — background processing
    // should complete within this window for most PDFs)
    await new Promise(function(resolve) { setTimeout(resolve, 3000); });
    if (statusEl) {
      statusEl.textContent = "\u2713 Ready";
      statusEl.className = "att-preview-status status-ready";
    }
  }

  function createAttachmentPreview(file) {
    const div = document.createElement("div");
    div.className = "att-preview uploading";

    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      div.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "att-icon";
      icon.textContent = file.type === "application/pdf" ? "📄" : "📎";
      icon.style.fontSize = "20px";
      div.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "att-preview-name";
    name.textContent = file.name;
    div.appendChild(name);

    // Status indicator
    const status = document.createElement("span");
    status.className = "att-preview-status status-uploading";
    status.textContent = "Uploading...";
    div.appendChild(status);

    const remove = document.createElement("button");
    remove.className = "att-remove";
    remove.title = "Remove";
    remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    remove.addEventListener("click", () => {
      const id = div.dataset.id;
      if (id) {
        pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
      }
      div.remove();
      updateSendButton();
    });
    div.appendChild(remove);

    return div;
  }

  function renderAttachmentsPreview() {
    els.attachmentsPreview.innerHTML = "";
    updateSendButton();
  }

  // ----------------------------- UI helpers -----------------------------
  function updateSendButton() {
    const hasText = els.input.value.trim().length > 0;
    const hasAttachments = pendingAttachments.length > 0;
    els.sendBtn.disabled = !isGenerating && !(hasText || hasAttachments);
  }

  function autoResize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
  }

  function setupListeners() {
    els.newChatBtn.addEventListener("click", newChat);
    els.sendBtn.addEventListener("click", sendMessage);
    els.stopBtn.addEventListener("click", stopGeneration);
    els.attachBtn.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", (e) => {
      handleFiles([...e.target.files]);
      els.fileInput.value = "";
    });

    els.input.addEventListener("input", () => {
      autoResize();
      updateSendButton();
    });

    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    els.modelSelect.addEventListener("change", () => {
      currentModel = els.modelSelect.value;
      localStorage.setItem("pcb_model", currentModel);
      // Update conversation model if one is selected
      if (currentConversationId) {
        api(`/api/conversations/${currentConversationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: currentModel }),
        }).catch(() => {});
      }
    });

    els.toggleSidebar.addEventListener("click", () => {
      els.sidebar.classList.add("collapsed");
      els.openSidebar.classList.remove("hidden");
    });

    els.openSidebar.addEventListener("click", () => {
      els.sidebar.classList.remove("collapsed");
      els.openSidebar.classList.add("hidden");
    });

    // Theme toggle
    if (els.themeBtn) {
      els.themeBtn.addEventListener("click", cycleTheme);
    }

    // Welcome suggestions
    (els.messagesInner || els.messages).addEventListener("click", function(e) {
      var btn = e.target.closest(".welcome-suggestion");
      if (btn && btn.dataset.prompt) {
        sendMessage(btn.dataset.prompt);
      }
    });

    // Drag and drop
    els.messages.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    els.messages.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) {
        handleFiles([...e.dataTransfer.files]);
      }
    });

    // Code block copy buttons (delegated)
    els.messages.addEventListener("click", function(e) {
      var btn = e.target.closest(".code-copy-btn");
      if (btn && btn.dataset.code) {
        try {
          var code = decodeURIComponent(btn.dataset.code);
          navigator.clipboard.writeText(code).then(function() {
            btn.textContent = "Copied!";
            setTimeout(function() {
              btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
            }, 2000);
          }).catch(function() {});
        } catch (err) {}
      }
    });

    // Paste image
    els.input.addEventListener("paste", (e) => {
      const items = e.clipboardData.items;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) handleFiles([file]);
        }
      }
    });
  }

  // ----------------------------- Minimal Markdown renderer -----------------------------
  function renderMarkdown(text) {
    if (!text) return "";
    // Escape HTML
    let html = escapeHtml(text);

    // Code blocks (```) with language labels and copy buttons
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
      const langLabel = lang || "code";
      const escapedCode = escapeHtml(code.trim());
      // Use URI encoding to safely embed code in data attribute (Unicode-safe)
      const encoded = encodeURIComponent(code.trim());
      return `<div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-block-lang">${escapeHtml(langLabel)}</span>
          <button class="code-copy-btn" data-code="${encoded}" aria-label="Copy code">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
        </div>
        <pre><code>${escapedCode}</code></pre>
      </div>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Headers
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // Italic
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Lists
    html = html.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
    html = html.replace(/<\/ul>\s*<ul>/g, "");

    // Numbered lists
    html = html.replace(/^\s*\d+\. (.+)$/gm, "<li>$1</li>");

    // Paragraphs / line breaks
    html = html.replace(/\n\n/g, "</p><p>");
    html = html.replace(/\n/g, "<br>");

    // Wrap in paragraphs (but not if it starts with a block element)
    if (!html.match(/^<(h[1-6]|pre|ul|ol|li|p)/i)) {
      html = "<p>" + html + "</p>";
    }

    return html;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ----------------------------- Boot -----------------------------
  init();
})();