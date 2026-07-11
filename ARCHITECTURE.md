# SillyTavern-ChatUI · Technical Architecture

> **Status (2026-07-12): the migration described below is complete.** ChatUI is
> an extension-hosted Preact app behind a narrow SillyTavern adapter. The
> transitional Phase 1/2 layer that reshaped ST DOM in place has been removed
> (see `STATUS.md` → "Current Architecture"). Authored runtime and UI source now lives
> under `src/` and is compiled by Vite. The Stage 0–5 narrative in §5 is kept as
> the design record of how we got here; the "Current coverage" notes reflect the
> end state. Native `#chat` / `#send_form` remain alive but use `display:none`
> under the shield, as runtime/fallback surfaces only.
>
> `DESIGN.md` is the authority for visible product and Manuscript Flow decisions.
> This document owns technical boundaries; it must not introduce a competing
> visual direction.

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
src/index.ts       source entry for the extension bootstrap
src/adapter/       authored SillyTavern integration boundary
src/store/         authored ChatUI view-model stores/actions
src/shield/        authored DOM shield
src/ui/app.tsx     source entry of the ChatUI app
src/ui/components/ authored Preact UI components
dist/runtime/      compiled runtime modules copied to the extension root
  chunks/vendor/   stable bundled runtime dependencies (currently Zod)
dist/root-app.mjs  compiled UI bundle loaded by the runtime modules
```

For local development, run the build from the extension directory:

```sh
pnpm run verify
pnpm run runtime
pnpm run dev
```

`verify` runs typecheck, Node tests, a clean build, and an assembled runtime
contract without touching the live tree. `runtime` assembles a complete staging
candidate, validates manifest entries, every generated relative import, the
explicit ST external allowlist, and forbidden dependency/local paths, then
atomically switches the live symlink to that validated release. `dev` uses the
same candidate validation and publication path.

The preferred repository layout is a single ChatUI repository with two branch
roles:

- `main`: development branch with TSX source, scripts, and docs.
- `dist`: default installation branch with only SillyTavern-loadable runtime
  files.

For local development, `pnpm run dev` keeps `.runtime/SillyTavern-ChatUI`
validated and current. The SillyTavern checkout should symlink its
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
- Restore the page cleanly on extension teardown or failed setup.

Rules:

- Do not delete SillyTavern DOM nodes unless teardown can fully restore them.
- Prefer staged shielding before strengthening a new rule:
  - visual hiding
  - pointer/focus disabling
  - layout isolation
  - only then `display: none` for proven-safe hidden surfaces
- Keep every shield rule scoped under `body.chatui-active`.

The dependency audit for `#chat` / `#send_form` is complete, so the current
level-4 shield deliberately uses `display:none` for both. Bootstrap commits that
visible switch last (`store → root → shield`); rollback/teardown restores the
shield first and continues through every cleanup even if one throws.

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

Raw live messages are projected once at this boundary into immutable,
fully-normalized `MessageSnapshotDto` values. Store/UI code no longer interprets
ST catch-all records. Active-chat ownership is also normalized at the boundary:
`chat-key.ts` encodes typed character/group/unscoped scope plus a session-filename
locator, so delimiter-like names cannot collide. The filename is intentional:
ST copies `chat_metadata.integrity` into branches/checkpoints and may generate an
unsaved replacement for legacy chats, so that field is not a conversation id.
ChatUI-owned ephemeral state migrates on confirmed chat rename and
`CHARACTER_RENAMED` events.

ST materializes a real JSONL as soon as `doNewChat()` runs, but its delete
endpoint has no server-side revision CAS. A client-side read/hash followed by
DELETE therefore cannot prove that another tab did not save user content between
the two requests. ChatUI does not auto-delete abandoned drafts. Instead, every
unadopted `{avatar,fileName}` is a persisted quarantine lease and remains filtered
from ordinary conversation history. Successful navigation captures the active
lease only after it owns the host lane—after any still-materializing new-chat task
has committed—then deactivates but retains that lease. Composer text, pending send,
and staged attachments are checked before ST's `CHAT_CHANGED` listeners can reset
them; local work adopts the chat rather than quarantining it.

