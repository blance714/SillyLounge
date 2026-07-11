# SillyTavern-ChatUI · Phase 1 Build Contract (Composer Only)

> ⚠️ **SUPERSEDED / HISTORICAL — archived 2026-06-23.**
> This contract governed the retired Phase 1 approach: reshaping SillyTavern's
> native `#send_form` DOM in place (composer wrap, plus-menu, selector B, QR
> float). That path has been removed. The visible composer is now the Preact
> root app (`ui/components/Composer.tsx`), and the modules this contract
> specified — `composer.js`, `plus-menu.js`, `selector.js`, `qr.js` — have been
> deleted. The document is kept only as a record of the original design and the
> SillyTavern DOM gotchas it captured. For the current architecture see
> `ARCHITECTURE.md` and `STATUS.md`.

> Historical constraints only. They do not govern current files or override
> `DESIGN.md`, `ARCHITECTURE.md`, or the Preact implementation under `src/`.

---

## 1. File Layout

Phase 1 production files are flat in the extension root (`public/scripts/extensions/third-party/SillyTavern-ChatUI/`).

Architecture migration files may live in subdirectories. The approved directories are:

| Directory | Role |
|---|---|
| `adapter/` | Boundary to SillyTavern runtime, context, events, and DOM fallbacks |
| `store/` | ChatUI view-model state and actions |
| `ui/` | ChatUI-owned rendering modules |
| `shield/` | Visibility and lifecycle handling for original SillyTavern DOM |

Do not add other directories without updating this contract.

| File | Role |
|---|---|
| `manifest.json` | Extension descriptor |
| `index.js` | Entry point — orchestrates init/teardown, owns settings schema, injects settings UI |
| `style.css` | All CSS. Single file. Every rule scoped under `body.chatui-active` except `:root` custom properties |
| `composer.js` | DOM wrap of `#send_form`, single/multi-line toggle, QR float, exposes slots |
| `plus-menu.js` | `+` button menu: half-sheet (mobile) / popup (desktop), pinned tiles + tool list |
| `selector.js` | Selector B dropdown (preset / model / persona), proxy to ST's real selects |
| `qr.js` | Relocates `#qr--bar` above composer; survives QR's rebuild-on-CHAT_CHANGED |

### Import paths (from any Phase 1 file in the extension root)

```js
// ST core — EXACT paths, no variation allowed
import { extension_settings, saveSettingsDebounced }
    from '../../../extensions.js';               // 3 levels up

import { eventSource, event_types }
    from '../../../../script.js';                // 4 levels up

import { getPresetManager }
    from '../../../preset-manager.js';           // 3 levels up

import { setUserAvatar, getUserAvatars, user_avatar }
    from '../../../personas.js';                 // 3 levels up

// Sibling modules — relative, same directory
import { initComposer, teardownComposer }   from './composer.js';
import { initPlusMenu, teardownPlusMenu }   from './plus-menu.js';
import { initSelector, teardownSelector }   from './selector.js';
import { initQr, teardownQr }               from './qr.js';
```

---

## 2. CSS Naming & Scoping

### Root gate
Every rule that touches the DOM **MUST** be nested under the root gate:

```css
body.chatui-active { … }
body.chatui-active .cui-composer { … }
```

Exception: `:root` custom-property declarations (CSS variables) may live outside the gate.

### Class prefix
Every class introduced by this extension uses the prefix **`cui-`**.
No exceptions. Do not add classes that begin with `chatui-`, `st-`, or any other prefix.

### Responsive breakpoint

| Token | Value | Meaning |
|---|---|---|
| Mobile | `max-width: 768px` | Phone layout (half-sheet menu, stacked composer) |
| Desktop | `min-width: 769px` | Sidebar visible, popup menu |

```css
/* Mobile-first pattern used throughout */
body.chatui-active .cui-plus-menu { /* mobile default */ }
@media (min-width: 769px) {
    body.chatui-active .cui-plus-menu { /* desktop override */ }
}
```

