# SillyTavern-ChatUI · Current Status

Last updated: 2026-08-05

This document is the short operational snapshot. `ARCHITECTURE.md` remains the
long-form design record. `DESIGN.md` is the product spec / north star.
`ROADMAP.md` is the live completeness map + priority backlog.

Current development branch: `main`, and everything below is *on* it. The
corridor-theater stack of five branches merged on 2026-08-01 (`b3d3bdb`); the
2026-07-10/11 architecture hardening, visual restoration and desktop floor
navigation are kept as reviewable semantic batches, and the stack's branches are
kept for the same reason — as review-sized records, not as work in flight. See
Current Branch Stack for the topology and Current Visual Identity for what
`main` renders.

## Current Visual Identity

The corridor theater (长廊剧场) has landed. `DESIGN.md` — the north star since
2026-07-31 — specifies an ink-dark stage, a 58px character spine plus a 252px
playbill of conversation cards, xuan-paper popovers, cinnabar danger and dashed
binding rules, and that is what the app now renders. "New palette, old layout"
was the honest reading of this document's previous revision; it is out of date.
The correct reading today is "new palette, new layout, four surfaces still
speaking the old dialect" — see the chapter table below.

All of it is on `main`: tokens and the type scale, the shared `.cui-paper`
popover, the paper confirm dialog, and then the stage, the action bar, the swipe
ticks, the spine, the playbill and the topbar. A checkout of `main` is the
corridor theater; there is no branch left to look at for it.

Chapter by chapter against the handoff's ten Screens/Views
(`~/Developer/design_handoff_corridor_theater/README.md`):

| # | Chapter | State | Landed on |
| --- | --- | --- | --- |
| 1 | 对话列表卡片 | **done** — cards, binding gutter, hover action dock, in-place rename. The dashed 未完成草稿 cards pr9 added were retired again on 2026-08-02: a new chat is an ordinary conversation now (DESIGN §4.2) | pr9 |
| 2 | 空态（无角色） | **half** — the playbill says 「书架还空着……」; the 300px 空戏单 card on the stage (虚位以待, drag in a PNG/JSON card, 浏览文件) is not built | — |
| 3 | 楼层刻度轨 | **refused on purpose** (`DESIGN.md` §4.3) — desktop keeps ChatUI's own measured `2px/8px` ticks, 40px safety and bounded wheel window; only the preview bubble's floor number and edge fade were aligned | main |
| 4 | 消息流 | **done** — stage ground, connector header row, ruled body, thinking block, action bar, swipe ticks, in-place editor, ⋯ menu, 回到最新 capsule | pr4·pr5·pr6 |
| 5 | 开场白选择 | **not built** — none of the three forms (inline list, 520px modal, 「换一个开场」 capsule); `DESIGN.md` has not adopted the chapter either | — |
| 6 | Composer | **done** — fade mask, decoration row, preset chip, ＋menu, send/stop, hint row | pr4 |
| 7 | Topbar | **most of it** — two-tier title, persona chip and the rename pencil are in; the ⋯ menu carries 3 of the handoff's 5 rows plus rename, and is missing 让模型重拟题名 and 导出为纯文本 (both need adapter exports that do not exist) | pr4·pr7 |
| 8 | 宣纸菜单 | **done** — one shared `.cui-paper` surface | main |
| 9 | 删除确认弹窗 | **done** — outline danger button, 300ms Enter guard | main |
| 10 | Toast | **token-only** — reads the palette but keeps the old grammar: top-centered pill row, not the design's bottom-120px card | — |

Three more surfaces are in the same position as chapter 10: the settings shell,
code blocks and the QR bar read `--cui-*` so they inherit the ink palette, but
none of them was given the dialect. They were left out of every chapter above
deliberately, not missed.