Quarantine uses one localStorage key per conversation instead of one global slot,
so different tabs can add drafts without last-writer-wins loss; `storage` events
merge additions/removals into each live page. The sidebar exposes dormant leases
in a separate “未完成草稿” shelf with an explicit restore path. Send, edit, swipe,
delete, attachment/reasoning mutation, and generation-start events remove the
current lease and publish the conversation normally; prompt dry-runs and quiet
background probes explicitly do not. Restore first checks the raw filename list,
so a stale lease cannot make ST recreate a missing file from the greeting. An
uncertain rename quarantines both old and server-confirmed new identities until
raw state resolves the conflict. Physical deletion remains an
explicit user action using the hardened adapter protocol: carry stable avatar +
file name across every await, use the raw filename endpoint as existence truth,
cancel both save timers, and recheck generation/save state. Character-card pointer
writes are read back through
`/api/characters/get`; neither transport failure nor a 2xx from `merge-attributes`
is treated as durable proof. An ambiguous assignment converges by repeating the
same idempotent target while the host lane remains owned. If the target is current,
persist its replacement before DELETE, retry raw post-verification until the
outcome is known, seal the queue, then hard-reload from durable state.
`CHAT_DELETED` is emitted only after reload. Versioned `{id,avatar,fileName}`
tombstones are kept as a set, absence-checked, and retained for idempotent cleanup
replay because ST's emitter does not expose per-listener acknowledgement. The adapter deliberately never calls
ST's global-`this_chid` `openCharacterChat()` after deleting a current file.

Rename uses the same stable-avatar readback plus raw before/after file sets to
resolve response loss and the server-confirmed sanitized filename. A current rename
does not release the host lane until the live filename exists; it either aligns the
durable pointer, or terminally reloads a different existing durable winner. Native
active rename is correlated across ST's `CHAT_CHANGED → CHAT_LOADED → CHAT_RENAMED`
ordering so ChatUI draft/temp state follows the actual loaded filename.

Current exception: the settings shell can host selected SillyTavern drawer
contents because those panels are still ST-owned configuration UIs. This is
implemented only in `src/adapter/settings.ts`: the adapter snapshots the exact
live drawer node, original parent/sibling, classes, inline style, icon state,
and drag handles before reparenting into `StDrawerHost`, then restores or parks
the node on unmount. Preact components may ask the adapter to mount/unmount by
drawer id, but must not inspect or mutate the hosted drawer DOM.

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
        messageIds: [0],
        messageCount: 1,
        lastMessageId: 0,
        chatKey: '["character","avatar.png","session:Chat - 2026-07-10"]',
        currentChat: { avatar: 'avatar.png', fileName: 'Chat - 2026-07-10' },
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

SillyTavern exposes one mutable active-chat context, so context-sensitive
mutations share `host-operation-queue.ts`. Every known ChatUI chat-bound entry path
(navigation, chat-file operations, send, message edit/delete/swipe/media, wand/QR,
and generation triggers) enters that lifecycle-aware lane and revalidates its
expected `chatKey` before touching ST. Navigation is last-intent-wins before entry
into ST; an operation with an observable completion stays in the lane until that
completion settles. Message edit awaits ST's delegated jQuery handler (including
its durable save), while generation actions wait without a timeout for start and
stop/end. A terminal reload seal rejects all queued and newly arriving work. Full
teardown increments the lifecycle epoch, so queued work from the previous UI
instance cannot mutate a newly mounted one.

Wand and Quick Reply adapters can observe only their live primary click, not an
arbitrary third-party handler's asynchronous completion. Their click entry is
serialized, but plugin-owned work after the click is not claimed as lane-owned.

Async draft state uses explicit ownership rather than timing assumptions:

- temp pointer and optimistic new-chat draft snapshots carry independent
  versions; abandon/cancel/commit operations compare-and-set before changing
  state. Concrete pointers form a persisted quarantine set; leaving deactivates
  one lease without publishing it, while adoption or confirmed explicit deletion
  removes only the matching identity;
- composer drafts live in `composer-draft-store.ts`, keyed by `chatKey`, so a
  settings unmount or chat switch cannot lose or leak text;
- a send token captures `chatKey + text + draftRevision + lifecycleEpoch`,
  revalidates the live key after waiting in the host queue, and clears only the
  exact submitted draft. A same-text ABA edit or teardown/re-enable invalidates
  the token.

Send acceptance and model generation completion are separate contracts. A normal
user message is accepted only when `USER_MESSAGE_RENDERED` names the captured
append index, the same chat locator is still active, and that row is actually a
user row; bare `MESSAGE_SENT` is ignored because extensions can emit it for other
work. There is no acceptance timer. Bias-only input validates its committed
system row when generation settles. Empty continuation input waits for full host
completion. Slash input requires ST's synchronous command-ownership boundary—the
native textarea is cleared while its slash busy flag is set—so a competing command
pipeline's normal-returning no-op cannot clear the draft. Acceptance commits the
exact draft; the host lane and global send gate remain owned until the independent
`operation.completion` settles.