### CSS custom properties (defined on `:root`, read everywhere)

```css
:root {
    --cui-composer-radius: 1.5rem;
    --cui-slot-gap: 0.5rem;
    --cui-sheet-z: 200;          /* half-sheet z-index */
    --cui-popup-z: 150;          /* desktop popup z-index */
    --cui-tile-size: 5rem;       /* pinned tile width */
    --cui-overlay-bg: rgba(0,0,0,0.45);
}
```

---

## 3. Settings Schema

Namespace key: `extension_settings.chatui_composer`

```js
const MODULE = 'chatui_composer';

const defaultSettings = {
    enabled: false,                 // DEFAULT OFF — user must opt in
    composerMode: 'multiline',      // 'multiline' | 'singleline'
    selectorBKind: 'preset',        // 'preset' | 'model' | 'persona'
    plus: {
        pinned: ['regenerate', 'delete'],   // 1-4 items, drawn from TOOL_IDS
        tools: [                            // ordered; all enabled by default
            { id: 'continue',     enabled: true },
            { id: 'impersonate',  enabled: true },
            { id: 'camera',       enabled: true },
            { id: 'photos',       enabled: true },
            { id: 'files',        enabled: true },
            // wand/dynamic items appended at runtime; not stored here
        ],
    },
};
```

**Persistence**: call `saveSettingsDebounced()` (imported from `../../../../script.js`) after any mutation. Never call `saveSettings()` directly.

**Hydration** (`getSettings()` in `index.js`):
```js
function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    const s = extension_settings[MODULE];
    if (typeof s.enabled !== 'boolean')          s.enabled         = defaultSettings.enabled;
    if (!['multiline','singleline'].includes(s.composerMode))
                                                  s.composerMode    = defaultSettings.composerMode;
    if (!['preset','model','persona'].includes(s.selectorBKind))
                                                  s.selectorBKind   = defaultSettings.selectorBKind;
    if (!s.plus || typeof s.plus !== 'object')    s.plus            = structuredClone(defaultSettings.plus);
    if (!Array.isArray(s.plus.pinned))            s.plus.pinned     = [...defaultSettings.plus.pinned];
    if (!Array.isArray(s.plus.tools))             s.plus.tools      = structuredClone(defaultSettings.plus.tools);
    return s;
}
```

---

## 4. Module Interface

### ctx shape

`ctx` is constructed in `index.js` and passed to every module's `init*()` call:

```js
/**
 * @typedef {Object} CuiCtx
 * @property {ReturnType<getSettings>} settings  - live settings object (not a copy)
 * @property {object=} settingsP2 - live Phase 2 settings object when Phase 2 modules are active
 */
```

Construction in `index.js`:
```js
const ctx = {
    settings: getSettings(),
    settingsP2: getSettingsP2(),
};
```

### Exported function signatures — EXACT, no renaming

#### `composer.js`
```js
/** Wraps #send_form, creates DOM slots, applies multiline/singleline class. */
export function initComposer(ctx: CuiCtx): void

/** Restores every moved element to its original parent; removes #chatui-composer. */
export function teardownComposer(): void

/** Switches between 'multiline' and 'singleline' without a full teardown/init cycle. */
export function setComposerMode(mode: 'multiline' | 'singleline'): void
```

#### `plus-menu.js`
```js
/** Injects the + button into .cui-plus-slot and wires menu open/close. */
export function initPlusMenu(ctx: CuiCtx): void

/** Removes the + button and any open menu overlay/sheet. */
export function teardownPlusMenu(): void

/** Re-syncs wand item proxies (call after CHAT_CHANGED). */
export function refreshPlusMenuWandItems(): void
```

