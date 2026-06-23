# SillyTavern-ChatUI · Phase 2 Build Contract (Message / Content Area)

> Authoritative source of truth for all agents writing Phase 2 files in this directory.
> DESIGN.md §5 is the product spec; this CONTRACT translates it into unambiguous decisions.
> CONTRACT.md (Phase 1) remains in force — all its rules carry over. This file adds Phase 2 specifics only.
> Nothing here may be overridden per-file. Conflicts → update this CONTRACT first.

---

## 1. Files

Phase 2 message files remain in the extension root (`public/scripts/extensions/third-party/SillyTavern-ChatUI/`) unless this contract names an architecture directory.

Architecture migration files may live in the directories approved by `CONTRACT.md`: `adapter/`, `store/`, `ui/`, and `shield/`.

### New JS files (one agent per file)

| File | Role | DESIGN.md spec section |
|---|---|---|
| `message-layout.js` | Identity header (A) and per-message structural wrapper | §5-A |
| `message-actions.js` | Char action row (B) and user context menu (C) | §5-B, §5-C |
| `message-extras.js` | Reasoning restyle (E), code block header (F) | §5-E, §5-F |
| `chat-chrome.js` | Swipe counter overlay (D), scroll-to-bottom button (G), bottom-regen button (G) | §5-D, §5-G |

### Existing files modified

| File | Change |
|---|---|
| `style.css` | **APPEND only** — one agent owns the append; do not touch existing Phase 1 rules |
| `index.js` | **APPEND imports + wiring** — add Phase 2 imports and init/teardown calls; do not modify existing Phase 1 wiring |

### Import paths (from any Phase 2 UI file in the extension root)

```js
// ChatUI architecture modules
import { chatuiAdapter, stEventKeys }
    from './adapter/st-adapter.js';

import { getChatuiState, getMessageDtoByElement, getMessageDtoById }
    from './store/chat-store.js';

// Sibling Phase 2 modules (relative, same directory)
import { initMessageLayout, teardownMessageLayout }   from './message-layout.js';
import { initMessageActions, teardownMessageActions } from './message-actions.js';
import { initMessageExtras, teardownMessageExtras }   from './message-extras.js';
import { initChatChrome, teardownChatChrome }         from './chat-chrome.js';
```

Phase 2 UI modules must not import SillyTavern runtime modules directly. Use `chatuiAdapter` for ST state, event subscription, generation status, and DOM fallbacks.
Use `store/chat-store.js` selectors for UI-ready message state before reading raw DOM attributes.
Never import jQuery (`$`) directly — use `document.querySelector` / `document.querySelectorAll` for Phase 2 DOM work. When a SillyTavern operation still requires jQuery or DOM-button fallback, keep that fallback inside `adapter/st-adapter.js`.

---

## 2. CSS Naming, Scoping, and New cui- Classes

### Root gate

Every Phase 2 CSS rule that touches the DOM MUST be scoped under `body.chatui-active`. No exceptions.

### Class prefix

Every Phase 2 class uses the prefix **`cui-`**. No other prefix.

### Sentinel / idempotency attribute

Phase 2 uses a **data attribute** (not a class) as the per-message processed guard so it does not conflict with Phase 1 class-based guards:

```
data-cui-p2
```

Set to `'1'` when a message has been fully processed. Removed on teardown and before re-processing.

### Complete cui- class registry for Phase 2

All agents must use exactly these names. No ad-hoc additions.

#### Per-message structural nodes (injected by `message-layout.js`)

| Class | Element | Description |
|---|---|---|
| `cui-msg` | `div` | Outermost Phase 2 wrapper inserted as first child of `.mes_block`; holds all Phase 2 sub-nodes |
| `cui-msg-char` | modifier on `cui-msg` | Present when the message DTO role is `character` |
| `cui-msg-user` | modifier on `cui-msg` | Present when the message DTO role is `user` |
| `cui-msg-system` | modifier on `cui-msg` | Present when the message DTO role is `system` |
| `cui-identity` | `div` | Identity header row (avatar + name + timestamp); child of `cui-msg` |
| `cui-identity-avatar` | `img` | Cloned avatar image inside `cui-identity` |
| `cui-identity-name` | `span` | Character name text inside `cui-identity` |
| `cui-identity-time` | `span` | Timestamp text inside `cui-identity` |

#### Char action row (injected by `message-actions.js`)

| Class | Element | Description |
|---|---|---|
| `cui-action-row` | `div` | Always-visible action bar below char message text; child of `cui-msg` |
| `cui-action-btn` | `button` | Individual action button inside `cui-action-row` |
| `cui-action-copy` | modifier on `cui-action-btn` | Copy button |
| `cui-action-regen` | modifier on `cui-action-btn` | Regenerate button (only when DTO `ui.isLast && isChar`) |
| `cui-action-edit` | modifier on `cui-action-btn` | Edit button |
| `cui-action-overflow` | modifier on `cui-action-btn` | ⋯ overflow — delegates to ST's `.extraMesButtonsHint` |