This is deliberately conservative, but it is not a request-scoped receipt: ST's
current global events cannot distinguish a genuinely concurrent foreign user
append at the same index. A complete upstream contract would return
`{ accepted, completion }` from one textarea-send invocation with a private
request token; until then a correlation mismatch retains the draft instead of
guessing success.

Two other strict guarantees require upstream contracts. `merge-attributes` has
no compare-and-set token, so after a transport-ambiguous pointer assignment the
client cannot both wait for a late commit and preserve an unrelated other-tab
winner; ChatUI chooses convergence to the explicit destructive intent while
holding its local lane. A server conditional-write/operation id is the complete
fix. Also, native non-active rename events report the requested filename rather
than the server-sanitized filename; ChatUI therefore refuses to guess that draft
migration. Active native rename is safe because the loaded key supplies the
actual destination, and ChatUI-owned non-active rename uses its checked response.

Message DTOs live in a per-id map outside the parent chat snapshot; the parent
stores only ordered visible ids and aggregate fields. `useChatuiMessage(id)`
subscribes to one slot, and streaming token bursts are coalesced to one last-row
refresh per animation frame. In-place stream/edit/swipe updates are therefore
O(1): no full message-array clone, map spread, or parent chat rerender.

### 3.4 ChatUI UI

The UI owns rendering and user interaction.

Current framework choice:

- Preact with `preact/compat`.
- TypeScript/TSX for authored UI components.
- Vite compiles the runtime modules with preserved module boundaries.
- Vite bundles the UI framework/component layer into `dist/root-app.mjs`.
- Store, shield, and action modules stay external imports from the UI bundle so
  runtime singletons are shared with the extension bootstrap.

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

All external stores are consumed through `useSyncExternalStore`, giving Preact a
stable subscription/snapshot contract. Sidebar server state remains in TanStack
Query; `SIDEBAR_INVALIDATIONS_BY_EVENT` is the declarative ST-event → cache-scope
matrix and includes message update, delete, and swipe invalidations. Expensive
all-character refetches are marked stale first and active queries are drained
through the tested dependency-free `bounded-work-coordinator.ts`. A duplicate for
queued work is already covered by that future fetch; an invalidation arriving
after the fetch starts marks it dirty, and completion requeues exactly one bounded
follow-up. For an inactive
first prefetch, the worker awaits the old `query.promise` and calls `query.fetch()`
directly, so React Query's disabled-query filter cannot swallow the post-event
request.

### 3.5 HTML Card Trust Boundary

Complete HTML fenced blocks intentionally run in unsandboxed iframes. This is
required for compatibility with TavernHelper, MVU, and surrounding SillyTavern
page APIs; executing a card is therefore equivalent to executing trusted chat
code with page privileges. Users must trust the card, character data, and chat
history. A sandbox or execution-confirmation gate would change that compatibility
contract and is explicitly not part of the 2026-07-10 hardening.

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
  -> Shared host-operation queue (for active-chat mutations)
  -> ST Adapter call
  -> SillyTavern runtime
  -> SillyTavern event
  -> Store refresh
```

This keeps SillyTavern integration one-way at the boundary and prevents UI code from growing hard dependencies on SillyTavern's current DOM.

---

## 5. Migration Strategy

### Stage 0: Phase 1/2 (retired)

The original implementation:

- Reshaped `#send_form` in place (composer wrap, plus-menu, selector, QR float).
- Reused and relocated existing controls.
- Injected `cui-` nodes into existing `.mes` message DOM.
- Centralized SillyTavern DOM fallback actions in `adapter/st-adapter.js`.

This was acceptable as a transitional phase and has since been **removed**
(2026-06-23) in favor of the adapter + store + Preact root below. Only the last
point survives: ST DOM fallbacks remain centralized in the adapter.

### Stage 1: Introduce Adapter

Add an adapter module while keeping current UI mostly intact.

Targets:

- Centralize all `getContext`, `eventSource`, and DOM fallback calls.
- Replace direct UI imports from SillyTavern modules with adapter calls.
- Document every fallback that still triggers original DOM controls.

Current coverage:

- Message layout/actions/extras, floating chrome, and plus-menu actions use `src/adapter/st-adapter.ts` for ST state, events, generation status, and DOM fallbacks.
- Direct ST runtime imports are contained by `src/adapter/` plus the extension
  bootstrap's settings registration; the UI/store layers do not import host
  modules. Remaining DOM dispatches are adapter-contained compatibility debt.

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

- `src/store/chat-store.ts` builds `ChatuiMessageDto` objects from `chatuiAdapter.getCurrentChat()`.
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

- `src/shield/st-dom-shield.ts` creates and removes `#chatui-root` with the global `chatui-active` gate.
- `src/ui/root.ts` mounts the built ChatUI-owned app shell into `#chatui-root`.
- The root shell renders a Store-driven message list from `ChatuiMessageDto` objects and subscribes to store updates.
- The root shell is the active visible surface; the native chat/composer remain
  hidden but alive as runtime bridges.

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

- `src/shield/st-dom-shield.ts` applies `data-chatui-shield-level="4"` by default while ChatUI is active (hiding both native surfaces with `display:none`).
- Level 1 shields only lightweight native chrome that already has ChatUI replacements or Phase 2 restyling:
  - stock left-form menu/wand buttons replaced by ChatUI's plus menu,
  - native message name/timestamp chrome replaced by ChatUI identity headers,
  - native message buttons replaced by ChatUI action rows/menus,
  - native avatar gutters and user-message swipe chrome hidden by the current message layout.
- Level 2 promotes the ChatUI-owned `#chatui-root` as a constrained visible message band.
- Level 3 promoted `#chatui-root` to the primary message surface.
- Level 4 now hides both original `#chat` and `#send_form` with `display:none`
  while keeping their DOM and native pipelines alive for adapter fallbacks.
- ChatUI owns navigation chrome; hosted ST drawer contents remain live until
  their individual settings UIs are replaced.

### Stage 4.5: Root Message UI

Make the ChatUI-owned message surface usable enough to carry the primary chat
experience.

Current coverage:

- `src/ui/root.ts` is now a stable runtime wrapper around the built Preact app in `dist/root-app.mjs`.
- `src/ui/app.tsx` renders `ChatuiMessageDto` objects into the ChatUI root as the primary message list.
- Message UI is split across `src/ui/components/MessageItem.tsx` and
  `src/ui/components/message/*.tsx`.
- The root UI is authored as a Preact/compat TSX app, while store and adapter boundaries remain unchanged.
- Message bodies use adapter-produced sanitized HTML from SillyTavern's existing `messageFormatting()` path.
- Root messages render avatar/name/time metadata, swipe labels, reasoning details, Markdown/code blocks, code-copy affordances, and a root-level generating indicator.
- Root message actions dispatch through `src/store/chat-actions.ts`, which forwards intent to adapter by message id.
- Supported root actions: copy, regenerate last character message, swipe left/right, edit, delete, branch, checkpoint, and hide.
- Floating chat chrome reads the root scroll surface first and falls back to `#chat` only when root is unavailable.

Still deferred:

- Replacing the currently hosted ST drawer contents with ChatUI-owned settings.
- Full parity for media editing controls such as caption, delete, and media
  gallery swipes.

### Stage 4.6: Root Edit Mode

Make message editing visible and controlled from the ChatUI-owned root surface.

Current coverage:

- `src/ui/components/message/MessageEditor.tsx` owns the inline edit surface for root messages.
- Editing state is local to the Preact root app.
- Save/cancel controls are rendered by ChatUI, not by SillyTavern's hidden
  message DOM.
- `src/store/chat-actions.ts` exposes `saveEditedChatuiMessage(messageId, text)`.
- `src/adapter/st-adapter.ts` saves through SillyTavern's native `messageEdit()`
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

- `src/ui/components/Composer.tsx` renders a ChatUI-owned composer at the bottom of the root
  app.
- Submit/stop controls dispatch through `src/store/chat-actions.ts`.
- `src/adapter/st-adapter.ts` writes into the hidden native `#send_textarea` and
  calls SillyTavern's exported `sendTextareaMessage()` path, preserving slash
  commands, macros, generation routing, and persistence semantics.
- `src/shield/st-dom-shield.ts` shields the original `#send_form` at level 4
  without removing it from the DOM.

Attachment chips and QR shortcuts are now ChatUI-owned. A direct send API that
does not need the native textarea bridge remains deferred.

### Stage 4.8: Root Drawer Foundation

Introduce a ChatUI-owned shell drawer for navigation while SillyTavern still
owns the actual settings/list panel contents.