#### `selector.js`
```js
/** Injects a <select>-backed dropdown into .cui-selectorB-slot. */
export function initSelector(ctx: CuiCtx): void

/** Removes the dropdown and event listeners. */
export function teardownSelector(): void

/** Repopulates options (call after PRESET_CHANGED / PERSONA_CHANGED / CONNECTION_PROFILE_LOADED). */
export function refreshSelector(): void
```

#### `qr.js`
```js
/** Moves #qr--bar above #send_form; installs MutationObserver for rebuild survival. */
export function initQr(ctx: CuiCtx): void

/** Disconnects observer; returns #qr--bar to its original position inside #send_form. */
export function teardownQr(): void
```

### `index.js` orchestration

```js
// Called once from APP_READY handler
function setup() {
    initComposer(ctx);
    initPlusMenu(ctx);
    initSelector(ctx);
    initQr(ctx);
    document.body.classList.add('chatui-active'); // set AFTER all modules init
}

// Called when user unchecks "Enable" in settings UI
function teardown() {
    teardownQr();
    teardownSelector();
    teardownPlusMenu();
    teardownComposer();
    document.body.classList.remove('chatui-active'); // remove AFTER all modules tear down
}
```

> Order matters: `teardownComposer` goes last because the slot elements it owns are relied
> on by the other teardown functions to locate what to remove.

---

## 5. DOM Mount Points & cui- Classes

### 5.1 After `initComposer()` — the composer wrapper

```
#form_sheld
  #dialogue_del_mes          (untouched, stays where it is)
  #send_form                 (untouched host; keeps .no-connection class logic)
    #file_form               (untouched, stays as first child)
    #nonQRFormItems          (emptied, stays in DOM as sentinel — do NOT remove)
    #chatui-composer         (NEW div, inserted before #nonQRFormItems via insertBefore)
      .cui-plus-slot         (NEW empty div — filled by plus-menu.js)
      #leftSendForm          (MOVED from #nonQRFormItems — contains #options_button)
      #send_textarea         (MOVED from #nonQRFormItems — all jQuery bindings intact)
      .cui-selectorB-slot    (NEW empty div — filled by selector.js)
      #rightSendForm         (MOVED from #nonQRFormItems — contains #send_but, #mes_stop, etc.)
```

**`#chatui-composer` structure in multiline mode:**
```
#chatui-composer.cui-mode-multiline
  row 1 (top):   .cui-plus-slot  |  #send_textarea  |  (nothing here in multiline)
  row 2 (bottom): #leftSendForm  |  .cui-selectorB-slot  |  #rightSendForm
```

**`#chatui-composer` structure in singleline mode:**
```
#chatui-composer.cui-mode-singleline
  single row:  .cui-plus-slot  |  #leftSendForm  |  #send_textarea  |  #rightSendForm
  (selectorB slot hidden; selector B moves into + menu top)
```

Mode class applied to `#chatui-composer`:
- Multiline → adds class `cui-mode-multiline`, removes `cui-mode-singleline`
- Singleline → adds class `cui-mode-singleline`, removes `cui-mode-multiline`

### 5.2 `#qr--bar` float (owned by qr.js)

After `initQr()`, `#qr--bar` is relocated **before** `#send_form` inside `#form_sheld`:
```
#form_sheld
  #qr--bar                   (MOVED — sits visually above the composer)
  #send_form
    …
```

Class `cui-qr-float` is added to `#qr--bar` while the extension is active, used to apply
float styling. Removed on teardown.

### 5.3 `+` menu (owned by plus-menu.js)

```
.cui-plus-slot
  button#cui-plus-btn.cui-plus-btn   (the visible + button)

/* appended to body (NOT inside #send_form) so z-index stacking works: */
div#cui-plus-sheet.cui-plus-menu.cui-plus-sheet    (mobile: half-sheet overlay)
div#cui-plus-popup.cui-plus-menu.cui-plus-popup    (desktop: popup near button)
```

