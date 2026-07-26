import os

css = r"""/* ChatDDB — Design System */
:root {
  /* Dark theme (default) */
  --bg: #0D1117;
  --bg-sidebar: #171717;
  --bg-input: #202123;
  --bg-hover: #2a2a2a;
  --bg-elevated: #1A1D23;
  --bg-user-msg: #202123;
  --text: #FFFFFF;
  --text-secondary: #B3B3B3;
  --text-muted: #7A7A7A;
  --border: #2A2A2A;
  --accent: #10A37F;
  --accent-hover: #0D8A6A;
  --accent-ghost: rgba(16, 163, 127, 0.12);
  --danger: #EF4444;
  --radius: 10px;
  --radius-sm: 8px;
  --radius-lg: 14px;
  --radius-full: 9999px;
  --sidebar-width: 280px;
  --content-max-width: 768px;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SF Mono", Monaco, "JetBrains Mono", "Cascadia Code", "Consolas", monospace;
}

.light, [data-theme="light"] {
  --bg: #FFFFFF;
  --bg-sidebar: #F7F7F8;
  --bg-input: #ECECF1;
  --bg-hover: #E5E5E5;
  --bg-elevated: #FFFFFF;
  --bg-user-msg: #F0F0F0;
  --text: #111111;
  --text-secondary: #555555;
  --text-muted: #999999;
  --border: #E5E5E5;
  --accent-ghost: rgba(16, 163, 127, 0.1);
}

@media (prefers-color-scheme: light) {
  .system-theme, [data-theme="system"] {
    --bg: #FFFFFF;
    --bg-sidebar: #F7F7F8;
    --bg-input: #ECECF1;
    --bg-hover: #E5E5E5;
    --bg-elevated: #FFFFFF;
    --bg-user-msg: #F0F0F0;
    --text: #111111;
    --text-secondary: #555555;
    --text-muted: #999999;
    --border: #E5E5E5;
    --accent-ghost: rgba(16, 163, 127, 0.1);
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
  height: 100%;
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

#app { display: flex; height: 100vh; overflow: hidden; }

/* Sidebar */
#sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  background: var(--bg-sidebar);
  display: flex; flex-direction: column;
  border-right: 1px solid var(--border);
  transition: width 0.2s ease, min-width 0.2s ease, margin-left 0.2s ease, opacity 0.2s ease;
  flex-shrink: 0; z-index: 20;
}
#sidebar.collapsed { width: 0; min-width: 0; margin-left: calc(-1 * var(--sidebar-width)); opacity: 0; border-right: none; overflow: hidden; }

.sidebar-header { display: flex; align-items: center; gap: 8px; padding: 12px; flex-shrink: 0; }

.new-chat-btn {
  flex: 1; display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: transparent; color: var(--text); cursor: pointer;
  font-size: 14px; font-family: inherit;
  transition: background 0.15s;
}
.new-chat-btn:hover { background: var(--bg-hover); }

.icon-btn {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-secondary); cursor: pointer;
  transition: background 0.15s, color 0.15s; flex-shrink: 0;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.icon-btn svg { width: 20px; height: 20px; }

.conversation-list { flex: 1; overflow-y: auto; padding: 4px; }

.conv-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer;
  color: var(--text-secondary); font-size: 14px;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.conv-item:hover { background: var(--bg-hover); color: var(--text); }
.conv-item.active { background: var(--bg-hover); color: var(--text); }
.conv-item .conv-title { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.conv-item .conv-delete {
  opacity: 0; transition: opacity 0.15s;
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: var(--text-muted); cursor: pointer;
  border-radius: 4px; flex-shrink: 0;
}
.conv-item:hover .conv-delete { opacity: 1; }
.conv-item .conv-delete:hover { color: var(--danger); background: var(--danger-ghost, rgba(239,68,68,0.1)); }

.sidebar-footer { padding: 12px; border-top: 1px solid var(--border); }
.model-selector-wrap { display: flex; flex-direction: column; gap: 4px; }
.model-label { font-size: 12px; color: var(--text-muted); padding-left: 4px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
.model-select {
  width: 100%; padding: 8px 12px; border-radius: var(--radius-sm);
  border: 1px solid var(--border); background: var(--bg-input);
  color: var(--text); font-size: 14px; font-family: inherit;
  cursor: pointer; outline: none; transition: border-color 0.15s;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%237A7A7A' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  padding-right: 32px;
}
.model-select:focus { border-color: var(--accent); }

/* Main */
#main { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }

.chat-header {
  display: flex; align-items: center; gap: 12px;
  padding: 0 16px; height: 56px;
  border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.chat-title { font-size: 16px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header-actions { display: flex; align-items: center; gap: 4px; }

/* Messages */
.messages { flex: 1; overflow-y: auto; padding: 0; scroll-behavior: smooth; }
.messages-inner { max-width: var(--content-max-width); margin: 0 auto; padding: 0 24px; padding-top: 24px; }

.welcome {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; text-align: center; gap: 16px; color: var(--text-muted);
  padding: 48px; animation: fadeIn 0.3s ease;
}
.welcome-icon { font-size: 48px; line-height: 1; }
.welcome h2 { color: var(--text); font-size: 22px; font-weight: 600; }
.welcome p { font-size: 14px; max-width: 360px; }

.welcome-suggestions {
  display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 8px;
}
.welcome-suggestion {
  padding: 8px 16px; border: 1px solid var(--border); border-radius: var(--radius-full);
  background: transparent; color: var(--text-secondary); cursor: pointer;
  font-size: 14px; font-family: inherit;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.welcome-suggestion:hover {
  border-color: var(--accent); background: var(--accent-ghost); color: var(--accent);
}

/* Messages */
.msg {
  padding: 18px 0; opacity: 0;
  animation: msgFadeIn 0.25s ease forwards;
}
.msg-row { display: flex; gap: 16px; }
.msg-avatar {
  width: 32px; height: 32px; min-width: 32px;
  border-radius: 6px; display: flex; align-items: center; justify-content: center;
  font-size: 18px; flex-shrink: 0; background: var(--accent); color: white;
}
.msg-avatar.user { background: var(--text-muted); }
.msg-body { flex: 1; min-width: 0; padding-top: 2px; }
.msg-role {
  font-weight: 600; font-size: 14px; margin-bottom: 4px;
  display: flex; align-items: center; gap: 8px;
}
.msg-provider-tag {
  display: inline-flex; align-items: center;
  font-size: 11px; font-weight: 500; padding: 1px 8px;
  border-radius: var(--radius-full); background: var(--accent-ghost);
  color: var(--accent); white-space: nowrap;
}
.msg-content {
  font-size: 16px; line-height: 1.7; color: var(--text); word-wrap: break-word;
}
.msg-content > p { margin-bottom: 12px; }
.msg-content > p:last-child { margin-bottom: 0; }
.msg-content > pre {
  background: #0A0A0F; border: 1px solid var(--border);
  border-radius: 8px; padding: 16px; overflow-x: auto;
  margin: 12px 0; font-size: 13px; line-height: 1.6;
  font-family: var(--font-mono);
}
.msg-content code { font-family: var(--font-mono); }
.msg-content :not(pre) > code {
  background: rgba(255,255,255,0.1);
  padding: 2px 5px; border-radius: 4px; font-size: 13px;
}
.msg-content ul, .msg-content ol { margin: 10px 0; padding-left: 24px; }
.msg-content li { margin-bottom: 4px; }
.msg-content a { color: var(--accent); }
.msg-content table { border-collapse: collapse; margin: 10px 0; width: 100%; }
.msg-content th, .msg-content td {
  border: 1px solid var(--border); padding: 8px 12px; text-align: left;
}
.msg-content th { background: var(--bg-hover); }

.code-block-wrapper {
  margin: 12px 0; border-radius: var(--radius-sm);
  overflow: hidden; border: 1px solid var(--border); background: #0A0A0F;
}
.code-block-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; background: rgba(255,255,255,0.04);
  border-bottom: 1px solid var(--border);
}
.code-block-lang { font-size: 12px; color: var(--text-muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; }
.code-copy-btn {
  display: flex; align-items: center; gap: 4px; padding: 4px 8px;
  border: none; border-radius: 4px; background: transparent;
  color: var(--text-muted); cursor: pointer; font-size: 12px; font-family: inherit;
  transition: color 0.15s, background 0.15s;
}
.code-copy-btn:hover { color: var(--text-secondary); background: rgba(255,255,255,0.06); }
.code-copy-btn svg { width: 14px; height: 14px; }
.code-block-wrapper pre { margin: 0; padding: 16px; border: none; border-radius: 0; background: transparent; }

.msg-attachments { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.msg-attachment {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; background: var(--bg-input);
  border: 1px solid var(--border); border-radius: 8px;
  font-size: 13px; color: var(--text-muted);
}
.msg-attachment img { width: 40px; height: 40px; object-fit: cover; border-radius: 6px; }
.msg-attachment .att-icon { font-size: 20px; }

.typing-indicator { display: inline-flex; gap: 4px; padding: 4px 0; }
.typing-indicator span {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-muted); animation: typing 1.4s infinite ease-in-out;
}
.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-6px); opacity: 1; }
}

.cursor-blink { display: inline-block; width: 8px; height: 16px; background: var(--accent); margin-left: 2px; vertical-align: text-bottom; animation: blink 1s infinite; }
@keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }

.composer { padding: 12px 24px 16px; max-width: var(--content-max-width); margin: 0 auto; width: 100%; }
.attachments-preview { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.attachments-preview:empty { margin-bottom: 0; }
.att-preview { position: relative; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; font-size: 13px; max-width: 200px; }
.att-preview img { width: 36px; height: 36px; object-fit: cover; border-radius: 6px; }
.att-preview .att-preview-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
.att-preview .att-remove { width: 20px; height: 20px; border: none; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; border-radius: 4px; flex-shrink: 0; }
.att-preview .att-remove:hover { color: var(--danger); }
.att-preview.uploading::after { content: "Uploading..."; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.6); border-radius: 8px; font-size: 12px; }

.composer-row { display: flex; align-items: flex-end; gap: 8px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 26px; padding: 8px 8px 8px 12px; transition: border-color 0.15s; }
.composer-row:focus-within { border-color: var(--text-muted); }
.attach-btn { width: 40px; height: 40px; border-radius: 50%; }

.input { flex: 1; border: none; background: transparent; color: var(--text); font-size: 15px; font-family: inherit; resize: none; outline: none; max-height: 200px; padding: 10px 0; line-height: 1.5; }
.input::placeholder { color: var(--text-muted); }

.send-btn, .stop-btn { width: 40px; height: 40px; border: none; border-radius: 50%; background: var(--accent); color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s, opacity 0.15s; flex-shrink: 0; }
.send-btn:hover:not(:disabled) { background: var(--accent-hover); }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.stop-btn { background: var(--text); color: var(--bg); }
.stop-btn:hover { opacity: 0.8; }
.composer-hint { text-align: center; font-size: 12px; color: var(--text-muted); margin-top: 8px; }

.msg-actions { display: flex; gap: 4px; opacity: 0; margin-top: 12px; transition: opacity 0.2s; }
.msg:hover .msg-actions { opacity: 1; }
.msg-action-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: none; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; transition: all 0.15s; }
.msg-action-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }
.msg-action-btn svg { width: 16px; height: 16px; }

.att-preview-status { font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 4px; }
.status-uploading { color: var(--text-muted); animation: pulse 1.5s ease-in-out infinite; }
.status-processing { color: var(--accent); animation: pulse 1.5s ease-in-out infinite; }
.status-ready { color: var(--accent); }
@keyframes pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }

.toast {
  position: fixed; bottom: 80px; left: 50%;
  transform: translateX(-50%) translateY(10px);
  background: var(--bg-elevated); color: var(--text);
  border: 1px solid var(--border); padding: 8px 16px;
  border-radius: var(--radius-full); font-size: 14px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  opacity: 0; transition: all 0.2s; z-index: 100;
  pointer-events: none; white-space: nowrap;
}
.toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

.hidden { display: none !important; }

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

@media (max-width: 768px) {
  :root { --sidebar-width: 100%; }
  #sidebar { position: absolute; z-index: 10; height: 100%; }
  #sidebar:not(.collapsed) { box-shadow: 4px 0 20px rgba(0,0,0,0.5); }
  .msg, .composer { padding-left: 16px; padding-right: 16px; }
}
"""

# Write the CSS to public/styles.css
css_path = os.path.join(os.path.dirname(__file__), 'public', 'styles.css')
with open(css_path, 'w', encoding='utf-8') as f:
    f.write(css)

print(f'CSS written to {css_path} ({len(css)} chars)')