The Manuscript Flow grammar is not discarded wholesale — `DESIGN.md` keeps it as
the grammar *inside* the stage: a title-page topbar, three tiers of hairline
rules, open reading-flow messages, a rust user margin, a seal-shaped generation
state, and a ledger composer. Desktop long-form reading keeps its own left-spine
floor index (the handoff's rail spec is explicitly not adopted): it forms a local
wave and reveals a short excerpt only while inspected. What the corridor theater
changed is the navigation architecture around all of that.

`DESIGN.md` §9.1 lists four things that are refused on architectural rather than
taste grounds and are therefore *not* backlog items: per-character `chunk-in`
streaming, a global `scroll-behavior: smooth`, any external CDN (which is why
Noto Serif SC is requested and then falls back to locally installed serifs
rather than being fetched), and any unscoped `::-webkit-scrollbar`.

## Current Branch Stack

**Nothing is stacked any more.** The corridor-theater restyle — 49 commits across
nine review-sized branches — landed on `main` in `b3d3bdb` on 2026-08-01, and
`main` has moved on past it since. The branches are kept as review records, in
the order the chapters were *written* (which is not their numbering: pr7 was
written last and sat on pr9; there is no `pr8`):

```text
refactor/pr0-design-tokens        tokens + type scale
refactor/pr1-token-conformance    every consumer reads a token
refactor/pr2-paper-popover        the shared .cui-paper popover
refactor/pr3-paper-confirm        the paper confirm dialog
refactor/pr4-stage-skin           19  stage / message / composer / topbar skin
refactor/pr5-actions-ia           +4  one action bar for every turn
refactor/pr6-swipe-segments       +5  swipe versions as segment ticks
refactor/pr9-spine-playbill      +13  sidebar → spine + playbill
refactor/pr7-topbar-trio          +8  topbar rename + the ⋯ trio
```

They are behind `main` and are not rebase targets. Branching off one lands in the
pre-teardown world — the temp-chat quarantine is still there — so start from
`main` unless you are reading history on purpose.

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
  |     (hides native #chat / #send_form via display:none; promotes #chatui-root)
  |
  +-- src/adapter/ -> adapter/  (the ONLY layer that touches ST internals)
  |     st-adapter.ts is the frozen facade; behavior split across
  |     internals · messages · composer · media · menu · selectors ·
  |     chats · qr · config · settings submodules; returns immutable DTOs
  |
  +-- src/store/ -> store/  (ST-free observable view-model, createStore factory)
  |     chat/config/ui/toast/menu/confirm/composer stores + named action facades;
  |     host-operation-queue serializes mutable active-chat operations
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
    schema.ts             Zod schemas + immutable MessageSnapshot DTO projector
    chat-key.ts           typed, collision-free character/group chatKey codec
    messages.ts  composer.ts  media.ts  menu.ts  selectors.ts
    chats.ts              stable chat adapter facade
    chats/                state/query/navigation + rename/delete protocols
    qr.ts        config.ts     settings.ts
  store/                  ST-free observable view-model (createStore factory)
    create-store.ts       tiny observable store primitive
    chat-store.ts / chat-actions.ts
    sidebar-actions.ts    Query-facing reads + serialized navigation/chat mutations
    host-operation-queue.ts shared host mutation lane + last-intent-wins navigation
    session-characters.ts characters ChatUI gave a conversation this session
    composer-draft-store.ts per-chatKey drafts + send-token CAS gate
    config-store.ts       persisted per-feature config (via adapter/config.ts)
    ui-store.ts           ephemeral session UI state (settings mode / drawer selection)
    menu-store.ts         the single open-menu slot (mutual exclusion as state)
    confirm-store.ts      confirm-dialog request slot + its keyboard decision table
    message-edit-draft-store.ts per chatKey+messageId edit drafts
    bounded-work-coordinator.ts caps concurrent work and runs one dirty follow-up
    toast-store.ts        ChatUI feedback layer
    vanished-chat-store.ts announces a conversation proved absent (no ST event exists)
  shield/
    st-dom-shield.ts      #chatui-root + body.chatui-active + shield levels
  ui/
    app.tsx               root Preact shell (spine | playbill | stage; settings swaps the
                          playbill slot and the stage, the spine stays mounted)
    root.ts               stable runtime wrapper for dist/root-app.mjs
    actions.ts hooks.ts format.ts types.ts sidebar-queries.ts query-client.ts
    use-st-query-bridge.ts  ST event / vanished-chat → Query invalidation table
    card-embed.ts         HTML fenced card iframe host
    spine-cast.ts  floor-rail-math.ts  follow-scroll-math.ts
    swipe-segment-math.ts  topbar-menu-logic.ts  menu-placement.ts
    escape-ladder.ts  blank-conversation.ts  message-menu-rows.ts
                          dependency-free decision modules, unit-tested directly
    components/
      Composer  PlusMenu  QRBar  SelectorChip  AttachmentChips
      MessageItem  MessageFloorRail  TopbarTitle  TopbarMenu
      ConfirmDialog  ConfirmDialogHost  Toaster
      sidebar/  Spine Sidebar CharacterConversationList
                NewChatButton SettingsEntry
      settings/ SettingsNav SettingsContent ChatUiSettingsContent StDrawerHost
      config/   ConfigSelect PlusPinEditor
      message/  ActionButton MenuItem MessageActions MessageAvatar
                MessageEditor MessageMedia MessageReasoning SwipeSegments
  types/st-externals.d.ts SillyTavern host-module declarations
scripts/                  build / dev / validated atomic-runtime tooling
  e2e/                    dataRoot / host / Playwright / performance harnesses
test/                     Node built-in state/runtime contract tests + fixtures
  e2e/                    pinned ST version, synthetic users, smoke/400-floor data
e2e/                      real-browser Playwright contracts (not Node auto-discovery)
dist/                     generated browser output (gitignored)
```

The extension installer does not build plugins. Authored Preact/TSX is bundled
with Vite into `dist/root-app.mjs`; runtime TS modules are compiled with Vite
into `dist/runtime/`, with Zod bundled at the stable
`dist/runtime/chunks/vendor/zod.js` path. `pnpm run runtime` assembles a complete
candidate beside the live tree, validates the manifest/module graph and browser
artifact contract, then atomically switches `.runtime/SillyTavern-ChatUI` to the
validated release generation. `dev` uses the same validation/publication path.

---

## Ownership Boundary

ChatUI owns: the navigation center (the character spine and the playbill of
conversation cards), the root topbar including its in-place title rename, the
visible message list and its desktop floor navigator, message
body/media/reasoning rendering, the inline edit surface, the composer (＋menu,
selector chips, attachment chips, QR bar), the toast feedback layer, and the
ChatUI-native settings shell.

SillyTavern still owns: chat persistence, generation/regeneration, settings,
extension events, file previews, and all native drawer panel contents. ChatUI may
temporarily host a live ST drawer inside its settings shell, but only through
`src/adapter/settings.ts` + `StDrawerHost`; UI code never reaches into the
drawer DOM directly. The native `#chat` and `#send_form` stay alive in the DOM
(hidden via `display:none`, as of 2026-07-05 — previously clipped to 1x1px,
which let ST's own jQuery/jquery.transit render pipeline keep doing real,
measurable layout work over a surface nobody could see) because ST
render/update/send/edit semantics still flow through them; the adapter bridges
ChatUI intents into those native pipelines. A few ST-native keyboard shortcuts
that depended on the native surfaces' own visibility (Escape-to-stop,
Ctrl+Enter-regenerate, ArrowUp-edit-last) silently stopped working under real
`display:none` and are now reimplemented against ChatUI's own state
(`src/ui/hooks.ts` `useChatuiEscapeKey`, `src/ui/components/Composer.tsx`). That
Escape listener is now the app's only global one: since the menus became a
single state machine it also has to dismiss whichever floating menu is open, and
the two meanings are decided together by `src/ui/escape-ladder.ts` rather than by
a second listener racing the first (see INVARIANTS §9.2).

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
ChatUI-native settings or a live ST drawer host on the right. That two-pane shell
was the shape until pr9; `DESIGN.md` §3's `Spine | Playbill | Stage` is what
`main` renders now, with settings still a mode swap — the nav takes the
playbill's slot and the spine stays mounted beside it, which is why picking a
character from a settings pane also leaves settings.

Desktop long conversations now expose a left-spine user-turn navigator beside a
shared bounded reading column. One `2px` hairline represents one user message, with a
fixed `8px` gap (`85778e6` loosened it from the `6px` this section used to
report); short stacks are vertically centered and inset `16px` from the
main edge. The shared reading column is capped at `680px` — pr9 recalibrated it
from `54rem` in the same change that added the `58px` spine, because the rail's
mount threshold is a function of both (`DESIGN.md` §3.1: keeping `54rem` would
have pushed it to ~`1310px` and made the rail vanish on a 1280px laptop with
nothing failing to say so). The rail mounts only
when the resulting left gutter leaves at least `12px` after its wave, so it never
overlays prose. Hover previews that user's words plus the next character reply.
Overflow becomes a height-bounded tick window with `40px`
top/bottom safety; it follows the active turn to the bottom and uses wheel input
to browse hidden turns. While that window moves, tiny top/bottom labels expose
its first and last user-turn numbers, then fade after input stops. Touch/mobile
deliberately remains unchanged until a separate mis-touch-resistant interaction
is designed.

**2026-08-02/03: this whole section describes something that no longer exists.**
The owner retired the 「未完成草稿」 tier outright (DESIGN §4.2), and the machinery
below went with it over two passes: the reader-facing layer first (draft cards,
the filter that withheld a new chat from the playbill, the ＋新对话 highlight, the
one-new-chat-at-a-time rule, the character picker), then `temp-chat-store.ts`
(548 lines), `temp-chat-navigation.ts`, and most of the sessionStorage credential
in `deletion-finalization.ts`. ＋新对话 makes an ordinary conversation; an
abandoned empty one stays in the list for the reader to delete, which is ST's own
behaviour.

Kept here as a record of what the quarantine *was*, because the reasoning is
still the reasoning for why ChatUI does not auto-delete anything: ST materializes
a real JSONL as soon as `doNewChat()` runs, and its delete endpoint has no
server-side revision CAS, so a client-side read-then-DELETE cannot prove another
tab did not save user content in between. The old answer was to withhold the file
from history behind a per-conversation lease with ABA version stamps, adopted on
the reader's first mutation. The new answer is not to withhold it at all.

Two facts the lease set had also been carrying were re-homed rather than dropped:

- **which characters ChatUI knows have a conversation**, for the spine's
  membership rule — now `store/session-characters.ts`, an in-memory page-scoped
  ledger, because ST's `chat_size` is a boot-time disk snapshot and that is the
  entire problem it solves;
- **who to put the reader back on** after the reload a last-chat delete forces —
  now all the sessionStorage credential carries, spent at boot on the ledger entry
  and (on a stock `auto_load_chat: false` host) on seating them. Gated end to end
  on a real host by `scripts/e2e/verify-last-chat-delete.mjs`.

Deleting a character's *last* chat (pr9 third baton, rewritten by the fourth,
simplified again 2026-08-03) still gets its own handoff, because
`delete-transaction.ts` has to move the durable chat pointer somewhere when no
real chat survives to replace the deleted one, and it moves it to a fabricated
name nothing has written yet (`fallbackChatFileName`). `sidebar-actions.ts`
queues a `sessionStorage` credential — a sibling of the existing `CHAT_DELETED`
replay tombstone — right before the mandatory reload that path already requires.