Interior of the menu (same markup, different container):
```
.cui-plus-menu
  .cui-plus-header
    button.cui-plus-close   (✕, mobile only)
    span.cui-plus-title     ("工具")
  .cui-plus-pinned          (section 1 — tile grid)
    .cui-plus-tile[data-action]   (one per pinned action)
  .cui-plus-divider
  .cui-plus-tools           (section 2 — vertical list)
    .cui-plus-tool-item[data-action]   (built-in tools, then wand proxies)
      .cui-tool-icon
      .cui-tool-label
```

`data-action` values for built-in items:
| `data-action` | Triggers |
|---|---|
| `regenerate` | `chatuiAdapter.menuActions.regenerateFromPlusMenu()` |
| `delete` | `chatuiAdapter.menuActions.openDeleteMessageMode()` |
| `continue` | `chatuiAdapter.menuActions.continueMessage()` |
| `impersonate` | `chatuiAdapter.menuActions.impersonateMessage()` |
| `camera` | `chatuiAdapter.menuActions.openAttachmentPicker('image/*')` |
| `photos` | `chatuiAdapter.menuActions.openAttachmentPicker('image/*,video/*,audio/*')` |
| `files` | `chatuiAdapter.menuActions.openAttachmentPicker()` |

Wand proxy items appended to `.cui-plus-tools` after built-in items. Each carries class `cui-wand-proxy` and calls `chatuiAdapter.menuActions.triggerWandAction(original)` on click. Any original-node click fallback stays inside `adapter/st-adapter.js`.

### 5.4 Selector B dropdown (owned by selector.js)

```
.cui-selectorB-slot
  div.cui-selector-b
    select.cui-selector-select   (proxy <select> element)
```

The selector element is **new DOM** (not a moved ST element). It reads from ST APIs and
calls back into ST APIs on change. It never moves or replaces any ST `<select>`.

In singleline mode `.cui-selectorB-slot` gets class `cui-slot-hidden` (CSS `display:none`);
plus-menu.js renders the selector B content at the top of its menu instead.

---

## 6. Behavior Specification

### 6.1 Composer (`composer.js`) — DESIGN §4.1 & §4.2

**DOM manipulation rules (non-negotiable):**
- Move `#leftSendForm`, `#send_textarea`, `#rightSendForm` with `appendChild` / `insertBefore`. NEVER `.clone()`.
- `#nonQRFormItems` stays empty but in the DOM (as sentinel for teardown position reference).
- All moved elements remain descendants of `#form_sheld` at all times — required for `.isExecutingCommandsFromChatInput` nested CSS rules and `#send_form:has(#send_textarea:focus-visible)` to keep working.

**`#send_textarea` constraints:**
- Do NOT set `overflow:hidden` or fixed `height` on `#chatui-composer` or any ancestor — breaks `field-sizing:content` auto-grow.
- Do NOT add or remove `.displayNone` from `#send_but`, `#mes_stop`, or `#mes_continue` — these are managed by ST's generation-state CSS and `RA_checkOnlineStatus`.
- The `body[data-generating="true"]` CSS selector in ST's style.css hides `#send_but` etc. during generation. The `#chatui-composer` wrapper must NOT add any rule that overrides `display:none` for those elements.

**Multiline mode** (default, `composerMode: 'multiline'`):
- `#chatui-composer` is a `display:flex; flex-direction:column` container.
- Row 1: `.cui-plus-slot` + `#send_textarea` (flex:1).
- Row 2: `#leftSendForm` + `.cui-selectorB-slot` (flex:1) + `#rightSendForm`.
- `#send_textarea` min-height and max-height inherited from ST; do not override `field-sizing:content`.

**Singleline mode** (`composerMode: 'singleline'`):
- `#chatui-composer` is a single `display:flex; flex-direction:row` container.
- Order: `.cui-plus-slot` | `#leftSendForm` | `#send_textarea` (flex:1) | `#rightSendForm`.
- `.cui-selectorB-slot` hidden (`cui-slot-hidden`); selector B content appears at top of + menu.
- `setComposerMode(mode)` toggles the mode class without teardown/reinit.

