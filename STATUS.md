# SillyTavern-ChatUI · Current Status

Last updated: 2026-06-23

This document is the short operational snapshot. `ARCHITECTURE.md` remains the
long-form design record. `DESIGN.md` is the product spec / north star.

---

## Current Architecture

ChatUI loads as a SillyTavern third-party extension. The visible chat surface is
ChatUI-owned: a Preact app mounted into `#chatui-root`, driven by a small store
of view-model DTOs. SillyTavern keeps owning the runtime (persistence,
generation, settings, events, file previews, native drawers); ChatUI never reads
ST DOM as its model.

```text
SillyTavern page/runtime
  |
  | manifest loads index.js + style.css
  v
index.js  (enable toggle + settings UI + orchestration)
  |
  +-- shield/st-dom-shield.js
  |     owns body.chatui-active, #chatui-root, and the shield level
  |     (parks native #chat / #send_form off-screen; promotes #chatui-root)
  |
  +-- adapter/st-adapter.js
  |     the ONLY module that touches ST internals (getContext, eventSource,
  |     native send/edit pipelines, DOM-button fallbacks); returns plain DTOs
  |
  +-- store/chat-store.js + store/chat-actions.js
  |     build ChatuiMessageDto objects from the adapter; expose user-intent actions
  |
  +-- ui/root.js -> dist/root-app.mjs
        Preact/compat app built from ui/app.tsx
```

There is now **one** architecture. The earlier Phase 1/2 approach (reshaping
native `#send_form` and decorating native `#chat .mes` in place) has been
removed — see "Legacy cleanup" below.

---

## Source Layout

```text
index.js                  entry: enable toggle, settings UI, setup/teardown
manifest.json             extension descriptor
style.css                 :root vars + shield rules + .cui-root-* app styles
adapter/
  st-adapter.js           ST runtime boundary (context, events, fallbacks, DTOs)
store/
  chat-store.js           ChatuiMessageDto store + event subscriptions
  chat-actions.js         store-facing action facade
shield/
  st-dom-shield.js        #chatui-root + body.chatui-active + shield levels
ui/
  app.tsx                 root Preact shell
  root.js                 stable runtime wrapper for dist/root-app.mjs
  actions.ts / hooks.ts / format.ts / types.ts
  components/
    Composer.tsx  MessageItem.tsx  ShellDrawer.tsx
    message/
      ActionButton  MenuItem  MessageActions  MessageAvatar
      MessageEditor  MessageMedia  MessageReasoning
scripts/                  build / dev / runtime-sync tooling
dist/                     generated browser bundle (gitignored on main)
```

The extension installer does not build plugins. Authored Preact/TSX is bundled
with esbuild into `dist/root-app.mjs`; `pnpm run runtime` syncs the loadable
tree into `.runtime/SillyTavern-ChatUI`.

---

## Ownership Boundary

ChatUI owns: the visible message list, message body/media/reasoning rendering,
inline edit surface, primary composer, root topbar, and the shell drawer.

SillyTavern still owns: chat persistence, generation/regeneration, settings,
extension events, file previews, and all native drawer panel contents. The
native `#chat` and `#send_form` stay **alive in the DOM** (parked off-screen by
the shield) because ST render/update/send/edit semantics still flow through
them; the adapter bridges ChatUI intents into those native pipelines.

### Rules

- UI code must not import ST core modules or read ST DOM as state.
- Only `adapter/st-adapter.js` may touch ST internals or dispatch native DOM.
- The store must not know ST selectors; the adapter must not import the store.
- `dist/` is generated; authored UI changes belong in `ui/`.

---

## Legacy cleanup (2026-06-23)

Removed the transitional Phase 1/2 DOM-reshaping layer, which had been
superseded by the shield + store + Preact root and was running invisibly behind
the shield:

- **Deleted modules**: `composer.js`, `plus-menu.js`, `selector.js`, `qr.js`,
  `message-layout.js`, `message-actions.js`, `message-extras.js`,
  `chat-chrome.js`.
- **`index.js`**: orchestration reduced to `shield → store → root`; settings
  collapsed to a single enable toggle (the Phase 1/2 settings — `composerMode`,
  `selectorBKind`, identity headers, code header, scroll/regen buttons — drove
  the removed modules and consumed nothing else).
- **`style.css`**: dropped the Phase 1 composer CSS and the Phase 2 `.mes`
  decoration CSS; kept `:root`, the shield rules, and the `.cui-root-*` app
  styles (~1970 → ~720 lines).
- **`scripts/runtime.mjs`**: dropped the deleted files from the sync lists.
- The two build contracts (`CONTRACT.md`, `CONTRACT-P2.md`) are retained as
  historical records with a SUPERSEDED banner.

---

## Known Deferred Work

Features the removed Phase 1/2 modules nominally covered now need first-class
re-implementation inside the Preact root (they were already non-functional under
the shield, so nothing visible regressed):

- Plus (`+`) menu: attachments, continue/impersonate, wand/extension tools.
- Selector chips (preset / model / persona) in the composer or topbar.
- QR (quick-reply) shortcut surface above the composer.
- Identity-header configuration (group vs single: icon / name / none).
- Composer attachment chips and queued-attachment state.
- Toast/error feedback owned by ChatUI instead of console/native feedback.
- ChatUI-owned drawer contents (character list, chat list, settings panels).
- Media caption/delete/gallery-swipe controls.
- Reasoning-specific edit controls.
- Direct adapter/API send + edit paths that no longer need the hidden native
  DOM bridge.
- Visual Playwright pass across desktop/mobile once a stable local ST test state
  exists.

---

## Suggested Next Milestones

### H1: ChatUI Feedback Layer
Add a small toast/error store and root component. Route send/edit/copy/media
errors through it before expanding more UI.

### H2: ChatUI Character Drawer
Replace the first native drawer content with a ChatUI-owned character list:
adapter character DTOs, search/filter, current-character state, switch actions.

### H3: Composer Attachments + Plus Menu
Bring the `+` menu and attachment chips into the root composer (attachments,
continue/impersonate, wand tools) while still using ST's file/persistence
pipeline.

### H4: Media Controls
Add root media gallery swipes, captions, and delete actions through adapter
fallbacks.

### H5: Drawer Routing
Introduce explicit root drawer route state so Characters, Chats, Settings, and
Extensions become ChatUI pages rather than buttons that only open native panels.
