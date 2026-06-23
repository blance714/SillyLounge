# SillyTavern-ChatUI · Technical Architecture

> This document describes the migration target after Phase 1/2.
> The current implementation still reshapes SillyTavern DOM directly; the target is to make ChatUI an extension-hosted app with a narrow SillyTavern adapter.

---

## 1. Goal

ChatUI should run inside SillyTavern as a third-party extension, but its UI should not be structurally coupled to SillyTavern's original DOM.

The intended boundary is:

```text
SillyTavern page/runtime
  |
  | extension manifest loads index.js + style.css
  v
ChatUI bootstrap
  |
  +-- ST DOM Shield
  +-- ST Adapter
  +-- ChatUI Store
  +-- ChatUI UI
```

SillyTavern remains responsible for the runtime: settings, characters, chats, generation pipeline, extension events, persistence, and backend proxying.

ChatUI becomes responsible for the visible interaction surface: layout, message presentation, composer, menus, navigation, and action affordances.

---

## 2. Loading Model

ChatUI is loaded as a normal SillyTavern extension through `manifest.json`:

```json
{
    "js": "index.js",
    "css": "style.css"
}
```

This is intentional. The adapter depends on an already-running SillyTavern page, especially:

- `globalThis.SillyTavern.getContext()`
- `eventSource` / `event_types`
- SillyTavern frontend state such as chat, characters, settings, and generation status
- fallback DOM controls when no stable frontend API exists

ChatUI is not currently designed as a standalone SPA that talks only to the SillyTavern backend APIs.

The extension runtime does not run a build step. Any framework code must
therefore ship as built browser assets alongside the source:

```text
ui/app.tsx         source entry of the ChatUI app
ui/components/     authored Preact UI components
dist/*.mjs         built extension runtime loaded by index.js
ui/root.js         stable wrapper that re-exports the built app
```

For local development, run the build from the extension directory:

```sh
npm run build
npm run watch
npm run typecheck
```

The preferred repository layout is a single ChatUI repository with two branch
roles:

- `main`: development branch with TSX source, scripts, and docs.
- `dist`: default installation branch with only SillyTavern-loadable runtime
  files.

For local development, `pnpm run dev` keeps `.runtime/SillyTavern-ChatUI`
synced. The SillyTavern checkout should symlink its
`public/scripts/extensions/third-party/SillyTavern-ChatUI` directory to that
runtime directory.

---

## 3. Layer Overview

### 3.1 ST DOM Shield

The shield owns how much of SillyTavern's original DOM is visible and interactive.

Responsibilities:

- Add and remove the global root gate: `body.chatui-active`.
- Create the ChatUI root node, for example `#chatui-root`.
- Hide, dim, relocate, or disable SillyTavern DOM regions that ChatUI replaces.
- Preserve SillyTavern DOM that the runtime still expects to exist.
- Restore the page cleanly on extension teardown.

Rules:

- Do not delete SillyTavern DOM nodes unless teardown can fully restore them.
- Do not start with broad `display: none` over major containers such as `#chat`, `#sheld`, or `#send_form`.
- Prefer staged shielding:
  - visual hiding
  - pointer/focus disabling
  - layout isolation
  - only then `display: none` for proven-unused nodes
- Keep every shield rule scoped under `body.chatui-active`.

The shield is not a data source. It should not parse message content, infer chat state, or trigger business actions. Those jobs belong to the adapter and store.

### 3.2 ST Adapter

The adapter is the only layer allowed to talk directly to SillyTavern internals.

Responsibilities:

- Read runtime state from `SillyTavern.getContext()` and stable frontend exports.
- Subscribe to SillyTavern events.
- Invoke SillyTavern actions such as generation, regeneration, save, copy, edit, delete, swipe, and chat switching.
- Convert SillyTavern data structures into ChatUI-facing DTOs.
- Hide fallback implementation details, including DOM button dispatches.

Example target API:

```js
adapter.getCurrentChat();
adapter.getCharacters();
adapter.getGenerationState();

adapter.sendMessage(text, options);
adapter.regenerateLast();
adapter.copyMessage(messageId);
adapter.editMessage(messageId, text);
adapter.deleteMessage(messageId);
adapter.saveChat();

adapter.subscribe('chatChanged', handler);
adapter.subscribe('messageRendered', handler);
adapter.subscribe('messageUpdated', handler);
adapter.subscribe('generationStarted', handler);
adapter.subscribe('generationStopped', handler);
```

Rules:

- UI modules must not import from SillyTavern core files directly.
- UI modules must not dispatch clicks on SillyTavern DOM buttons.
- If a SillyTavern operation still requires DOM fallback, keep that fallback inside the adapter and document it.
- Adapter return values should be plain data, not live SillyTavern DOM nodes.

### 3.3 ChatUI Store

The store is ChatUI's view model.

Responsibilities:

- Hold the UI-ready chat state.
- Hold derived UI state such as selected message, open menus, composer mode, sidebar mode, loading state, and transient errors.
- Normalize adapter data into stable ChatUI shapes.
- Publish store changes to UI renderers.
- Decide when UI needs to re-render after SillyTavern events.

The store should not know about SillyTavern DOM selectors.

Example state shape:

```js
{
    chat: {
        messages: [
            {
                id: 0,
                key: '0',
                role: 'character',
                isUser: false,
                isSystem: false,
                isChar: true,
                name: 'Assistant',
                text: 'Raw visible message text',
                displayText: 'Display override or text',
                sendDate: 1782040000000,
                forceAvatar: false,
                forceAvatarSrc: '',
                swipe: {
                    id: 0,
                    count: 1,
                    hasMultiple: false,
                    label: '',
                },
                extra: {
                    type: '',
                    isSmallSys: false,
                    isToolCall: false,
                    bookmarkLink: '',
                    tokenCount: null,
                    reasoning: '',
                    reasoningDuration: null,
                },
                ui: {
                    isLast: true,
                    canShowCharActions: true,
                    canShowUserMenu: false,
                    canShowSwipe: false,
                    needsGenerate: false,
                },
            },
        ],
        byId: {},
        lastMessageId: 0,
        isGroup: false,
        isGenerating: false,
        lastMessageNeedsGenerate: false,
    },
    ui: {
        openMessageMenuId: null,
        openPlusMenu: false,
    },
}
```

Rules:

- Store state should be serializable where practical.
- Store updates should go through named actions instead of ad-hoc mutation from UI components.
- Store actions may call the adapter, but the adapter must not import the store.

### 3.4 ChatUI UI

The UI owns rendering and user interaction.

Current framework choice:

- Preact with `preact/compat`.
- TypeScript/TSX for authored UI components.
- `esbuild` bundles only the UI framework/component layer.
- Store, shield, and action modules stay external imports so runtime singletons
  are shared with the extension bootstrap.

Responsibilities:

- Render ChatUI into `#chatui-root` or explicitly owned `cui-` nodes.
- Read state from the store.
- Dispatch user intents to store actions.
- Maintain accessible controls, focus behavior, menu positioning, and responsive layout.

Rules:

- UI does not read SillyTavern's original DOM as state.
- UI does not call SillyTavern functions directly.
- UI does not import from `script.js`, `extensions.js`, `st-context.js`, or other SillyTavern modules.
- UI may render into relocated SillyTavern-owned controls only during migration, and those cases must be treated as temporary.

---

## 4. Data Flow

Preferred data flow:

```text
SillyTavern event/action result
  -> ST Adapter
  -> ChatUI Store action
  -> Store state update
  -> ChatUI UI render
```

Preferred user action flow:

```text
User clicks ChatUI control
  -> UI handler
  -> Store action
  -> ST Adapter call
  -> SillyTavern runtime
  -> SillyTavern event
  -> Store refresh
```

This keeps SillyTavern integration one-way at the boundary and prevents UI code from growing hard dependencies on SillyTavern's current DOM.

---

## 5. Migration Strategy