What the next boot does with it is now one thing: put the reader back on that
character. It does *not* wait for ST to materialize the file, and no longer needs
to. Earlier versions did, because the file had to be folded into the quarantine
before it could be shown, and getting that observation's timing right was the
hardest thing in the module: ST writes it on a fire-and-forget chain APP_READY
does not wait for (`initRossMods()` at script.js:772 never awaits
`RA_autoloadchat()`), so the first implementation asked the chat directory too
early on every single boot, found nothing, and destroyed the intent. With nothing
being withheld, the file needs no identity guard at all — it is simply this
character's conversation, which is what ST would have produced on its own.

The boot spends the credential on the session ledger (so the spine can show a
character whose `chat_size` snapshot predates its own boot) and, on a stock
`auto_load_chat: false` host, on `selectCharacterIfNobodyIsOnStage` — otherwise
the forced reload lands on nobody at all, which is worse than the state this
transaction exists to prevent. Arming bounds the credential to the page it
belongs to; a page that never redeems it leaves nothing for a later boot to act
on. Deleting down to a
*remaining* real chat is unaffected — that path already worked and queues
nothing new.

The character a delete like that empties is also on the spine now, which is
what makes any of it reachable by hand at all. The spine's membership rule
(`ui/spine-cast.ts`) used to be
「`chat_size > 0`」 alone, and `chat_size` is a per-boot disk snapshot that is
never refreshed inside the page — so the character you were standing on
vanished from the only rail that can change character. Membership is now the
union of three sources: conversations on disk, on stage now, or in the session
ledger (`store/session-characters.ts` — characters ChatUI itself gave a
conversation this session, by ＋新对话 or by a post-delete landing). The
original purpose of the filter (a character nobody ever opened is not on the
bill) is kept. Ordering gains one band in front — the characters ChatUI knows
are live while the snapshot still reports nothing, whose recency key is absent
rather than old — and is otherwise the same `date_last_chat` order as before,
so the ordinary rail is untouched and only otherwise-absent entries gain a
position.

