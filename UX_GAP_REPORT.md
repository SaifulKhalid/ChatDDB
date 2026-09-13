# ChatDDB UX Gap Report — Forensic Audit

## P0 — Clearly makes ChatDDB feel unfinished

### 1. Send feels slow — user message appears after network
**Problem:** `runTurn` awaits `createSession()` before optimistic update. First message in new chat has 200-600ms dead air.
**Why users perceive:** Press Send → nothing happens → then message appears. ChatGPT shows user bubble instantly.
**Evidence:** `ChatApp.tsx:178-225` — session creation before `setMessages`
**Fix:** Optimistic local conversation + immediate user bubble, reconcile id on response
**Files:** `ChatApp.tsx`
**Risk:** Low — need temp id handling

### 2. Streaming feels bursty / janky scroll
**Problem:** Auto-scroll uses direct `scrollTop = scrollHeight` on every token, no rAF, no smooth anchoring. Pinned threshold 60px is tight.
**Why:** Reading position jumps, especially with code/math.
**Evidence:** `ChatArea.tsx:42-45`, `api.ts:136-172` pacing 700ms budget
**Fix:** rAF scroll, larger threshold, preserve position, tune pacing to 400ms
**Files:** `ChatArea.tsx`, `lib/api.ts`
**Risk:** Low

### 3. Empty state feels disconnected
**Problem:** Composer at bottom, empty state centered separately. No central focus. Suggestion tiles are plain borders.
**Why:** ChatGPT centers composer in empty state — feels ready. ChatDDB feels like two separate areas.
**Evidence:** `ChatArea.tsx:53-77`, `Composer.tsx:117`
**Fix:** Centered empty layout, polished tiles with icons, better hierarchy
**Files:** `ChatArea.tsx`, `Composer.tsx`
**Risk:** Medium — layout change

### 4. Markdown re-renders entire response on every token
**Problem:** `ReactMarkdown` re-parses full content each delta. No memoization of previous tokens, causes layout shift on partial fences.
**Why:** Code block flickers from paragraph → code block mid-stream.
**Evidence:** `MessageItem.tsx:324-330`
**Fix:** Memoize source, add stable wrapper, handle incomplete fences gracefully
**Files:** `MessageItem.tsx`, `index.css`
**Risk:** Medium

## P1 — Significant quality difference

### 5. Composer doesn't feel primary
**Problem:** No auto-focus on new chat, no focus after conversation switch, attachment tray detached styling, send button no transition.
**Evidence:** `Composer.tsx:70-76`, `ChatApp.tsx:155-160`
**Fix:** Auto-focus, better tray integration, polished send/stop transition
**Files:** `Composer.tsx`, `ChatApp.tsx`
**Risk:** Low

### 6. Sidebar desktop toggle is instant hide (no animation)
**Problem:** `md:hidden` + `md:transition-none` makes desktop toggle jarring. Mobile actions hidden behind hover.
**Evidence:** `Sidebar.tsx:98-99`, `161-211`
**Fix:** Width transition, always-visible overflow menu on mobile, delete confirm
**Files:** `Sidebar.tsx`
**Risk:** Low

### 7. Model picker feels like dev control panel
**Problem:** Segmented control with 5-6 options above composer, always visible, technical names.
**Evidence:** `ModelPicker.tsx:92-130`, `Composer.tsx:121-133`
**Fix:** More subtle, dropdown-style or collapsed, better Auto explanation
**Files:** `ModelPicker.tsx`, `Composer.tsx`
**Risk:** Medium — UX decision

### 8. Error handling is banner-only, not inline actionable
**Problem:** Red banner at top, not dismissible, no retry. Message error shows generic "switch to Auto".
**Evidence:** `ChatApp.tsx:647-651`, `MessageItem.tsx:338-347`
**Fix:** Dismissible banner, inline retry, better error copy
**Files:** `ChatApp.tsx`, `MessageItem.tsx`
**Risk:** Low

### 9. Thinking → streaming transition is abrupt
**Problem:** Hard swap from `<ThinkingIndicator/>` to markdown div, no fade.
**Evidence:** `MessageItem.tsx:312-334`
**Fix:** Cross-fade, keep height stable
**Files:** `MessageItem.tsx`, `ThinkingIndicator.tsx`, `index.css`
**Risk:** Low

## P2 — Polish

### 10. Typography system is generic
**Problem:** System sans, small heading scale (1.35rem h1), line-height 1.75 generous but not tuned, code font system mono.
**Evidence:** `index.css:5-10`, `94-123`
**Fix:** Refine scale, line-height 1.7, better heading hierarchy, Inter-like stack
**Files:** `index.css`
**Risk:** Low

### 11. User bubble vs assistant layout inconsistency
**Problem:** User bubble max-w-[85%] rounded-3xl, assistant with Logo 26 and gap-3. Spacing gap-6 between messages is large.
**Evidence:** `MessageItem.tsx:122-145`, `ChatArea.tsx:87`
**Fix:** Tighter rhythm, better bubble contrast, consistent max-width
**Files:** `MessageItem.tsx`, `ChatArea.tsx`, `index.css`
**Risk:** Low

### 12. Mobile viewport not handling keyboard / safe area
**Problem:** No dvh, no safe-area-inset, composer may be hidden behind keyboard.
**Evidence:** `index.css:33-37`, `Composer.tsx:117`
**Fix:** Use dvh, safe area padding, better mobile composer
**Files:** `index.css`, `Composer.tsx`, `ChatArea.tsx`
**Risk:** Low

### 13. No reduced-motion support
**Problem:** Animations run regardless of prefers-reduced-motion.
**Evidence:** `index.css:62-92`
**Fix:** Media query to disable
**Files:** `index.css`
**Risk:** Low

## P3 — Nice-to-have

- Sidebar resizable width
- Message timestamps on hover
- Copy code block line numbers
- Search debounce + highlight
- Keyboard shortcuts (Cmd+K for new chat, etc.)
