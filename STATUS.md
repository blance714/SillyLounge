# SillyTavern-ChatUI · Current Status

Last updated: 2026-07-01

This document is the short operational snapshot. `ARCHITECTURE.md` remains the
long-form design record. `DESIGN.md` is the product spec / north star.
`ROADMAP.md` is the live completeness map + priority backlog.

---

## Current Architecture

ChatUI loads as a SillyTavern third-party extension. The visible chat surface is
ChatUI-owned: a Preact app mounted into `#chatui-root`, driven by small stores of
view-model DTOs. SillyTavern keeps owning the runtime (persistence, generation,
settings, events, file previews, native drawers); ChatUI never reads ST DOM as
its model.

```text
SillyTavern page/runtime
  |
  | manifest loads index.js + style.css
  v
src/index.ts -> index.js
        (master enable toggle + setup/teardown orchestration)
  |
  +-- src/shield/st-dom-shield.ts -> shield/st-dom-shield.js
  |     owns body.chatui-active, #chatui-root, and the shield level
  |     (parks native #chat / #send_form off-screen; promotes #chatui-root)
  |
  +-- src/adapter/ -> adapter/  (the ONLY layer that touches ST internals)
  |     st-adapter.js is the frozen facade; behavior split across
  |     internals · messages · composer · media · menu · selectors ·
  |     shell · chats · qr · config · settings submodules; returns plain DTOs
  |
  +-- src/store/ -> store/  (ST-free observable view-model, createStore factory)
  |     chat · sidebar · config · ui · toast stores + *-actions facades
  |
  +-- src/ui/root.ts -> ui/root.js -> dist/root-app.mjs
        Preact/compat app built from src/ui/app.tsx; reads stores via hooks,
        mutates via the ui/actions.ts barrel
```

There is **one** architecture. The earlier Phase 1/2 approach (reshaping native
`#send_form` and decorating native `#chat .mes` in place) was removed in the
2026-06-23 legacy cleanup; `CONTRACT.md` / `CONTRACT-P2.md` are retained as
SUPERSEDED historical records.

---

## Source Layout

```text
manifest.json             extension descriptor
style.css                 :root vars + shield rules + .cui-root-* app styles
src/
  index.ts                entry: master enable toggle + setup/teardown
  adapter/                ST runtime boundary — facade + per-domain submodules
    st-adapter.ts         frozen facade (groups the submodule actions)
    internals.ts          shared ST context / event / dispatch helpers
    messages.ts  composer.ts  media.ts  menu.ts  selectors.ts
    shell.ts     chats.ts     qr.ts     config.ts     settings.ts
  store/                  ST-free observable view-model (createStore factory)
    create-store.ts       tiny observable store primitive
    chat-store.ts / chat-actions.ts
    sidebar-store.ts / sidebar-actions.ts
    temp-chat-store.ts    single new-chat draft pointer (localStorage), replaces the old pending-new-chat marker
    config-store.ts       persisted per-feature config (via adapter/config.ts)
    ui-store.ts           ephemeral session UI state (settings mode / drawer selection)
    toast-store.ts        ChatUI feedback layer
  shield/
    st-dom-shield.ts      #chatui-root + body.chatui-active + shield levels
  ui/
    app.tsx               root Preact shell (two-pane sidebar | chat; settings swaps both panes)
    root.ts               stable runtime wrapper for dist/root-app.mjs
    actions.ts hooks.ts format.ts types.ts sidebar-queries.ts query-client.ts
    components/
      Composer  PlusMenu  QRBar  SelectorChip  AttachmentChips
      MessageItem  TopbarMenu  ConfirmDialog  Toaster
      composer/ NewChatCharacterPicker
      sidebar/  Sidebar CharacterConversationList NewChatButton SettingsEntry
      settings/ SettingsNav SettingsContent ChatUiSettingsContent StDrawerHost
      config/   ConfigSelect PlusPinEditor
      message/  ActionButton MenuItem MessageActions MessageAvatar
                MessageEditor MessageMedia MessageReasoning
  types/st-externals.d.ts SillyTavern host-module declarations
scripts/                  build / dev / runtime-sync tooling
dist/                     generated browser output (gitignored)
```