That handoff also depends on the reload coming back on the same character,
which it did not: `selectCharacterById()` moves only the live selection, and ST
writes the persisted `active_character` exclusively from its own
`.character_select` click handler (RossAscends-mods.js:849-854) — a row no
ChatUI path touches. With the spine as the only way to change character, every
reload used to land on whoever the reader last picked from ST's native list.
`adapter/chats/navigation.ts` now mirrors that handler's three calls on any
character selection that actually lands, and `sidebar-actions.ts` awaits a real
`saveSettings()` before its own forced reloads, because `saveSettingsDebounced()`
is one shared cancel-and-re-arm timer whose window a reload silently loses (the
same reasoning `index.ts`'s disable path already documents).

The committed 2026-07-10/11 hardening closes the main correctness gaps found in
the architecture review:

- ~~abandoned temp state is a per-conversation quarantine set~~ — **retired
  2026-08-03** with the 「未完成草稿」 tier it protected (DESIGN §4.2). The lease
  set, its ABA version stamps, the per-pointer localStorage keys and the
  `storage` cross-tab merge are all gone; see this document's temp-quarantine
  section above for what replaced the two facts they were also carrying;
- explicit user deletion is keyed by stable avatar + file name and checks the raw
  directory listing both before and after DELETE (not lossy chat search). Both
  chat-save and metadata-save timers are cancelled and generation/save state is
  rechecked. Character-card pointer writes require stable-avatar server readback;
  neither a dropped response nor `merge-attributes` 2xx is durable proof. For a
  current target, the page seals the host queue and reloads from the verified
  replacement after raw DELETE confirmation. Cleanup runs only in the rebuilt
  page and absence-checked, versioned tombstones are retained as a set for
  idempotent retry because ST cannot acknowledge individual `CHAT_DELETED`
  listeners;
- current chat rename uses raw pre/post file sets, the server-sanitized filename,
  pointer readback, and a final live-file safety proof. Response-loss ambiguity
  holds the lane; if a different real durable chat wins, a terminal reload rebuilds
  pointer and messages together. Active native rename preserves drafts across
  ST's reload-before-event ordering;
- setup is transactional (`store → root → shield`), teardown/rollback always
  attempts every cleanup, and partial event subscriptions are rolled back;
- `chat-key.ts` uses a typed character/group/unscoped tuple plus the session
  filename as an ephemeral locator. This makes metadata-copy branches distinct
  and legacy reloads stable; confirmed chat renames and `CHARACTER_RENAMED`
  migrate ChatUI-owned drafts/temp pointers instead of misusing ST's non-unique
  `chat_metadata.integrity` as a conversation id;
- all known ChatUI chat-bound entry paths share `host-operation-queue.ts`, revalidate the
  expected `chatKey` before entering ST, and are invalidated by a teardown epoch.
  Queued navigation remains last-intent-wins; observable async completions retain
  the lane, terminal reload rejects old/new work, and message edit awaits ST's
  delegated jQuery handler through its save. Wand/QR can guarantee only serialized
  click entry because arbitrary plugin async completion is not observable;
- temp pointer/optimistic draft mutations use versioned compare-and-set. Composer
  drafts are per `chatKey`, and send tokens capture both draft revision and
  lifecycle epoch, so text ABA or teardown/re-enable cannot clear a newer draft;
- normal-send acceptance has no arbitrary timeout and ignores bare
  `MESSAGE_SENT`: it requires the same chat locator, the captured append index,
  `USER_MESSAGE_RENDERED`, and an actual user row. Bias-only input is checked
  against its committed system row; empty continuation waits full completion;
  slash commands additionally require the native input-clear/busy ownership
  boundary so a competing slash no-op cannot clear the draft. The independent
  generation `completion` can fail later, while the shared host lane stays owned
  until it settles;
- raw host messages stop at the adapter as immutable `MessageSnapshotDto`
  objects. The parent chat store keeps message ids while each row subscribes to
  its own DTO slot, so coalesced streaming refresh is O(1) without a full-list
  clone or parent rerender. The declarative ST event → Query invalidation table
  covers update/delete/swipe. ChatUI's own "this conversation is not there"
  discoveries (a draft whose file vanished, a row the host reports notfound)
  reach the same bridge through `store/vanished-chat-store.ts`, because a file
  that went missing behind ST's back emits no event and the cached listing
  would otherwise keep serving it. The extracted bounded coordinator marks an
  active query dirty and requeues exactly one follow-up; inactive
  first-prefetch work awaits the old promise then calls `query.fetch()`
  directly;
- runtime publication is staging-first and atomic. The Node suite's coverage is
  inventoried invariant-by-invariant in INVARIANTS.md (bidirectionally validated
  by `pnpm run check:invariants`, so counts are never hand-written here): typed
  filename locators and rename migration, message snapshots, temp/composer CAS,
  host queue/reload semantics, chat rename/delete transactions, generation-lane
  guards, lazy DTO caching, manifest/import/path contracts, and release
  switching.

`ROADMAP.md` is the authoritative priority backlog. Current top items:

- **2026-07-10/11 hardening baseline** — committed through `af9a9d9`; source,
  type, build, runtime, adversarial review, and focused browser checks are green.
  Remaining local debt is broader browser/mobile and business-state-machine
  automation. Upstream debts are a request-scoped send/generation receipt, a
  conditional character-pointer write, async completion receipts for plugin
  clicks, and the actual sanitized target on non-active native rename events.
- **Desktop user-turn navigator** — implemented and live-tested on a 21-message /
  10-user-turn conversation, including centered fixed-pitch ticks, user→reply
  preview, bounded-window wheel browsing, click/keyboard jumps, embedded
  HTML-card exit, and the `768/769px` boundary. The mobile counterpart is
  intentionally a later product-design task, not a missing hover fallback.
- **2026-07-03 xhigh adversarial review** of the then-current
  JS→TS/Vite/TanStack-Query migration diff + WIP found 14 issues,
  including one critical build-breaking bug: the `ui/` → `src/ui/` directory
  move left `root.ts`'s bundle import path one level short, so the extension
  failed to mount at all in SillyTavern (static checks didn't catch it — only
  an actual build reproduced it). All 14 fixed, independently re-verified by a
  second adversarial pass, and confirmed live. See `ROADMAP.md`'s 已完成
  section for the full list.
- **2026-07-05**: html/js card embeds (HTML fenced blocks render as live
  same-origin iframes, auto-sized via an internal ResizeObserver + postMessage
  instead of an external `scrollHeight` read), a message-level HTML memo cache
  in `chat-store.ts` (fixes a `{{random}}`-macro-driven flicker on chat
  switch), and the shield's `#chat`/`#send_form` hiding moved from a 1x1px CSS
  clip to real `display:none` after a 5-agent static audit of every
  simulated-click write path found 11/13 already safe and closed the 2 real
  gaps (3 ST-native keyboard shortcuts that depended on native-surface
  visibility, and a latent `#send_form` inline-style collision in unreachable
  dead code). Chat-switch layout/style-recalc cost dropped from
  318ms+441ms to 50ms; forced reflow from 795ms to 74ms.
- **§7 config deepening** — selector-slot placement, ＋menu drag-reorder editor.
- **Remaining sim-click write paths** (`#options` / drawers) → ST exports —
  downgraded from "blocking" to ordinary architecture debt now that the audit
  above confirmed they don't depend on native-surface visibility either way.
- Group-chat conversation list, search 🔍, Mode B global list.
- Still not built: a toast warning when a card script calls a
  TavernHelper-dependent function but TavernHelper isn't installed.

### HTML card trust model

HTML cards intentionally run in unsandboxed iframes so TavernHelper/MVU and the
surrounding SillyTavern page APIs remain compatible. Loading a card is therefore
equivalent to running code from that chat with page privileges: cards, character
data, and chat histories must be trusted. This is a product compatibility
boundary, not an accidental missing sandbox; the 2026-07-10 hardening does not
add a sandbox or execution-confirmation gate.

---

## Live-test status

Verified live before this stabilization pass: delete, swipe, scroll guard,
layout, config persistence, and the first ST-drawer hosting POC.

Browser live-test for the M-G review fixes passed (2026-06-28): topbar
rename/delete re-validates the authoritative chat identity before destructive
calls, temp-draft creation is serialized, and ＋新对话 is disabled/inert in group
chats.

Manual smoke test after the TS/Vite migration looked OK on 2026-07-01.

**2026-07-03 fix-pass live-test**: after fixing the 14 findings from the xhigh
adversarial review (including the build-breaking `root.ts` mount path — the
extension did not mount at all before this fix), verified live in SillyTavern:
loads correctly, no console errors, and character switching is noticeably
faster than before (progressive sidebar loading + real schema validation
replacing the fake/wasteful Zod object-shape checks).

**2026-07-11 new-chat lifecycle live-test**: the exact quick path
`＋新对话 → immediately open an old chat` kept the new file out of ordinary
history and exposed one recoverable 未完成草稿 entry. Restore and explicit delete
both succeeded, and the ordinary conversation list returned to its pre-test
state without touching existing chats.

**2026-07-12 desktop floor-navigation live-test**: a 21-message conversation
produced exactly 10 user-turn ticks. The normal stack was centered; a constrained
height reduced it to a three-tick then one-tick window with ~40px safety margins,
kept the active final turn at the bottom, and wheel-up exposed an older prompt.
The popover paired user text with the next character reply and removed reasoning
wrappers. Click/keyboard, HTML-card exit, and the `768/769px` boundary remain
covered. At `1280px` the 30px rail retained 26px of clear space before prose;
at `1000px`, where the centered column left no real gutter, the rail did not mount.

**2026-07-15 deterministic host/browser test**: the test harness now generates a
disposable synthetic SillyTavern dataRoot with a V2/V3 JSON character card,
persona, settings and chat; it rejects the wrong ST commit, tracked checkout
drift, unsigned/out-of-run data roots and non-empty targets. The real Chromium
smoke verifies the host's selected character/chat/four raw messages, the mounted
SillyLounge projection, native-surface shield, composer and floor hover contract.
Host-global third-party extensions are disabled for the synthetic user so a
developer's installed plugins cannot make the test pass accidentally. The same
smoke passed both the existing development checkout and a clean CI-style checkout.

**2026-07-15 400-floor performance baseline**: `long-plain` deterministically
generates 400 user turns + 400 replies and measures pure ST, extension bootstrap,
and the active UI in fresh host/context pairs. Five rotated samples attribute the
main increment to the eagerly formatted/mounted full message list (800 articles,
3217 buttons, +12,167 DOM elements and +29.6 MiB median JS heap over bootstrap),
not the bounded floor rail. Exact method, results and the proposed virtualized
message-window direction are recorded in `PERFORMANCE.md`; timings remain
report-only until stable cross-run budgets exist.

**2026-07-31 corridor-theater stack verification**: the spine/playbill draft
lifecycle was driven on the real pinned 1.18.0 host across a 14-cell matrix —
autoload on/off × plain boot, last-chat delete, index-0 character, group on
stage, a zero-conversation character holding a lease, a pending credential that
points elsewhere / at nobody / at a deleted card / at a previous page, a draft
whose file vanished behind ChatUI's back, and a delete issued from inside a
draft whose file had already vanished. Each cell recorded spine membership and
order, the current character, leases, draft cards, `newChatActive`, the
sessionStorage credential, the persisted `active_character`, and
console/pageerror. All 14 passed, and the run found two real defects that were
fixed on the branch rather than filed: deleting the conversation you are
standing in was being settled as `absent` (which downgraded a live draft into
permanent history the moment ST saved it again), and an expiring credential
could seat a ghost character at the head of the spine for a whole session. That
matrix ran on `207d8a4`; what all of it still leaves uncovered is listed in
`INVARIANTS.md` §16 and in `ROADMAP.md`'s corridor-theater backlog.

**2026-08-01 final-gate live pass** (six more cells on the same pinned host,
driven by hand rather than by a committed script — the §16 gap is still a gap):
the topbar's in-place rename end to end (pencil reveal, focus, an Enter that
really renames the chat on ST, an Esc that really does not, the ⋯ row opening
the same edit), the ⋯ menu's six rows in design §7 order with 删除对话…… alone
in cinnabar, 从末楼开新分支 producing a real branch chat, 角色卡设定…… opening
ST's own right-nav panel, a group on stage disabling exactly rename / delete /
card-settings while 从末楼开新分支 stays live, a quarantined draft whose file
vanished leaving the playbill on 丢弃, and bootstrap mode selecting nobody
(with the ChatUI-on control confirming the same boot *does* select). Two
findings: the in-place rename inputs never took focus (fixed in `2054c94` —
both surfaces, root cause was `autoFocus` on a post-load mount), and an
ordinary history row whose file vanished still opens as an empty conversation
rather than announcing itself (`ROADMAP.md` G4, not fixed). The vanished-chat
invalidation was mutation-audited: neutering the bridge subscriber in the built
runtime reproduced the exact reported symptom — the draft card degrading into
an ordinary row pointing at nothing — and the fix removes it.