#### Swipe counter (injected by `message-actions.js`, appended to `cui-action-row` on last char message)

| Class | Element | Description |
|---|---|---|
| `cui-swipe-wrap` | `div` | Swipe counter + buttons wrapper; appended after action buttons in `cui-action-row` |
| `cui-swipe-left` | `button` | ‹ swipe left; triggers ST's `.swipe_left` |
| `cui-swipe-counter` | `span` | `n / m` display; text copied from ST's `.swipes-counter` |
| `cui-swipe-right` | `button` | › swipe right; triggers ST's `.swipe_right` |

#### User context menu (injected by `message-actions.js`)

| Class | Element | Description |
|---|---|---|
| `cui-ctx-handle` | `button` | ⋯ handle appended to user `.ch_name`; click/long-press opens menu |
| `cui-ctx-menu` | `div` | Flat popup menu for user messages |
| `cui-ctx-item` | `button` | Individual item inside `cui-ctx-menu` |

#### Reasoning restyle (injected by `message-extras.js` — CSS only, no new nodes)

No new nodes. CSS classes on existing ST elements:
- ST's `details.mes_reasoning_details` and its descendants are restyled via `body.chatui-active` scoped rules only.
- `message-extras.js` sets `data-duration-label` attribute on `.mes_reasoning_details` elements for the CSS `attr()` trick.

#### Code block header (injected by `message-extras.js`)

| Class | Element | Description |
|---|---|---|
| `cui-code-header` | `div` | Injected as sibling immediately **before** `<pre>`; never inside `<code>` |
| `cui-code-lang` | `span` | Language label inside `cui-code-header` |

Guard attribute on `<pre>`: `data-cui-code-header='1'`. Remove before re-processing.

#### Floating chrome (injected by `chat-chrome.js`)

| Class / ID | Element | Description |
|---|---|---|
| `cui-float-chrome` / `id="cui-float-chrome"` | `div` | Container appended to `#sheld`; absolutely positioned |
| `cui-float-btn` | `button` | Base class for all floating buttons |
| `cui-scroll-btn` / `id="cui-scroll-btn"` | `button` | Scroll-to-bottom button |
| `cui-regen-btn` / `id="cui-regen-btn"` | `button` | Bottom regenerate button |
| `cui-float-hidden` | modifier | Applied by JS when button should be invisible (`opacity:0; pointer-events:none`) |

---

## 3. Settings Schema

### Namespace

Phase 2 settings live in a **separate namespace** from Phase 1:

```js
const MODULE_P2 = 'chatui_messages';
```

This is defined and hydrated in `index.js` alongside the existing `chatui_composer` namespace. Phase 2 modules read `ctx.settings` (which is `extension_settings[MODULE_P2]` after hydration). They never write to `chatui_composer`.

### Default values

```js
const defaultSettingsP2 = {
    // A. Identity header — 3 levels, group and single chat configured separately
    identityHeaderGroup:  'icon',  // 'icon' | 'name' | 'none'
    identityHeaderSingle: 'none',  // 'icon' | 'name' | 'none'

    // B. Char action row — ordered list of visible buttons (overflow always added last)
    charActionRow: ['copy', 'regenerate', 'edit'],

    // C. User context menu — ordered list of flat menu items
    userMenu: ['copy', 'edit', 'delete', 'branch', 'checkpoint', 'hide'],

    // D. Swipe style (currently only 'buttons'; 'gesture' is a future TODO per DESIGN §7)
    swipeStyle: 'buttons',

    // E. Reasoning block default state
    reasoningCollapsed: true,

    // F. Code language header
    codeHeader: true,

    // G. Floating chrome
    scrollToBottom: true,
    bottomRegen: true,
};
```

### Hydration (added to `index.js` alongside existing `getSettings()`)

```js
function getSettingsP2() {
    if (!extension_settings[MODULE_P2]) {
        extension_settings[MODULE_P2] = structuredClone(defaultSettingsP2);
    }
    const s = extension_settings[MODULE_P2];
    const d = defaultSettingsP2;
    const HEADER_VALS = ['icon', 'name', 'none'];
    if (!HEADER_VALS.includes(s.identityHeaderGroup))  s.identityHeaderGroup  = d.identityHeaderGroup;
    if (!HEADER_VALS.includes(s.identityHeaderSingle)) s.identityHeaderSingle = d.identityHeaderSingle;
    if (!Array.isArray(s.charActionRow))               s.charActionRow        = [...d.charActionRow];
    if (!Array.isArray(s.userMenu))                    s.userMenu             = [...d.userMenu];
    if (!['buttons'].includes(s.swipeStyle))           s.swipeStyle           = d.swipeStyle;
    if (typeof s.reasoningCollapsed !== 'boolean')     s.reasoningCollapsed   = d.reasoningCollapsed;
    if (typeof s.codeHeader         !== 'boolean')     s.codeHeader           = d.codeHeader;
    if (typeof s.scrollToBottom     !== 'boolean')     s.scrollToBottom       = d.scrollToBottom;
    if (typeof s.bottomRegen        !== 'boolean')     s.bottomRegen          = d.bottomRegen;
    return s;
}
```

