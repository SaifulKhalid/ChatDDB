import re

with open('public/app.js', 'r', encoding='utf-8') as f:
    js = f.read()

# Add theme state
js = js.replace(
    'let abortController = null;\n  // ------------------------------- DOM --------------------------------',
    'let abortController = null;\n  let currentTheme = localStorage.getItem("chatddb_theme") || "dark";\n  let toastTimeout = null;\n  // ------------------------------- DOM --------------------------------'
)

# Add toast element reference
js = js.replace(
    'attachmentsPreview: $("#attachments-preview"),',
    'attachmentsPreview: $("#attachments-preview"),\n    themeBtn: $("#theme-btn"),\n    toast: $("#toast"),\n    messagesInner: document.querySelector('.messages-inner'),')

# Add theme functions
js = js.replace(
    '// ------------------------------- Init --------------------------------',
    '// -------------------------------- Theme --------------------------------\n  function applyTheme(theme) {\n    currentTheme = theme;\n    localStorage.setItem("chatddb_theme", theme);\n    document.documentElement.setAttribute("data-theme", theme);\n  }\n\n  function cycleTheme() {\n    var order = ["dark", "light", "system"];\n    var idx = order.indexOf(currentTheme);\n    applyTheme(order[(idx + 1) % order.length]);\n    showToast("Theme: " + currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1));\n  }\n\n  // ------------------------------- Toast -------------------------------\n  function showToast(message) {\n    if (!els.toast) return;\n    els.toast.textContent = message;\n    els.toast.classList.add("visible");\n    clearTimeout(toastTimeout);\n    toastTimeout = setTimeout(function() {\n      els.toast.classList.remove("visible");\n    }, 2000);\n  }\n\n  // ------------------------------- Copy -------------------------------\n  async function copyToClipboard(text) {\n    try {\n      await navigator.clipboard.writeText(text);\n      showToast("Copied to clipboard");\n    } catch (e) {\n      var ta = document.createElement("textarea");\n      ta.value = text;\n      document.body.appendChild(ta);\n      ta.select();\n      document.execCommand("copy");\n      document.body.removeChild(ta);\n      showToast("Copied to clipboard");\n    }\n  }\n\n  // ------------------------------- Init --------------------------------')

# Add theme init in init function
js = js.replace(
    'async function init() {\n    // Load models',
    'async function init() {\n    // Apply saved theme\n    applyTheme(currentTheme);\n    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function() {\n      if (currentTheme === "system") {\n        applyTheme("system");\n      }\n    });\n    // Load models')

# Update renderMessages to use messagesInner
js = js.replace(
    'function renderMessages() {\n    els.messages.innerHTML = "";\n    if (messages.length === 0) {\n      els.messages.appendChild(els.welcome);\n      return;
    }',
    'function renderMessages() {\n    var container = els.messagesInner || els.messages;\n    container.innerHTML = "";\n    if (messages.length === 0) {\n      container.appendChild(els.welcome);\n      return;
    }')

# Update renderMessage to use messagesInner
js = js.replace(
    'div.appendChild(row);\n    els.messages.appendChild(div);\n  }\n\n  function renderAttachmentChip(att) {',
    'div.appendChild(row);\n    (els.messagesInner || els.messages).appendChild(div);\n  }\n\n  function renderAttachmentChip(att) {')

# Update sendMessage to accept textOverride
js = js.replace(
    'async function sendMessage() {\n    const text = els.input.value.trim();',
    'async function sendMessage(textOverride) {\n    const text = (textOverride || els.input.value).trim();')

# Add theme toggle and welcome suggestions listeners
js = js.replace(
    '// Drag and drop\n    els.messages.addEventListener("dragover", (e) => {',
    '// Theme toggle\n    if (els.themeBtn) {\n      els.themeBtn.addEventListener("click", cycleTheme);\n    }\n\n    // Welcome suggestions\n    (els.messagesInner || els.messages).addEventListener("click", function(e) {\n      var btn = e.target.closest(".welcome-suggestion");\n      if (btn && btn.dataset.prompt) {\n        sendMessage(btn.dataset.prompt);\n      }\n    });\n\n    // Drag and drop\n    els.messages.addEventListener("dragover", (e) => {')

with open('public/app.js', 'w', encoding='utf-8') as f:
    f.write(js)

print('JS updated: ' + str(len(js)))