**2026-07-31 400-floor gate re-run** on `271f795`: `measure-long-chat.mjs`'s
floor-rail contract passed unchanged after the reskin — the wheel moved the tick
window (`324 → 319`) and left the message list's `scrollTop` at delta `0`,
Home/End previews and the `第 N 楼` numbering held, and no frame gap exceeded
50 ms (max 17.5 ms). The structural counts it reports are a *new* baseline; see
`PERFORMANCE.md`'s 2026-07-31 section for why the historical button counts are
retired.

Automated checks for the committed hardening baseline:

- `CI=true pnpm run verify` (typecheck + layer boundaries + Node tests + invariant map + build + assembled-tree contract; see INVARIANTS.md for the test-by-test inventory)
- `CI=true pnpm run runtime` (build + validate candidate + atomic live publish)
- `CI=true pnpm run check:runtime` (validate the current live runtime tree)
- `SILLYTAVERN_TEST_ROOT=… pnpm run test:st` (pinned disposable host smoke)
- `SILLYTAVERN_TEST_ROOT=… pnpm run test:e2e` (real Chromium host/DOM contract)
- `SILLYTAVERN_TEST_ROOT=… pnpm run test:perf -- --warmups 1 --repetitions 5`
  (400-floor three-mode report; no absolute CI timing threshold yet)
- `git diff --check`
- `node --check` on representative generated runtime modules and the UI bundle
- 2026-07-03: a 31-agent xhigh adversarial review (10 finder angles + verify +
  gap sweep) followed by a 15-agent independent re-verification pass (per-fix
  adversarial check + regression sweep) — 14/14 findings confirmed fixed, zero
  new regressions surfaced.

**2026-07-05**: continue / impersonate / regenerate / stop verified safe under
real `display:none` via a 5-agent static audit of ST's native handlers plus a
live test (Ctrl+Enter-triggered regenerate, interrupted mid-stream with
Escape — both worked, no console errors beyond the pre-existing
"TavernHelper is not defined" from JS-Slash-Runner not being installed in the
test environment). No longer owed.

Still owed: the broader mobile/sidebar regression pass, unifying the remaining
dual scroll ownership (`useAutoScroll` and virtualizer end anchoring), and
browser-driving the remaining destructive/message-action paths. The bounded,
variable-height message window and its historical-user/character edit acceptance
are now CI-gated in `measure-chat-switch.mjs`.