`saveSettingsDebounced()` (imported from `'../../../../script.js'`) is called after any mutation. Never call `saveSettings()` directly.

---

## 4. Module Interface — Exact Exported Names

### `message-layout.js`

```js
/**
 * Init Phase 2 identity header and per-message structural wrapper.
 * Sweeps existing #chat .mes on call, then hooks future render events.
 * @param {CuiCtx} ctx
 */
export function initMessageLayout(ctx): void

/**
 * Remove all identity headers and structural wrappers; unbind all listeners.
 */
export function teardownMessageLayout(): void
```

Internal (not exported):
- `processLayoutMessage(mesEl)` — idempotent via `data-cui-p2`; injects `cui-msg` wrapper + `cui-identity` header.
- `sweepLayoutMessages()` — calls `processLayoutMessage` on every `#chat .mes[mesid]`.
- `unprocessLayoutMessage(mesEl)` — removes `data-cui-p2`, removes `.cui-msg` child.

### `message-actions.js`

```js
/**
 * Init char action row (B) and user context menu (C).
 * @param {CuiCtx} ctx
 */
export function initMessageActions(ctx): void

/**
 * Remove all action rows and context menu handles; unbind all listeners.
 */
export function teardownMessageActions(): void
```

Internal (not exported):
- `processActionsMessage(mesEl)` — idempotent guard via checking `.cui-action-row` / `.cui-ctx-handle` existence; removes + re-injects on every call to be safe.
- `sweepActionsMessages()` — calls `processActionsMessage` on every `#chat .mes[mesid]`.
- Message action dispatch — use `chatuiAdapter.messageActions.*`; see §5-B/C for action dispatch table.

### `message-extras.js`

```js
/**
 * Init reasoning restyle (E) and code block headers (F).
 * @param {CuiCtx} ctx
 */
export function initMessageExtras(ctx): void

/**
 * Remove all code headers, reasoning data attributes; unbind all listeners.
 */
export function teardownMessageExtras(): void
```

Internal (not exported):
- `processExtrasMessage(mesEl)` — calls `injectCodeHeaders(mesEl)` and `applyReasoningLabels(mesEl)`.
- `injectCodeHeaders(mesEl)` — idempotent via `data-cui-code-header` on `<pre>`.
- `applyReasoningLabels(mesEl)` — sets `data-duration-label` on `.mes_reasoning_details`.
- `sweepExtrasMessages()` — calls `processExtrasMessage` on every `#chat .mes[mesid]`.
- `teardownCodeHeaders()` — restores `.code-copy` button inside `<code>`, removes `cui-code-header` nodes.

### `chat-chrome.js`

```js
/**
 * Init swipe overlay (D inside action row), scroll-to-bottom button (G), bottom-regen (G).
 * @param {CuiCtx} ctx
 */
export function initChatChrome(ctx): void

/**
 * Remove floating chrome, unbind scroll listener; remove swipe overlays from action rows.
 */
export function teardownChatChrome(): void
```

Internal (not exported):
- `injectFloatingChrome()` — idempotent via `id='cui-float-chrome'` existence check; appends to `#sheld`.
- `refreshFloatVisibility()` — toggles `cui-float-hidden` based on scroll position and Store last-message state.
- `_scrollHandler` — named function ref stored in module-level variable; bound/unbound in init/teardown.

---

## 5. Behaviour Specification (DESIGN.md §5 A–G mapped to real selectors/events)

### A. Identity Header (`message-layout.js`)

**Three display levels** (configured separately for group vs single chat):
- `'icon'`: inject `cui-identity` div containing a resolved avatar image, a `cui-identity-name` span from the message DTO, and a `cui-identity-time` span with rendered timestamp text.
- `'name'`: inject `cui-identity` div with `cui-identity-name` + `cui-identity-time` only; no avatar image.
- `'none'`: do not inject `cui-identity` at all.

**Group vs single detection**: `isGroup = chatuiAdapter.getIsGroupChat()` — call at use-time inside `processLayoutMessage`, not at init-time.

**Message classification** comes from `store/chat-store.js` DTOs:
```js
const dto = getMessageDtoByElement(mesEl);
const isUser = dto.isUser;
const isSystem = dto.isSystem;
const isChar = dto.isChar;
```

**When to inject identity header**:
- Char messages (`isChar === true`): apply group or single setting.
- User messages (`isUser === true`): never inject `cui-identity` (user has no avatar header in spec).
- System messages (`isSystem === true`): never inject `cui-identity`.
- DTO `extra.isSmallSys` and `extra.isToolCall` messages: skip all Phase 2 layout decoration entirely (early return).