Current coverage:

- `src/ui/app.tsx` renders the root topbar and the current two-pane shell.
- Settings mode renders ChatUI-owned navigation plus `src/ui/components/settings/StDrawerHost.tsx` for selected ST drawer contents.
- Drawer/settings actions dispatch named shell intents through `src/store/chat-actions.ts`.
- `src/adapter/st-adapter.ts` and `src/adapter/settings.ts` map those intents to SillyTavern drawer controls
  such as characters, groups, AI config, world info, personas, extensions, and
  user settings.

Character/chat navigation and the ChatUI settings shell are now owned. Search,
group-chat/global list completeness, stable drawer route state, focus trapping,
and deeper keyboard navigation remain deferred.

### Stage 4.9: Root Rich Media

Render message attachments inside the ChatUI-owned message list.

Current coverage:

- `src/adapter/st-adapter.ts` converts current and legacy ST attachment fields
  (`extra.media`, `extra.files`, `extra.image`, `extra.video`,
  `extra.image_swipes`, and `extra.file`) into plain media/file DTOs.
- `src/store/chat-store.ts` exposes attachments on each `ChatuiMessageDto`.
- `src/ui/components/message/MessageMedia.tsx` renders image, video, audio, and file attachments after the
  message body.
- Image/file open actions dispatch back through adapter fallbacks, so ST's
  preview/file logic remains the source of truth.
- Root UI respects `extra.inline_image === false` by hiding message text when
  ST would show the attachment as the whole message.

Still deferred:

- Media delete/caption controls.
- Gallery swipe controls for root media.
- Rich attachment composer editing beyond the current pending-file chips.

### Stage 5: Optional Extraction

Only after the adapter API is stable should it be considered for extraction into a separate package or repository.

Likely shape:

```text
@chatui/sillytavern-adapter
```

This package would still require a running SillyTavern page. It would be a browser runtime bridge, not a standalone SillyTavern core SDK.

---

## 6. Dependency Inventory

> Note (updated 2026-07-10): the native `#chat` and `#send_form` surfaces are
> hidden with `display:none` by the shield (default level 4), so per-element "Level 1"
> hiding in the *Hide strategy* column is historical — those native controls are
> already invisible inside the hidden surfaces. The table is kept as the
> dependency record; the ChatUI replacements now live in the Preact root and the
> adapter fallbacks.

Before hiding or replacing a SillyTavern DOM area, record:

| ST area | ChatUI replacement | Runtime dependency | Hide strategy | Done |
|---|---|---|---|---|
| `#send_form` | ChatUI composer | send pipeline and hidden textarea bridge | Level 4 `display:none`; keep native form alive for runtime | Partial |
| `#chat` | ChatUI message list | rendered message nodes and remaining media/file fallbacks | Level 4 `display:none`; keep ST chat alive for runtime | Yes |
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
  manifest.json
  style.css
  src/
    index.ts
    adapter/
      st-adapter.ts
      internals.ts
      messages.ts
      composer.ts
      media.ts
      menu.ts
      selectors.ts
      schema.ts
      chat-key.ts
      chats.ts             # stable public facade
      chats/
        state.ts           # DTO contracts + live ST chat context helpers
        queries.ts         # character/chat list projections
        navigation.ts      # character and chat switching
        selection-protocol.ts
        rename-transaction.ts
        delete-transaction.ts
        deletion-finalization.ts
      qr.ts
      config.ts
      settings.ts
    store/
      create-store.ts
      chat-store.ts
      chat-actions.ts
      sidebar-actions.ts
      host-operation-queue.ts
      temp-chat-store.ts
      composer-draft-store.ts
      config-store.ts
      ui-store.ts
      toast-store.ts
    shield/
      st-dom-shield.ts
    ui/
      root.ts
      app.tsx
      actions.ts
      hooks.ts
      format.ts
      types.ts
      components/
    types/
      st-externals.d.ts
  dist/
    runtime/
      index.js
      adapter/
      chunks/vendor/zod.js
      store/
      shield/
      ui/
    root-app.mjs
    root-app.mjs.map
  scripts/
    build.mjs
    dev.mjs
    runtime.mjs
    check-runtime.mjs
    vendor/zod-mini.mjs
  test/
    check-runtime.test.mjs
```

Authored code belongs under `src/`; generated browser output belongs under
`dist/`. Runtime-only files still appear at the synced extension root because
SillyTavern loads the extension through `manifest.json`.

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