**Teardown** restores original state:
```js
// In teardownComposer():
const nonQR = document.getElementById('nonQRFormItems');
nonQR.appendChild(document.getElementById('leftSendForm'));
nonQR.appendChild(document.getElementById('send_textarea'));
nonQR.appendChild(document.getElementById('rightSendForm'));
document.getElementById('chatui-composer').remove();
// .cui-plus-slot and .cui-selectorB-slot are children of #chatui-composer → removed with it
```

### 6.2 + Menu (`plus-menu.js`) — DESIGN §4.3

**Open/close:**
- Click `#cui-plus-btn` → open the menu; click again (or ✕ button on mobile, or overlay) → close.
- Mobile (`max-width: 768px`): render `#cui-plus-sheet` (appended to `body`), semi-transparent overlay behind it, slide up from bottom. Overlay click closes.
- Desktop (`min-width: 769px`): render `#cui-plus-popup` (appended to `body`), positioned above `#cui-plus-btn` using `getBoundingClientRect()`. Click outside closes.
- Only one of `#cui-plus-sheet` / `#cui-plus-popup` exists in the DOM at a time (matching the current viewport). Resize across breakpoint → rebuild.

**Section 1 — Pinned tiles:**
- Render from `settings.plus.pinned` array (1–4 items).
- Default: `['regenerate', 'delete']`.
- Each tile is `.cui-plus-tile[data-action]` with an icon + label.
- Click → invoke the corresponding adapter action (see data-action table in §5.3) → close menu.

**Section 2 — Tool list:**
- Built-in tools in `settings.plus.tools` order (skip if `enabled: false`).
- Below a `.cui-plus-divider`, wand proxy items from `syncWandItemsToCustomMenu()`.
- Wand proxies re-synced on `CHAT_CHANGED` via `refreshPlusMenuWandItems()`.
- Wand proxies: visual clone of the original wand item node (cloneNode for display only), click calls `chatuiAdapter.menuActions.triggerWandAction(original)`.
- Do NOT move original wand item elements into the + menu — proxy clicks only.

**Singleline mode extra:** when `composerMode === 'singleline'`, render selector B content as the first item inside the menu (above pinned tiles), then a divider, then normal sections.

**Teardown:** remove `#cui-plus-btn` from `.cui-plus-slot`, remove `#cui-plus-sheet` and `#cui-plus-popup` from `body` if present, remove any event listeners on `body`/`document` that were added for click-outside detection.

### 6.3 Selector B (`selector.js`) — DESIGN §3 & §4.1

**What it proxies** (determined by `settings.selectorBKind`):

| `selectorBKind` | Data source | On change |
|---|---|---|
| `'preset'` | `getPresetManager().getAllPresets()` / `getSelectedPresetName()` | `pm.selectPreset(pm.findPreset(name))` |
| `'model'` | `extension_settings.connectionManager.profiles[]` | Set `#connection_profiles` value + dispatch `change` event |
| `'persona'` | `getUserAvatars(false)` + `power_user.personas` | `setUserAvatar(avatarId)` |

**Sync (keep in phase with ST):**
- Listen on `event_types.PRESET_CHANGED`, `event_types.OAI_PRESET_CHANGED_AFTER`, `event_types.CONNECTION_PROFILE_LOADED`, `event_types.PERSONA_CHANGED`.
- On each event, call `refreshSelector()` to repopulate and re-select.

**DOM:** injects a `<div class="cui-selector-b"><select class="cui-selector-select">…</select></div>` into `.cui-selectorB-slot`. The `<select>` element is new — not a moved ST element.

**Teardown:** remove the injected div, call `.off()` on all eventSource listeners bound during `initSelector`.

### 6.4 QR Float (`qr.js`) — DESIGN §4.1