**`cui-msg` wrapper**:
- Create a `<div class="cui-msg cui-msg-char">` (or `cui-msg-user` / `cui-msg-system`).
- Insert as **first child** of `.mes_block` (before `.ch_name`, `.mes_text`, etc.).
- `cui-identity` is appended inside `cui-msg`.

**Idempotency**: guard with `data-cui-p2` on the `.mes` element. `processLayoutMessage` returns early if `data-cui-p2` is already set. On re-process (swipe, edit, chat-change), remove `data-cui-p2` and remove `.cui-msg` before re-running.

**Events bound in `initMessageLayout`**:

| Event | Handler |
|---|---|
| `CHARACTER_MESSAGE_RENDERED` | `(mesId) => processLayoutMessage(querySelector(mesId))` |
| `USER_MESSAGE_RENDERED` | `(mesId) => processLayoutMessage(querySelector(mesId))` |
| `MESSAGE_SWIPED` | strip `data-cui-p2` + strip `.cui-msg`, rerun `processLayoutMessage` |
| `MESSAGE_UPDATED` | strip `data-cui-p2` + strip `.cui-msg`, rerun `processLayoutMessage` |
| `CHAT_CHANGED` | `setTimeout(() => sweepLayoutMessages(), 0)` |
| `MORE_MESSAGES_LOADED` | `sweepLayoutMessages()` (idempotent, skips already-processed) |

**Events NOT bound**: `MESSAGE_EDITED` (use `MESSAGE_UPDATED` instead — fires after `.mes_text` is fully re-rendered), `MESSAGE_SENT` (DOM node may not exist yet).

### B. Char Action Row (`message-actions.js`)

**Always visible** (not hover-dependent) on all char messages. Injected as a child of `cui-msg` (which is inside `.mes_block`), below the message text.

**Button set** driven by `ctx.settings.charActionRow` array. Supported values and their triggers:

| Action id | Trigger |
|---|---|
| `'copy'` | `chatuiAdapter.messageActions.copyMessage(mesEl)` |
| `'regenerate'` | Only rendered when the message DTO has `ui.isLast && isChar`. Click calls `chatuiAdapter.messageActions.regenerateMessage()` |
| `'edit'` | `chatuiAdapter.messageActions.editMessage(mesEl)` |

Overflow button `⋯` (`cui-action-overflow`) is **always appended last**, regardless of `charActionRow` setting. Its menu proxies ST extra actions through adapter methods:
```js
chatuiAdapter.messageActions.isOverflowActionVisible(item, {
    isSystem: messageDto.isSystem,
    mediaDisplay,
});
chatuiAdapter.messageActions.triggerOverflowAction(original);
```

