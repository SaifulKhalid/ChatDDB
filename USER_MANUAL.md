# ChatDDB User Manual

**Version 2.0** | *One Workspace. Every AI.*

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [The Chat Interface](#2-the-chat-interface)
3. [Sending Messages](#3-sending-messages)
4. [Model Selection](#4-model-selection)
5. [Working with Files](#5-working-with-files)
6. [Image Generation](#6-image-generation)
7. [Conversation Management](#7-conversation-management)
8. [Authentication & Guest Mode](#8-authentication--guest-mode)
9. [Keyboard Shortcuts](#9-keyboard-shortcuts)
10. [Settings & Admin Panel](#10-settings--admin-panel)
11. [Troubleshooting](#11-troubleshooting)
12. [FAQ](#12-faq)

---

## 1. Getting Started

### What is ChatDDB?

ChatDDB is a unified AI workspace that gives you access to **multiple AI models** in a single, beautiful interface. Instead of juggling tabs for ChatGPT, Claude, Gemini, and others, you can access them all from one place.

### Accessing ChatDDB

You can access ChatDDB from either:

- **Cloudflare Workers:** https://prototype-chatbot.chatddb-smoke.workers.dev
- **Vercel:** https://chatddb.vercel.app

### First-time Users

When you first visit ChatDDB, you'll see the welcome screen with two options:

1. **Sign in** — Create an account or sign in with Google/Email
2. **Guest mode** — Try the app immediately with limited free usage

Guest mode gives you:
- **10** free chat messages
- **2** file uploads
- **2** image generations

Once you exhaust your guest quota, you'll need to sign in to continue.

---

## 2. The Chat Interface

```
┌─────────────────────────────────────────────────────────┐
│  ☰ [Logo] ChatDDB          [Ask: your message] [AI ✨]  │  ← Top Bar
├─────────────────────────────────────────────────────────┤
│                                                         │
│   Welcome to ChatDDB                                    │
│   ┌──────────────────┐  ┌──────────────────┐           │
│   │ Write code       │  │ Explain concepts  │           │  ← Welcome Screen
│   └──────────────────┘  └──────────────────┘           │  (shown when empty)
│   ┌──────────────────┐  ┌──────────────────┐           │
│   │ Brainstorm       │  │ Analyze data     │           │
│   └──────────────────┘  └──────────────────┘           │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  📎 [Type your message...]    [Auto ✨] 🎨 ✨ 🚀     │  ← Composer
└─────────────────────────────────────────────────────────┘
```

### Key Areas

| Area | Description |
|------|-------------|
| **Sidebar** (left) | Conversation history, model selector, settings |
| **Top Bar** | Logo, current conversation title, model selector, user menu |
| **Chat Area** | Main message display with welcome screen or conversation |
| **Right Panel** | Info, artifacts, and sources for the current conversation |
| **Composer** | Text input, file upload, image gen toggle, model selector, send |

### Toggle Elements

- **Sidebar:** Click ☰ (hamburger icon) or press `⌘B`
- **Right Panel:** Click the panel icon in the sidebar or use its button

---

## 3. Sending Messages

### Basic Chat

1. Type your message in the composer at the bottom
2. Press **Enter** to send (or click the ▲ send button)
3. Use **Shift+Enter** to add a new line

### During Streaming

When the AI is generating a response:

- You'll see a **thinking indicator** with rotating status messages (Thinking…, Brainstorming…, DDBing…, etc.)
- Click the **■ Stop** button to abort generation mid-response
- The response appears incrementally as it's generated

### Enhancing Your Prompt

Click the ✨ **(sparkle) button** next to the send button to have the AI enhance your prompt before sending. This is useful when you want a more detailed or well-structured request.

---

## 4. Model Selection

### Auto Mode (Recommended)

In **Auto** mode, ChatDDB intelligently selects the best model based on your request:

| Priority | Model | Best For |
|----------|-------|----------|
| 1 🥇 | **Groq** | Fast responses, simple questions, coding |
| 2 🥈 | **ChatGPT / Claude** | Creative writing, complex reasoning, premium quality |
| 3 🥉 | **Workers AI** | Vision tasks, image analysis |
| 4 | **Gemini** | Long documents, PDFs, math |
| 5 | **OpenRouter** | Free fallback models |

When Auto mode picks a model, you'll see a small badge below the response explaining why that model was chosen (e.g., "Code detected · Best value").

### Manual Mode

To select a specific model:

1. Click the model name in the composer (e.g., "Auto" or "Groq")
2. Choose from the dropdown
3. All subsequent messages will use that model until you switch

### Changing Models

You can also switch models from:
- **Top bar** dropdown menu
- **Sidebar** model selector at the bottom

---

## 5. Working with Files

### Supported File Types

| Type | Formats | What Happens |
|------|---------|--------------|
| **Images** | PNG, JPG, GIF, WEBP | Sent to vision-capable models for analysis |
| **PDFs** | PDF | Text is extracted and provided as context |
| **Documents** | TXT, MD, DOC, DOCX | Content is processed and sent with your message |

### Uploading Files

1. Click the 📎 **paperclip** button in the composer
2. Select one or more files from your computer
3. Files appear as pending attachments above the input bar
4. Send your message — the files are included automatically

### Pasting Images

You can paste images directly from your clipboard into the composer.

### File Size Limit

Maximum file size: **20 MB** per file.

---

## 6. Image Generation

### Generating Images

1. Click the 🎨 **image icon** in the composer to enable Image Generation Mode
2. Describe what you want to create
3. Press Enter to generate
4. The image appears in the chat when ready

### Image Editing

1. Upload an image first (it becomes a pending attachment)
2. Enable Image Generation Mode
3. Describe how you want to transform the image
4. The AI will edit the image based on your description

### Downloading Images

Click the **Download** button below any generated image to save it to your computer.

### Trying Different Models

If you're not satisfied with the result, click **Try different model** to regenerate with an alternative image generation model.

---

## 7. Conversation Management

### Starting a New Conversation

Click **+ New Chat** in the sidebar or press `⌘N`.

### Viewing Past Conversations

Conversations appear in the sidebar, sorted by most recent. You can search for conversations using the search bar at the top of the sidebar.

### Deleting a Conversation

Hover over a conversation in the sidebar and click the **trash icon** (🗑️). Confirm to delete.

### Auto-Titling

ChatDDB automatically names your conversations based on your first message.

---

## 8. Authentication & Guest Mode

### Sign In

- **Google Sign-In:** Click "Continue with Google" on the login page
- **Email/Password:** Enter your email and password, or create a new account

### Guest Mode

- Click "Guest mode" on the welcome screen
- You get limited free usage (10 messages, 2 uploads, 2 image gens)
- Guest data is stored locally in your browser
- Sign in at any time to save your chats and get full access

### User Menu

Click your avatar or initials in the top-right corner to access:
- **Settings** — Model management
- **Admin Panel** (admins only) — Model CRUD, user management
- **Sign out**

---

## 9. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` / `Ctrl+K` | Search conversations |
| `⌘N` / `Ctrl+N` | New conversation |
| `⌘B` / `Ctrl+B` | Toggle sidebar |
| `Enter` | Send message |
| `Shift+Enter` | New line in message |
| `Esc` | Close dropdowns/modals |

---

## 10. Settings & Admin Panel

### Settings Page

Accessible from the top-right user menu → **Settings**. Here you can:

- View all available models
- Add custom models (admin only)
- Edit existing models (admin only)
- Delete custom models (admin only)

### Admin Panel

If you have admin privileges, you'll see an **Admin Panel** link in the user menu. The admin panel allows you to:

- **Manage Models** — Add, edit, and delete AI models available to all users
- **Manage Users** — View user profiles and conversation activity
- **Manage Admins** — Add/remove admin email addresses

#### Adding a Model

1. Go to **Settings → Admin Panel → Models**
2. Fill in the model ID (e.g., `openrouter:new/model:free`)
3. Set a display name and provider
4. Toggle Vision support if applicable
5. Click **Add Model**

---

## 11. Troubleshooting

### "Service Unavailable" Error

This means the selected AI provider is experiencing issues. Try:
1. Switching to a different model manually
2. Using **Auto** mode to automatically pick a working model
3. Waiting a few minutes and trying again

### Slow Responses

- **Auto mode** with AgentRouter models may take a moment to route your request
- For fastest responses, manually select **Groq**
- Cold starts on Cloudflare Workers can add 1-2 seconds of latency

### Image Generation Fails

- Check that you're signed in (guest image gen quota may be exhausted)
- Try the **Try different model** button below the failed generation
- Image descriptions work better in English

### PDF Not Processing

- Large PDFs may take a moment to extract text
- Only the first few pages are used as context
- For best results, keep PDFs under 10 pages

### Can't Send Messages (Guest)

- Guest mode has a limit of 10 messages
- Sign in to continue chatting
- Your conversation is preserved when you sign in

---

## 12. FAQ

**Q: Is ChatDDB free?**

A: Yes! ChatDDB uses a mix of free and paid AI providers. Groq and Workers AI offer free tiers. Some models (like ChatGPT and Claude via AgentRouter) consume credits.

**Q: Which model is best for coding?**

A: **Groq (Llama)** is excellent for coding tasks and is the fastest option. For complex debugging, **ChatGPT** or **Claude** may provide better results.

**Q: Can I use ChatDDB on mobile?**

A: Yes! The interface is fully responsive and works on mobile browsers.

**Q: Are my conversations private?**

A: Conversations are stored in Cloudflare D1 (database) and associated with your account. Guest conversations are stored locally in your browser.

**Q: How do I get admin access?**

A: Contact your ChatDDB administrator to have your email added to the admin allowlist.

**Q: My message was cut off mid-response?**

A: Click the **Stop** button and try again. If the issue persists, try switching models.

**Q: Can I export my conversations?**

A: Conversation export is not yet available. You can copy individual responses using the copy button that appears on hover.

---

*ChatDDB v2.0 — Powered by LabDDB*
