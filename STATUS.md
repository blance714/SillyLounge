# SillyTavern-ChatUI · Current Status

Last updated: 2026-06-23

This document is the short operational snapshot. `ARCHITECTURE.md` remains the
long-form design record.

---

## Current Architecture

ChatUI is still loaded as a SillyTavern third-party extension, but the visible
chat surface is now mostly ChatUI-owned.

```text
SillyTavern page/runtime
  |
  | manifest loads index.js + style.css
  v
ChatUI bootstrap
  |
  +-- shield/st-dom-shield.js
  |     owns body.chatui-active, #chatui-root, and shield levels
  |
  +-- adapter/st-adapter.js
  |     reads ST runtime state and hides DOM/API fallbacks
  |
  +-- store/chat-store.js + store/chat-actions.js
  |     expose ChatUI DTOs and user-intent actions
  |
  +-- ui/root.js -> dist/root-app.mjs
        Preact/compat app built from ui/app.tsx
```

SillyTavern remains the runtime owner for chat persistence, generation,
settings, extension events, file previews, and existing drawer contents.
ChatUI owns the visible message list, primary composer, root topbar, root
drawer shell, inline message editing surface, and rich attachment rendering.

---

## Source Layout

```text
ui/
  app.tsx                 root Preact shell
  actions.ts              UI-facing action barrel
  hooks.ts                store snapshot + DOM enhancement hooks
  format.ts               display formatting helpers
  types.ts                UI-facing inferred types
  root.js                 stable runtime wrapper for dist/root-app.mjs
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
```

The extension installer does not build plugins. Development source is built
with esbuild into `dist/root-app.mjs`, and `pnpm run runtime` syncs the loadable
extension tree into `.runtime/SillyTavern-ChatUI`.

---

## Completed Progress

- Repository split: source lives outside the SillyTavern extension folder, and
  SillyTavern loads the synced `.runtime/SillyTavern-ChatUI` tree via symlink.
- Build/runtime pipeline: Preact/compat + TSX source, esbuild bundle, typecheck,
  runtime sync, and dev watch scripts.
- Shield levels:
  - level 1 hides replaced lightweight ST chrome,
  - level 2 promotes `#chatui-root`,
  - level 3 visually shields native `#chat`,
  - level 4 visually shields native `#send_form`.
- Store DTOs: root message list is driven by `ChatuiMessageDto` objects, not by
  UI components reading SillyTavern DOM.
- Root message UI: metadata, formatted message HTML, reasoning block, code copy,
  swipe labels, actions, inline edit, and generating indicator.
- Root composer: ChatUI-owned textarea and send/stop controls, bridged through
  SillyTavern's native send pipeline.
- Root drawer shell: ChatUI-owned side drawer with named shell actions that open
  the relevant SillyTavern native panels.
- Rich media: root messages render images, videos, audio, and files from current
  and legacy ST attachment fields.
- UI source cleanup: root app and message UI are split into normal frontend
  component files.

---

## Important Boundaries

- UI code must not import SillyTavern core modules directly.
- UI code must not click SillyTavern DOM controls directly.
- Adapter fallbacks may use ST DOM, but should expose plain functions and DTOs.
- Store should not know SillyTavern selectors.
- Native `#chat` and `#send_form` remain alive because ST render/update/send
  semantics still depend on them.
- `dist/` is generated runtime output; authored UI changes belong in `ui/`.

---

## Known Deferred Work

- ChatUI-owned character/chat list drawer contents.
- ChatUI-owned settings panels.
- Toast/error feedback owned by ChatUI instead of console/native feedback.
- Composer attachment chips and queued attachment state.
- QR shortcut integration inside the root composer.
- Media caption/delete/gallery swipe controls in root media.
- Reasoning-specific edit controls.
- Direct adapter/API send and edit paths that no longer need hidden native DOM
  bridges.
- Visual Playwright pass across desktop/mobile once the local ST test state is
  stable enough.

---

## Suggested Next Milestones

### H1: ChatUI Feedback Layer

Add a small toast/error store and root component. Route send/edit/copy/media
errors through it before expanding more UI.

### H2: ChatUI Character Drawer

Replace the first native drawer content with a ChatUI-owned character list:
adapter character DTOs, search/filter, current character state, and switch
actions.

### H3: Composer Attachments

Move selected-file visibility into the root composer with attachment chips and
remove actions, while still using ST's file picker/persistence pipeline.

### H4: Media Controls

Add root media gallery swipes, captions, and delete actions through adapter
fallbacks.

### H5: Drawer Routing

Introduce explicit root drawer route state so Characters, Chats, Settings, and
Extensions become ChatUI pages rather than buttons that only open native panels.