**Edit-mode hiding**: while ST is editing the message, `.mes_edit_buttons` is `display:inline-flex`. The `cui-action-row` must be hidden while in this state. Implement via CSS:
```css
body.chatui-active .mes:has(.mes_edit_buttons:not([style*="display: none"])) .cui-action-row {
    display: none;
}
```
If `:has()` is unavailable (covered by ST's own `@supports not selector(:has(*))` guard), fall back to hiding via a class toggled by the `MESSAGE_EDITED` / `MESSAGE_UPDATED` event pair.

**Idempotency**: `processActionsMessage` removes `.cui-action-row` and `.cui-ctx-handle` then re-injects. No separate guard attribute needed for actions — the layout `data-cui-p2` sentinel is on the same `.mes` element and both modules process together. However `message-actions.js` may be called independently; guard by checking `document.body.classList.contains('chatui-active')` at entry.

**Events bound in `initMessageActions`**: same set as `initMessageLayout` — mirror exactly:
`CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED`, `MESSAGE_SWIPED`, `MESSAGE_UPDATED`, `CHAT_CHANGED` (with `setTimeout 0`), `MORE_MESSAGES_LOADED`.

### C. User Context Menu (`message-actions.js`, same file as B)

**Trigger mechanism**:
- Mobile: `touchstart`/`touchend` long-press (500 ms threshold) on a `.mes` whose DTO role is `user`.
- Desktop: hover-reveals `cui-ctx-handle` (CSS `opacity` on `.mes:hover .cui-ctx-handle`) + `contextmenu` event on a `.mes` whose DTO role is `user`.

**`cui-ctx-handle`** is a `<button>` appended to the user message `.ch_name` div. Clicking it (or long-press, or right-click) shows `cui-ctx-menu`.

**`cui-ctx-menu`** is a `<div>` appended directly to the `.mes` element (not to body), positioned via CSS. Contains one `<button class="cui-ctx-item">` per entry in `ctx.settings.userMenu`.

**Supported actions and triggers**:

`message-actions.js` calls `chatuiAdapter.messageActions.triggerMessageAction(mesEl, action)`.
Any SillyTavern DOM-button fallback stays inside `adapter/st-adapter.js`.

| Action | Trigger |
|---|---|
| `'copy'` | `chatuiAdapter.messageActions.copyMessage(mesEl)` |
| `'edit'` | `chatuiAdapter.messageActions.editMessage(mesEl)` |
| `'delete'` | `chatuiAdapter.messageActions.deleteMessage(mesEl)` |
| `'branch'` | `chatuiAdapter.messageActions.createBranch(mesEl)` |
| `'checkpoint'` | `chatuiAdapter.messageActions.createCheckpoint(mesEl)` |
| `'hide'` | `chatuiAdapter.messageActions.toggleHideMessage(mesEl)` |

After any action click, remove `cui-ctx-menu` from the DOM.

Close `cui-ctx-menu` on `document` click-outside (one-shot listener added when menu is opened, removed on close or on next `document` click).

Long-press on mobile: start a `setTimeout(500)` on `touchstart`; cancel on `touchend` if < 500 ms. Show menu at touch point. Cancel the `contextmenu` event to prevent system menu.

**No** right-click popup on mobile (use long-press only). **No** hover-reveal on mobile (not applicable).

### D. Swipe Counter Overlay (`chat-chrome.js`)

Swipe UI is **part of `cui-action-row`** and is injected by `message-actions.js`.

**Render condition**: only when the message DTO has `ui.isLast && isChar`. Swipe buttons delegate through `chatuiAdapter.messageActions.swipeMessage(...)`.

**Counter source**: do NOT parse `.swipes-counter` text (it contains U+200B). Read from the message DTO:
```js
const label = getMessageDtoByElement(mesEl)?.swipe.label ?? '';
```

**Trigger swipes through the adapter**:
```js
cuiSwipeLeft.addEventListener('click', () => {
    chatuiAdapter.messageActions.swipeMessage(mesEl, 'left');
});
cuiSwipeRight.addEventListener('click', () => {
    chatuiAdapter.messageActions.swipeMessage(mesEl, 'right');
});
```

**Re-evaluate on**: `MESSAGE_SWIPED`, `CHARACTER_MESSAGE_RENDERED`, `CHAT_CHANGED`, `MORE_MESSAGES_LOADED`. Also update the counter text after `MESSAGE_SWIPED` (the label changes).

**Teardown**: remove `cui-swipe-wrap` from all action rows.

### E. Reasoning Block Restyle (`message-extras.js`)

**Approach**: CSS only for visual restyle; minimal JS only for `data-duration-label` attribute injection. Never touch `details.open`, never call `.toggle()`, never restructure the `<details>` element.

**CSS target** (in `style.css` append): restyle `body.chatui-active .mes_reasoning_header` as a pill; restyle `body.chatui-active .mes_reasoning` for lighter text. See Research snippet for full CSS. Do not override `transform` on `.mes_reasoning_arrow` (ST's own rotation logic must survive).

**`data-duration-label` injection** (`applyReasoningLabels(mesEl)`):
```js
mesEl.querySelectorAll('.mes_reasoning_details[data-duration]').forEach(el => {
    const raw = el.dataset.duration;
    if (!raw || raw === 'unknown') return;
    const sec = parseFloat(raw);
    if (isNaN(sec)) return;
    el.setAttribute('data-duration-label',
        sec < 60 ? `Thought for ${Math.round(sec)}s` : `Thought for ${Math.round(sec / 60)}m`);
});
```

**Default collapsed**: `ctx.settings.reasoningCollapsed` is `true`. Implement via CSS: `body.chatui-active .mes_reasoning_details[data-state="done"] { /* no forced open */ }`. ST already defaults to closed unless `power_user.reasoning.auto_expand` is true — the extension does not override that preference; it only reskins.

**Events**: same sweep pattern — `CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED`, `MESSAGE_SWIPED`, `MESSAGE_UPDATED`, `CHAT_CHANGED` (setTimeout 0), `MORE_MESSAGES_LOADED`. Also add `STREAM_REASONING_DONE` to update the label when thinking finishes mid-stream:
```js
chatuiAdapter.subscribe(stEventKeys.STREAM_REASONING_DONE, () => sweepExtrasMessages());
```

**Teardown**: remove all `data-duration-label` attributes. CSS is removed by removal of `body.chatui-active` (gate disappears on teardown).

**Guard**: if `ctx.settings.codeHeader` or reasoning-specific gate is needed, check `document.body.classList.contains('chatui-active')` at entry to each processor function. No per-message attribute guard is needed for reasoning (CSS-only restyle is always safe to re-apply).

### F. Code Block Header (`message-extras.js`, same file as E)

**Guard attribute**: `data-cui-code-header='1'` on the `<pre>` element. Skip if already present. Remove before re-processing on swipe/edit.

**Injection site**: insert `<div class="cui-code-header">` as a sibling **immediately before** `<pre>` — never inside `<code>`.

**Language detection**:
```js
let lang = '';
for (const cls of codeEl.classList) {
    const m = cls.match(/^language-(.+)$/);
    if (m) { lang = m[1]; break; }
}
```

**Copy button**: move ST's existing `i.code-copy` (inside `<code>`) into `cui-code-header` as the rightmost child. This preserves its existing event listeners. On teardown, return it to `<code>`.

**Only inject when `ctx.settings.codeHeader === true`**. If `false`, skip `injectCodeHeaders` entirely.

**Events**: `CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED`, `MESSAGE_UPDATED`, `MESSAGE_SWIPED` (strip `data-cui-code-header` guards then re-sweep that message), `MORE_MESSAGES_LOADED`, `CHAT_LOADED` (not `CHAT_CHANGED` — CHAT_CHANGED fires before messages are re-rendered; CHAT_LOADED fires after).

**Teardown** (`teardownCodeHeaders()`):
1. For each `.cui-code-header`, find its `nextElementSibling` (`<pre>`).
2. Move `i.code-copy` back into `pre > code` as last child.
3. Remove `data-cui-code-header` from `<pre>`.
4. Remove the `.cui-code-header` element.

### G. Floating Chrome (`chat-chrome.js`)

**Mount point**: `#sheld`. The container `#cui-float-chrome` is appended as the **last child** of `#sheld` (sibling of `#chat`, not inside it). The floating container is viewport-positioned; do not add `position: relative` to `#sheld`.

**Scroll-to-bottom button** (`cui-scroll-btn`):
- Shown when NOT at bottom: `Math.abs(chat.scrollHeight - chat.clientHeight - chat.scrollTop) >= 5`.
- Hidden (`cui-float-hidden`) when at bottom or when `ctx.settings.scrollToBottom === false`.
- Click: `chatuiAdapter.scrollChatToBottom()` (unconditional — bypasses `power_user.auto_scroll_chat_to_bottom` gate).
- Visibility updated by passive `scroll` listener on `#chat`. Store handler ref in module-level `let _scrollHandler = null` for teardown.

**Bottom-regen button** (`cui-regen-btn`):
- Shown when `ctx.settings.bottomRegen === true`, `getChatuiState().chat.lastMessageNeedsGenerate === true`, and `!chatuiAdapter.getGenerationState().isGenerating`.
- Click: `chatuiAdapter.messageActions.regenerateLast()`.
- Visibility re-evaluated on: `MESSAGE_SWIPED`, `GENERATION_ENDED`, `CHAT_CHANGED`, `MESSAGE_SENT`, `CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED`.

**Injects once** (`injectFloatingChrome()` is idempotent via `document.getElementById('cui-float-chrome')` check).

**Teardown** (`teardownChatChrome()`):
1. `_chat.removeEventListener('scroll', _scrollHandler)` (named ref).
2. `document.getElementById('cui-float-chrome')?.remove()`.
3. Message swipe wraps are owned by `message-actions.js`, not by chrome teardown.
4. Call every unsubscribe returned by `chatuiAdapter.subscribe(...)`.

---

## 6. Idempotency, Re-apply-on-Events, and Teardown Rules

### Per-message idempotency

Each layout/actions/extras processor follows the same pattern. The Phase 2 modules share one sentinel: `data-cui-p2` on the `.mes` element. The sentinel is set by `message-layout.js` after it finishes. The other modules (`message-actions.js`, `message-extras.js`) do NOT rely on this sentinel — they instead check for existence of their own injected nodes (`.cui-action-row`, `.cui-ctx-handle`, `pre[data-cui-code-header]`) before injecting.

**Standard re-process pattern** (same in all three per-message modules):

```js
function processXMessage(mesEl) {
    if (!document.body.classList.contains('chatui-active')) return;
    const dto = getMessageDtoByElement(mesEl);
    if (!dto || dto.extra.isSmallSys || dto.extra.isToolCall) return;
    // Remove previous injection (safe if absent)
    mesEl.querySelectorAll('.cui-<module-specific-class>').forEach(n => n.remove());
    // Inject fresh
    // ...
}
```

### Listener management pattern (all four modules)

All Phase 2 UI modules use adapter subscriptions and the same `_listeners` accumulator pattern to enable clean teardown:

```js
/** @type {Array<() => void>} */
let _listeners = [];

function _on(type, fn) {
    _listeners.push(chatuiAdapter.subscribe(type, fn));
}

export function teardownXxx() {
    for (const unsubscribe of _listeners) {
        unsubscribe();
    }
    _listeners = [];
    // ... remove DOM nodes ...
}
```

### Swipe re-process semantics

On `MESSAGE_SWIPED` (payload: `mesId` number), ST mutates the `.mes` node **in place** — the node itself survives but `.mes_text`, `.ch_name`, `.timestamp`, and the swipe counter are overwritten by `updateMessageElement`. Injected siblings at the `.mes` level survive.

Therefore on `MESSAGE_SWIPED`:
- **`message-layout.js`**: the `cui-msg` wrapper (inside `.mes_block`) may have its surrounding `.ch_name` / `.mes_text` re-rendered; remove and re-inject `cui-identity` header.
- **`message-actions.js`**: the `cui-action-row` is inside `cui-msg` (inside `.mes_block`) — it survives but regenerate button visibility may have changed if the Store DTO's `ui.isLast` state changed. Remove and re-inject.
- **`message-extras.js`**: `.mes_text` was overwritten; strip `pre[data-cui-code-header]` guards and re-inject code headers. Strip and re-set `data-duration-label`.
- **`chat-chrome.js`**: update `cui-swipe-wrap` counter text; re-evaluate floating chrome visibility.

### CHAT_CHANGED re-sweep timing

`CHAT_CHANGED` fires before `printMessages` completes. All sweep calls on `CHAT_CHANGED` MUST use `setTimeout(() => sweep(), 0)` to let ST's DOM rebuild finish first.

Exception: `CHAT_LOADED` fires after `printMessages`. Use `CHAT_LOADED` (not `CHAT_CHANGED`) for code header injection since `CHAT_LOADED` guarantees messages are in the DOM.

### Teardown completeness

After `teardownChatChrome()` + `teardownMessageExtras()` + `teardownMessageActions()` + `teardownMessageLayout()` (in that order), ALL of the following must be true:

- `document.getElementById('cui-float-chrome')` → `null`
- `document.querySelectorAll('[data-cui-p2]')` → empty
- `document.querySelectorAll('[data-cui-code-header]')` → empty
- `document.querySelectorAll('[data-duration-label]')` → empty (all `data-duration-label` attributes removed)
- `document.querySelectorAll('.cui-msg')` → empty
- `document.querySelectorAll('.cui-action-row')` → empty
- `document.querySelectorAll('.cui-ctx-handle')` → empty
- `document.querySelectorAll('.cui-code-header')` → empty
- `document.querySelectorAll('.cui-swipe-wrap')` → empty
- All `i.code-copy` buttons are back inside their respective `<code>` elements
- No `body.chatui-active` class (removed by `index.js` after module teardowns)
- Calling any teardown function a second time is a no-op (guard with null/empty checks)

---

## 7. index.js Integration (APPEND to existing index.js)

Add to imports at the top of `index.js`:

```js
import { initMessageLayout, teardownMessageLayout } from './message-layout.js';
import { initMessageActions, teardownMessageActions } from './message-actions.js';
import { initMessageExtras, teardownMessageExtras } from './message-extras.js';
import { initChatChrome, teardownChatChrome } from './chat-chrome.js';
```

Add the Phase 2 settings module constant and `getSettingsP2()` function (see §3).

Update `buildCtx()` to pass Phase 2 settings when Phase 2 modules are being initialized (pass `getSettingsP2()` as the settings object for Phase 2 `init*` calls, or extend `CuiCtx` with a `settingsP2` property):

```js
function buildCtx() {
    return {
        settings:   getSettings(),    // Phase 1 (chatui_composer)
        settingsP2: getSettingsP2(),  // Phase 2 (chatui_messages)
    };
}
```

Each Phase 2 module receives the full `ctx` and reads `ctx.settingsP2` for its settings. ST runtime state comes from `chatuiAdapter`, not from `ctx`.

Update `setup()` — add Phase 2 inits AFTER Phase 1 inits, BEFORE `body.chatui-active` is set:

```js
function setup() {
    if (isSetup) return;
    const ctx = buildCtx();
    // Phase 1
    initComposer(ctx);
    initPlusMenu(ctx);
    initSelector(ctx);
    initQr(ctx);
    // Phase 2
    initMessageLayout(ctx);
    initMessageActions(ctx);
    initMessageExtras(ctx);
    initChatChrome(ctx);

    document.body.classList.add('chatui-active');
    isSetup = true;
}
```

Update `teardown()` — Phase 2 teardowns run BEFORE Phase 1 teardowns, in reverse init order:

```js
function teardown() {
    if (!isSetup) return;
    // Phase 2 first (reverse order)
    teardownChatChrome();
    teardownMessageExtras();
    teardownMessageActions();
    teardownMessageLayout();
    // Phase 1
    teardownQr();
    teardownSelector();
    teardownPlusMenu();
    teardownComposer();

    document.body.classList.remove('chatui-active');
    isSetup = false;
}
```

---

## 8. style.css Append (one agent only)

The CSS agent appends a clearly-delimited Phase 2 block to the END of the existing `style.css`. Do not modify any existing Phase 1 rules.

```css
/* ═══════════════════════════════════════════════════════════════════════════
   ChatUI Phase 2 — Message / Content Area
   All rules scoped under body.chatui-active
   ═══════════════════════════════════════════════════════════════════════════ */
```

### Required CSS sections (in order inside the append block)

1. **`#sheld` stacking context** — `body.chatui-active #sheld { position: relative; }`

2. **`cui-msg` wrapper** — flex column, no margin/padding changes that break ST's message layout.

3. **`cui-identity` header** — flex row, avatar image sized 1.5rem, name bold, time dimmed. Hidden (`display:none`) when `ctx.settingsP2.identityHeaderGroup/Single === 'none'` is handled in JS (don't inject the node); CSS does not gate on settings.

4. **`cui-action-row`** — `display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap` inline with the message; `opacity:0.6` at rest, `1.0` on hover of parent `.mes`.

5. **`cui-action-btn` variants** — minimal pill buttons; icon + optional text; no border by default, subtle background on hover.

6. **Edit-mode hide rule**:
```css
body.chatui-active .mes:has(.mes_edit_buttons:not([style*="display: none"])) .cui-action-row {
    display: none;
}
```

7. **`cui-ctx-handle`** — hidden by default on desktop, `opacity:0`, transitions to `opacity:1` on `.mes:hover`. On mobile, hidden (long-press shows menu directly without the handle being visible).

8. **`cui-ctx-menu`** — absolute positioned card with shadow; `z-index: 100`; `display:none` → `display:flex; flex-direction:column` when active.

9. **`cui-swipe-wrap`** — `display:flex; align-items:center; gap:0.25rem; margin-left:auto` (pushes swipe to right end of action row). `cui-swipe-counter` fixed-width monospace.

10. **Reasoning restyle** — see Research §E snippet. Must include:
    - `.mes_reasoning_header` pill style
    - `::before` spark icon
    - `.mes_reasoning_header_title` color-transparent trick + `::after` overlay
    - `[data-duration="unknown"]::after` and `[data-duration-label]::after` content rules
    - `.mes_reasoning` dimmed text
    - Do NOT override `.mes_reasoning_arrow` transform

11. **`cui-code-header`** — flex row, language label left, copy button right, subtle border-bottom that visually connects to the `<pre>` below.

12. **`cui-float-chrome`** — `position:absolute; bottom: calc(var(--cui-composer-height, 4rem) + 0.75rem); right: 1rem; display:flex; flex-direction:column; gap:0.5rem; z-index:50; pointer-events:none`.

13. **`cui-float-btn`** — `pointer-events:auto; width:2.5rem; height:2.5rem; border-radius:50%; border:1px solid var(--SmartThemeBorderColor); background:var(--SmartThemeBlurTintColor); color:var(--SmartThemeBodyColor); cursor:pointer; display:flex; align-items:center; justify-content:center; transition:opacity 0.15s`.

14. **`cui-float-hidden`** — `opacity:0; pointer-events:none`.

15. **Responsive overrides** — `@media (max-width: 768px)` for mobile: hide `cui-ctx-handle`, adjust `cui-action-row` font sizes, ensure `cui-float-chrome` bottom clears the mobile composer height.

---

## 9. ESLint Cleanliness

All Phase 1 ESLint rules from CONTRACT.md §8 apply identically to Phase 2 files.

Additional Phase 2 specifics:
- Message type, last-message state, swipe label, and generated-action visibility come from `store/chat-store.js` DTOs/selectors, not `.mes` attributes/classes.
- Do not import `$` from anywhere. If a jQuery-bound ST fallback is still needed, put it in `adapter/st-adapter.js`.
- `getContext()` is called at **use-time** inside adapter functions, never stored in module-level variables.
- `isGenerating()` from SillyTavern runtime belongs in `adapter/st-adapter.js`; UI modules read `chatuiAdapter.getGenerationState()`.
- No `console.log` in committed code. `console.warn('[ChatUI P2]', ...)` is acceptable for genuine error conditions.
- All module-level variables that hold listener refs or DOM state are prefixed with `_` (e.g. `_listeners`, `_scrollHandler`).
- New module skeleton:
```js
import { chatuiAdapter, stEventKeys } from './adapter/st-adapter.js';

/** @type {Array<() => void>} */
let _listeners = [];

function _on(type, fn) {
    _listeners.push(chatuiAdapter.subscribe(type, fn));
}

/** Init identity headers and per-message structural wrappers. @param {CuiCtx} ctx */
export function initMessageLayout(ctx) { /* ... */ }

/** Remove all layout decorations; unbind all listeners. */
export function teardownMessageLayout() { /* ... */ }
```

No default exports. All exports are named. No side effects at module top level.

---

## 10. What Is Out of Scope for Phase 2

Do not add stubs or placeholders for:
- Gesture-based swipe (DESIGN §7 TODO)
- Per-message context menu drag-to-reorder settings
- Settings UI controls for Phase 2 settings (hardcode defaults; settings UI comes with the config panel work in Phase 3)
- Sidebar / navigation panel (Phase 3)
- Top bar rework (Phase 3)
- Slot A selector (Phase 3)
- Waifu mode swipe-button special case (not required for MVP; add comment referencing the gotcha in research if near that code path)