The extension installer does not build plugins. Authored Preact/TSX is bundled
with Vite into `dist/root-app.mjs`; runtime TS modules are compiled with Vite
into `dist/runtime/`, and `pnpm run runtime` syncs the loadable tree into
`.runtime/SillyTavern-ChatUI`. The full runtime chain is `src/` →
`dist/runtime/` + `dist/root-app.mjs` → `.runtime/SillyTavern-ChatUI` →
SillyTavern's third-party symlink.

---

## Ownership Boundary

ChatUI owns: the sidebar navigation center, the root topbar, the visible message
list, message body/media/reasoning rendering, the inline edit surface, the
composer (＋menu, selector chips, attachment chips, QR bar), the toast feedback
layer, and the ChatUI-native settings shell.

SillyTavern still owns: chat persistence, generation/regeneration, settings,
extension events, file previews, and all native drawer panel contents. ChatUI may
temporarily host a live ST drawer inside its settings shell, but only through
`src/adapter/settings.ts` + `StDrawerHost`; UI code never reaches into the
drawer DOM directly. The native `#chat` and `#send_form` stay alive in the DOM (parked
off-screen by the shield) because ST render/update/send/edit semantics still flow
through them; the adapter bridges ChatUI intents into those native pipelines.

### Rules

- UI code must not import ST core modules or read ST DOM as state.
- Only the `adapter/` layer may touch ST internals or dispatch native DOM.
- The store must not know ST selectors; the adapter must not import the store.
- Bundled UI reaches the store only through `src/ui/actions.ts` / `src/ui/hooks.ts`
  (Vite/Rollup marks `../store/*` external relative to the `src/ui/app.tsx` entry, so a
  deep component importing `../../../store/*` would wrongly bundle the ST graph).
- `dist/` is generated; authored changes belong in `src/`.

---

## Where things stand

Five-region north star ≈80% (see `ROADMAP.md` for the per-region map). The sidebar
navigation center, content area, composer, and topbar trunks are closed-loop on
real ST export functions — delete / swipe / rename / chat-switch are no longer
simulated clicks. The old three-form sidebar cycle and third settings column have
been replaced by the Codex-app-style two-pane model: `Sidebar | chat`, with
settings as a mode swap that shows ChatUI-owned nav on the left and either
ChatUI-native settings or a live ST drawer host on the right.

New-chat drafts now use an explicit `tempChat` pointer in localStorage instead of
`chat_metadata.chatui_isNewChat` / message-count heuristics. The pointed draft is
hidden from the sidebar, highlights the ＋新对话 tab while active, is replaced only
through guarded `doNewChat`, and becomes a normal kept conversation when the user
sends or edits the greeting.

`ROADMAP.md` is the authoritative priority backlog. Current top items:

- **Short-term migration hardening** — Day 1 docs are pinned down; Day 2 adds
  generated artifact checks for unresolved `@st/*`, `process.env` / Node globals,
  and bad browser import specifiers.
- **§7 config deepening** — selector-slot placement, ＋menu drag-reorder editor.
- **Remaining sim-click write paths** (`#options` / drawers) → ST exports.
- Group-chat conversation list, search 🔍, Mode B global list.

---

## Live-test status

Verified live before this stabilization pass: delete, swipe, scroll guard,
layout, config persistence, and the first ST-drawer hosting POC.

Browser live-test for the M-G review fixes passed (2026-06-28): topbar
rename/delete re-validates the authoritative chat identity before destructive
calls, temp-draft creation is serialized, and ＋新对话 is disabled/inert in group
chats.

Manual smoke test after the TS/Vite migration looked OK on 2026-07-01.

Automated checks for the current migration pass:

- `CI=true pnpm run typecheck`
- `CI=true pnpm run build`
- `CI=true pnpm run runtime` (build + sync + generated artifact check)
- `CI=true pnpm run check:runtime` (standalone generated artifact check)
- `git diff --check`
- `node --check` on representative generated runtime modules and the UI bundle

Still owed: continue / impersonate / regenerate (`#options` sim-click), stop, and
the broader mobile/sidebar regression pass.