**On `initQr()`:**
1. Call `relocateQrBar()` immediately (handles case where QR loaded before us).
2. Install `MutationObserver` on `#send_form` watching `childList` — whenever a node with `id === 'qr--bar'` is added, call `relocateQrBar()` again (handles QR's rebuild on `CHAT_CHANGED` and settings save).
3. Add class `cui-qr-float` to `#qr--bar` after each relocation.

**`relocateQrBar()`:**
```js
function relocateQrBar() {
    const bar = document.getElementById('qr--bar');
    const sendForm = document.getElementById('send_form');
    if (!bar || !sendForm) return;
    // Guard: QR popout mode puts bar on body, not in send_form
    if (bar.closest('#send_form') === null && bar.parentElement !== sendForm.parentElement) return;
    sendForm.insertAdjacentElement('beforebegin', bar);
    bar.classList.add('cui-qr-float');
}
```

**Teardown:**
```js
function teardownQr() {
    _qrObserver?.disconnect();
    _qrObserver = null;
    const bar = document.getElementById('qr--bar');
    const sendForm = document.getElementById('send_form');
    if (bar) bar.classList.remove('cui-qr-float');
    if (bar && sendForm) {
        // Restore: re-insert as first child of #send_form (QR's expected position)
        if (sendForm.firstChild) {
            sendForm.firstChild.insertAdjacentElement('beforebegin', bar);
        } else {
            sendForm.appendChild(bar);
        }
    }
}
```

---

## 7. Reuse-Not-Replace Rules & Reversibility

### Hard rules (violations are bugs, not style issues)

1. **Never clone** `#send_textarea`, `#send_but`, `#mes_stop`, `#mes_impersonate`, `#mes_continue`, or any child of `#rightSendForm`. jQuery `.on()` bindings live on the original node. Use `appendChild` / `insertBefore` to move.

2. **Never remove** `#nonQRFormItems` from the DOM. Leave it empty in place as a teardown sentinel.

3. **Never override** `display` of `#send_but`, `#mes_stop`, `#mes_continue`, `#mes_impersonate` via CSS rules under `body.chatui-active`. These are managed by ST's generation-state system (`body[data-generating="true"]` attribute selector and `showStopButton`/`hideStopButton` inline styles).

4. **Never add `.displayNone`** class to any element managed by `RA_checkOnlineStatus`. That class uses `!important` and will permanently hide the element from ST's perspective.

5. **Never remove `#form_sheld`** from its position or move `#send_form` out of `#form_sheld`. The `.isExecutingCommandsFromChatInput` CSS rules are written as descendant selectors rooted at `#form_sheld`.

6. **All teardown must be complete**: removing `body.chatui-active` alone is insufficient. Every moved element must be returned to its pre-setup parent in its original DOM order. Every injected element must be removed. Every event listener added to `eventSource` must be `.off()`'d.

7. **No `eslint-disable` comments** and no unused imports. Each module imports only what it uses.

### Reversibility checklist (verify before merging any module)

- [ ] `teardown*()` called with no prior `init*()` call is a no-op (guard with existence checks).
- [ ] After `setup()` + `teardown()`, `document.getElementById('nonQRFormItems').children` contains `#leftSendForm`, `#send_textarea`, `#rightSendForm` in that order.
- [ ] After teardown, `document.body.classList` does not contain `chatui-active`.
- [ ] After teardown, `#qr--bar` is the first child of `#send_form` (if it existed).
- [ ] After teardown, `#chatui-composer` does not exist in the DOM.
- [ ] After teardown, no `cui-*` classes remain on any ST-native element.

---

## 8. ESLint Cleanliness

The project uses `.eslintrc.cjs` with ES module rules. All files must comply.

### Rules that apply to this extension

- **ES modules**: use `import`/`export`; no `require()`.
- **No unused imports**: every imported binding must be used in the same file.
- **No unused variables**: `_` prefix for intentionally-unused params (e.g. `(_e) =>`).
- **Strict equality**: `===` and `!==` always.
- **No `var`**: use `const` or `let`.
- **JSDoc for exported functions**: each `export function` has a single-line `/** … */` doc.
- **No side effects at module top level**: all DOM work inside functions called from `index.js`. Only `const`/`let` declarations and `import` statements are acceptable at the top level of each module.

### Module-level pattern (every module follows this):

```js
// composer.js — example skeleton
import { eventSource, event_types } from '../../../../script.js';

/** @type {MutationObserver|null} */
let _observer = null;

/** Wraps #send_form … */
export function initComposer(ctx) { … }

/** Restores … */
export function teardownComposer() { … }

/** Switches mode … */
export function setComposerMode(mode) { … }
```

No default exports. All exports are named.

---

## 9. manifest.json (complete, final)

```json
{
    "display_name": "ChatUI 输入框重制",
    "loading_order": 101,
    "requires": [],
    "optional": [],
    "js": "index.js",
    "css": "style.css",
    "author": "blance",
    "version": "0.1.0",
    "homePage": "https://github.com/SillyTavern/SillyTavern",
    "auto_update": false
}
```

`loading_order: 101` loads after `SillyTavern-Sidebar` (100) so the sidebar layout is
in place before the composer wrap runs.

---

## 10. index.js Skeleton (non-negotiable wiring)

```js
import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { initComposer, teardownComposer, setComposerMode } from './composer.js';
import { initPlusMenu, teardownPlusMenu, refreshPlusMenuWandItems } from './plus-menu.js';
import { initSelector, teardownSelector, refreshSelector } from './selector.js';
import { initQr, teardownQr } from './qr.js';

const MODULE = 'chatui_composer';

const defaultSettings = { /* see §3 */ };

function getSettings() { /* see §3 */ }

/** @type {{ settings: object, settingsP2?: object }} */
let ctx;

let isSetup = false;

function setup() {
    ctx = { settings: getSettings(), settingsP2: getSettingsP2() };
    initComposer(ctx);
    initPlusMenu(ctx);
    initSelector(ctx);
    initQr(ctx);
    document.body.classList.add('chatui-active');
    isSetup = true;
}

function teardown() {
    teardownQr();
    teardownSelector();
    teardownPlusMenu();
    teardownComposer();
    document.body.classList.remove('chatui-active');
    isSetup = false;
}

function injectSettingsUI() { /* inline-drawer into #extensions_settings2 */ }

function init() {
    injectSettingsUI();
    if (getSettings().enabled) setup();
}

// APP_READY is autoFireAfterEmit — safe for late subscribers.
eventSource.on(event_types.APP_READY, init);

// Per-chat: re-sync wand proxies and selector after QR rebuilds.
eventSource.on(event_types.CHAT_CHANGED, () => {
    if (!isSetup) return;
    // setTimeout(0) lets QR's own CHAT_CHANGED handler run first (rebuilds #qr--bar).
    setTimeout(() => {
        refreshPlusMenuWandItems();
        refreshSelector();
    }, 0);
});
```

---

## 11. What Is Out of Scope for Phase 1

The following are defined in DESIGN.md but explicitly NOT built in Phase 1. Do not add stubs or placeholders.

- Sidebar / navigation panel (Phase 3)
- Top bar (header) rework (Phase 3)
- Slot A selector (Phase 3, depends on top bar)
- Message area restyling — bubbles, identity header, action row (Phase 2)
- Scroll-to-bottom button (Phase 2)
- Bottom regenerate button (Phase 2)
- Per-message context menus (Phase 2)
- + menu settings UI (drag-to-reorder, per-tool toggles) — hardcode defaults for Phase 1
- Singleline/multiline user toggle UI — hardcode `multiline` for Phase 1 (`composerMode` in settings is there; the UI toggle is not)