### Stage 0: Current Phase 1/2

Current implementation:

- Reshapes `#send_form`.
- Reuses and relocates existing controls.
- Injects `cui-` nodes into existing `.mes` message DOM.
- Centralizes SillyTavern DOM fallback actions in `adapter/st-adapter.js`.

This is acceptable for Phase 1/2, but should not become the final architecture.

### Stage 1: Introduce Adapter

Add an adapter module while keeping current UI mostly intact.

Targets:

- Centralize all `getContext`, `eventSource`, and DOM fallback calls.
- Replace direct UI imports from SillyTavern modules with adapter calls.
- Document every fallback that still triggers original DOM controls.

Current coverage:

- Message layout/actions/extras, floating chrome, and plus-menu actions use `adapter/st-adapter.js` for ST state, events, generation status, and DOM fallbacks.
- Remaining direct ST runtime imports are limited to the extension bootstrap/settings path and Phase 1 selector synchronization, pending later migration.

### Stage 2: Introduce Store

Create a store that mirrors the UI-relevant SillyTavern state.

Targets:

- Message list DTOs.
- Generation status.
- Composer state.
- Open menu state.
- Settings used by ChatUI.

Current DOM-rewrite modules can initially subscribe to the store without changing the visible UI.

Current coverage:

- `store/chat-store.js` builds `ChatuiMessageDto` objects from `chatuiAdapter.getCurrentChat()`.
- Message layout/actions and floating chrome consume store DTO/state for role, group, swipe, and generate-button decisions.
- DOM-derived values that do not yet exist in the raw chat model, such as rendered timestamp text and resolved non-forced avatar URLs, still have temporary DOM fallback in the relevant UI module.

### Stage 3: Introduce ChatUI Root

Create a dedicated root:

```html
<div id="chatui-root"></div>
```

Targets:

- Render new messages into ChatUI-owned DOM.
- Keep SillyTavern's `#chat` alive as runtime state until proven safe to shield more aggressively.
- Move composer UI into ChatUI-owned DOM while adapter forwards user intents to SillyTavern.

Current coverage:

- `shield/st-dom-shield.js` creates and removes `#chatui-root` with the global `chatui-active` gate.
- `ui/root.js` mounts the built ChatUI-owned app shell into `#chatui-root`.
- The root shell renders a Store-driven message list from `ChatuiMessageDto` objects and subscribes to store updates.
- The root shell is visually parked by default; Stage 4 will deliberately promote it before hiding the original `#chat` surface.

### Stage 4: Shield Original ST UI

Progressively reduce visible SillyTavern DOM.

Order:

1. Non-critical decorative chrome.
2. Original message action buttons.
3. Original composer surface.
4. Original chat message surface.
5. Navigation and drawer chrome.

Each item needs a dependency check before stronger hiding.

Current coverage:

- `shield/st-dom-shield.js` applies `data-chatui-shield-level="3"` while ChatUI is active.
- Level 1 shields only lightweight native chrome that already has ChatUI replacements or Phase 2 restyling:
  - stock left-form menu/wand buttons replaced by ChatUI's plus menu,
  - native message name/timestamp chrome replaced by ChatUI identity headers,
  - native message buttons replaced by ChatUI action rows/menus,
  - native avatar gutters and user-message swipe chrome hidden by the current message layout.
- Level 2 promotes the ChatUI-owned `#chatui-root` as a constrained visible message band.
- Level 3 promotes `#chatui-root` to the primary message surface and moves the original `#chat` surface into a visual background state.
- The original `#chat` remains alive in the DOM for SillyTavern render/update logic and adapter fallbacks.
- Level 4 shields the original `#send_form` while keeping the textarea and send
  pipeline alive for adapter fallbacks.
- Drawer contents and navigation chrome remain available until their contents
  are owned by ChatUI.

### Stage 4.5: Root Message UI

Make the ChatUI-owned message surface usable enough to carry the primary chat
experience.

Current coverage:

- `ui/root.js` is now a stable runtime wrapper around the built Preact app in `dist/root-app.mjs`.
- `ui/app.tsx` renders `ChatuiMessageDto` objects into the ChatUI root as the primary message list.
- Message UI is split across `ui/components/MessageItem.tsx` and
  `ui/components/message/*.tsx`.
- The root UI is authored as a Preact/compat TSX app, while store and adapter boundaries remain unchanged.
- Message bodies use adapter-produced sanitized HTML from SillyTavern's existing `messageFormatting()` path.
- Root messages render avatar/name/time metadata, swipe labels, reasoning details, Markdown/code blocks, code-copy affordances, and a root-level generating indicator.
- Root message actions dispatch through `store/chat-actions.js`, which forwards intent to adapter by message id.
- Supported root actions: copy, regenerate last character message, swipe left/right, edit, delete, branch, checkpoint, and hide.
- Floating chat chrome reads the root scroll surface first and falls back to `#chat` only when root is unavailable.

Still deferred:

- Fully ChatUI-owned drawer/sidebar contents.
- Full parity for media editing controls such as caption, delete, and media
  gallery swipes.

### Stage 4.6: Root Edit Mode

Make message editing visible and controlled from the ChatUI-owned root surface.

Current coverage:

- `ui/components/message/MessageEditor.tsx` owns the inline edit surface for root messages.
- Editing state is local to the Preact root app.
- Save/cancel controls are rendered by ChatUI, not by SillyTavern's hidden
  message DOM.
- `store/chat-actions.js` exposes `saveEditedChatuiMessage(messageId, text)`.
- `adapter/st-adapter.js` saves through SillyTavern's native `messageEdit()`
  pipeline in the background so regex, macro, bias, swipe, persistence, and
  `MESSAGE_UPDATED` semantics stay aligned with ST.

Still deferred:

- Reasoning-specific editing.
- Move/copy/delete controls inside the edit surface.
- Replacing the ST native edit pipeline with a direct adapter/API
  implementation.

### Stage 4.7: Root Composer

Make the primary input surface ChatUI-owned while keeping SillyTavern's native
composer alive as the runtime bridge.

Current coverage:

- `ui/components/Composer.tsx` renders a ChatUI-owned composer at the bottom of the root
  app.
- Submit/stop controls dispatch through `store/chat-actions.js`.
- `adapter/st-adapter.js` writes into the hidden native `#send_textarea` and
  calls SillyTavern's exported `sendTextareaMessage()` path, preserving slash
  commands, macros, generation routing, and persistence semantics.
- `shield/st-dom-shield.js` shields the original `#send_form` at level 4
  without removing it from the DOM.

Still deferred:

- ChatUI-owned attachment chips and queued file display.
- QR shortcut integration inside the root composer.
- Direct send API that does not need the native textarea bridge.

### Stage 4.8: Root Drawer Foundation

Introduce a ChatUI-owned shell drawer for navigation while SillyTavern still
owns the actual settings/list panel contents.

Current coverage:

- `ui/app.tsx` renders the root topbar, and `ui/components/ShellDrawer.tsx`
  renders the side drawer.
- Drawer actions dispatch named shell intents through `store/chat-actions.js`.
- `adapter/st-adapter.js` maps shell intents to SillyTavern drawer controls
  such as characters, groups, AI config, world info, personas, extensions, and
  user settings.

Still deferred:

- ChatUI-owned character list, chat list, settings panels, and search.
- Stable route state for drawers.
- Focus trapping and deep keyboard navigation inside future drawer contents.

### Stage 4.9: Root Rich Media

Render message attachments inside the ChatUI-owned message list.

Current coverage:

- `adapter/st-adapter.js` converts current and legacy ST attachment fields
  (`extra.media`, `extra.files`, `extra.image`, `extra.video`,
  `extra.image_swipes`, and `extra.file`) into plain media/file DTOs.
- `store/chat-store.js` exposes attachments on each `ChatuiMessageDto`.
- `ui/components/message/MessageMedia.tsx` renders image, video, audio, and file attachments after the
  message body.
- Image/file open actions dispatch back through adapter fallbacks, so ST's
  preview/file logic remains the source of truth.
- Root UI respects `extra.inline_image === false` by hiding message text when
  ST would show the attachment as the whole message.

Still deferred:

- Media delete/caption controls.
- Gallery swipe controls for root media.
- Rich attachment composer chips.

### Stage 5: Optional Extraction

Only after the adapter API is stable should it be considered for extraction into a separate package or repository.

Likely shape:

```text
@chatui/sillytavern-adapter
```

This package would still require a running SillyTavern page. It would be a browser runtime bridge, not a standalone SillyTavern core SDK.

---

## 6. Dependency Inventory

Before hiding or replacing a SillyTavern DOM area, record:

| ST area | ChatUI replacement | Runtime dependency | Hide strategy | Done |
|---|---|---|---|---|
| `#send_form` | ChatUI composer | send pipeline, hidden textarea bridge, stop control, QR integration | Level 4 shield; keep native form alive for runtime | Partial |
| `#chat` | ChatUI message list | scrolling, rendered message nodes, edit state, copy buttons, swipe controls, media preview/file fallback | Level 3 visual background; keep ST chat alive for runtime | Yes |
| `.mes_buttons` | ChatUI action row/menu | copy/edit/delete/extra action fallbacks centralized in `adapter/st-adapter.js` | hidden by Level 1 shield | Yes |
| `#options` | ChatUI plus menu actions | regenerate/delete/continue/impersonate fallbacks centralized in `adapter/st-adapter.js` | source kept alive; launcher hidden by Level 1 shield | Partial |
| `#attachFile` | ChatUI plus menu attachment tools | file picker fallback centralized in `adapter/st-adapter.js` | keep native control alive | Partial |
| `#extensionsMenu` | ChatUI wand proxies | original extension action fallback centralized in `adapter/st-adapter.js` | source kept alive; launcher hidden by Level 1 shield | Partial |
| `#qr--bar` | ChatUI QR surface | QR extension rebuilds on chat changes | relocate and observe | Partial |
| drawer launchers | ChatUI root drawer | original drawer toggles centralized in `adapter/st-adapter.js` | ChatUI shell triggers native panels | Partial |
| drawer contents | ChatUI sidebar/settings panels | existing settings UI and extension panels | keep visible until contents are replaced | No |

This table should be updated whenever a new ST DOM dependency is discovered.

---

## 7. File Organization

Current source organization:

```text
SillyTavern-ChatUI/
  package.json
  tsconfig.json
  index.js
  style.css
  dist/
    root-app.mjs
    root-app.mjs.map
  scripts/
    build.mjs
  adapter/
    st-adapter.js
    st-events.js
    st-message-actions.js
  store/
    chat-store.js
    chat-actions.js
  ui/
    root.js
    app.tsx
    actions.ts
    hooks.ts
    format.ts
    types.ts
    components/
      Composer.tsx
      MessageItem.tsx
      ShellDrawer.tsx
      message/
        ActionButton.tsx
        MenuItem.tsx
        MessageActions.tsx
        MessageAvatar.tsx
        MessageEditor.tsx
        MessageMedia.tsx
        MessageReasoning.tsx
  shield/
    st-dom-shield.js
```

Runtime-only files still live at the extension root because SillyTavern loads
the extension through `manifest.json`. Authored Preact code belongs under
`ui/`; generated browser output belongs under `dist/`.

---

## 8. Non-Goals

- Do not rewrite the SillyTavern backend.
- Do not fork SillyTavern core logic unless adapter-based integration proves insufficient.
- Do not build a standalone SPA until the missing frontend VM responsibilities are fully inventoried.
- Do not treat SillyTavern backend endpoints as a complete domain API; many domain decisions currently happen in the frontend runtime.

---

## 9. Architecture Rule of Thumb

ST can remain the runtime.

ST DOM can remain present.

But ChatUI should stop treating ST DOM as its model.
