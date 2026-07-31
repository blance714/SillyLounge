# SillyTavern-ChatUI · Current Status

Last updated: 2026-07-31

This document is the short operational snapshot. `ARCHITECTURE.md` remains the
long-form design record. `DESIGN.md` is the product spec / north star.
`ROADMAP.md` is the live completeness map + priority backlog.

Current development branch: `main`. The 2026-07-10/11 architecture hardening,
visual restoration, and desktop floor navigation described below are kept as
reviewable semantic batches. Two unmerged corridor-theater refactor branches sit
on top of it — see Current Visual Identity.

## Current Visual Identity

The visual identity is mid-transition. `DESIGN.md` now specifies the corridor
theater (长廊剧场) direction — an ink-dark stage, a 58px character spine plus a
252px playbill of conversation cards, xuan-paper popovers, cinnabar danger,
dashed binding rules — and it replaced the Manuscript Flow contract as the north
star on 2026-07-31. `main` has not caught up yet.

What has landed lives on two branches that are **not merged**:
`refactor/pr0-design-tokens` (`da23813`) rewrote the token layer and the type
scale onto the ink-theatre palette, and `refactor/pr2-paper-popover` (`2d56365`,
built on top of `da23813`) gave every menu one shared `.cui-paper` surface. That
is the design system plus one of the ten handoff chapters; the sidebar
information architecture, message flow, topbar, composer, and confirm dialog are
untouched, so `main` still renders the Manuscript Flow surface. "New palette,
old layout" is an accurate reading of the current build, not a rendering
glitch.

The Manuscript Flow grammar is not discarded wholesale — `DESIGN.md` keeps it as
the grammar *inside* the stage: a title-page topbar, three tiers of hairline
rules, open reading-flow messages, a rust user margin, a seal-shaped generation
state, and a ledger composer. Desktop long-form reading keeps its own left-spine
floor index (the handoff's rail spec is explicitly not adopted): it forms a local
wave and reveals a short excerpt only while inspected. What the corridor theater
changes is the navigation architecture around all of that.

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
  |     chat/config/ui/toast/temp/composer stores + named action facades;
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
    temp-chat-store.ts    persisted quarantine set + active/draft CAS state
    composer-draft-store.ts per-chatKey drafts + send-token CAS gate
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
      MessageItem  MessageFloorRail  TopbarMenu  ConfirmDialog  Toaster
      composer/ NewChatCharacterPicker
      sidebar/  Sidebar CharacterConversationList NewChatButton SettingsEntry
      settings/ SettingsNav SettingsContent ChatUiSettingsContent StDrawerHost
      config/   ConfigSelect PlusPinEditor
      message/  ActionButton MenuItem MessageActions MessageAvatar
                MessageEditor MessageMedia MessageReasoning
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

ChatUI owns: the sidebar navigation center, the root topbar, the visible message
list and its desktop floor navigator, message body/media/reasoning rendering,
the inline edit surface, the composer (＋menu, selector chips, attachment chips,
QR bar), the toast feedback
layer, and the ChatUI-native settings shell.

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
(`src/ui/hooks.ts` `useEscapeToStopGeneration`, `src/ui/components/Composer.tsx`).

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
ChatUI-native settings or a live ST drawer host on the right. This two-pane shell
is what ships today; `DESIGN.md` §3 now targets `Spine | Playbill | Stage`, and
that rework has not started.

Desktop long conversations now expose a left-spine user-turn navigator beside a
shared bounded reading column. One `2px` hairline represents one user message, with a
fixed `8px` gap (`85778e6` loosened it from the `6px` this section used to
report); short stacks are vertically centered and inset `16px` from the
main edge. The shared reading column is capped at `54rem`; the rail mounts only
when the resulting left gutter leaves at least `12px` after its wave, so it never
overlays prose. Hover previews that user's words plus the next character reply.
Overflow becomes a height-bounded tick window with `40px`
top/bottom safety; it follows the active turn to the bottom and uses wheel input
to browse hidden turns. While that window moves, tiny top/bottom labels expose
its first and last user-turn numbers, then fade after input stops. Touch/mobile
deliberately remains unchanged until a separate mis-touch-resistant interaction
is designed.

New-chat drafts now use per-conversation quarantine leases in localStorage instead
of `chat_metadata.chatui_isNewChat` / message-count heuristics. A leased draft is
hidden from ordinary history, highlights the ＋新对话 tab while active, is replaced only
through guarded `doNewChat`, and becomes a normal kept conversation when the user
sends, edits, swipes, generates, or otherwise mutates it. After successful
navigation, ChatUI keeps an untouched file in a persisted quarantine set instead
of releasing it into ordinary history. Navigation captures the active lease only
after older queued creation has completed, so the quick “new → old chat” path
cannot miss the concrete filename. Dormant drafts do not block another new chat
and are recoverable from 未完成草稿 cards inlined in that character's playbill
column (pr9 second baton — they were a separate cross-character shelf before,
and the container is all that changed: the lease set still decides which files
these are, and they are still never mixed into ordinary history). ST still
lacks an atomic server-side conditional DELETE, so physical deletion remains an
explicit user action rather than unsafe background GC — a draft card's 丢弃 is
that explicit action, and it goes through the same checked delete transaction
and the same confirm dialog as any other conversation. Restore first checks the raw file
list; prompt dry-runs and quiet background generation do not adopt a draft; an
uncertain rename keeps both possible filenames quarantined until raw state
settles.

Deleting a character's *last* chat (pr9 third baton, rewritten by the fourth)
also lands on a quarantined draft rather than a permanent history entry,
closing the one gap in "never leave a character selected with no conversation"
(DESIGN §3, evaluation §5 3.6). `delete-transaction.ts` already had to move the
durable chat pointer somewhere when no real chat survives to replace the
deleted one; it now reports that fabricated name back
(`fallbackChatFileName`) instead of letting it become an anonymous entry.
`sidebar-actions.ts` queues a tombstone (`deletion-finalization.ts`'s
`queueCharacterChatDraftQuarantine`, a `sessionStorage` sibling of the existing
`CHAT_DELETED` replay tombstone) right before the mandatory reload the
current-chat delete path already requires.

The next boot does *not* check whether ST has materialized that file — it
cannot. ST does so on a fire-and-forget chain APP_READY does not wait for
(`initRossMods()` at script.js:772 never awaits `RA_autoloadchat()`), so the
first version of this handoff asked the chat directory too early on every
single boot, found nothing, and destroyed the intent; measured on a real
1.18.0 host, the listing came back at t≈848ms and the file was only saved at
t≈949ms. What replaced it keeps one condition — the fabricated name is this
character's live current chat. `finalizeChatuiDraftQuarantine` arms the intent
for this page load and watches: immediately, in case ST's autoload got there
first, then on CHAT_CHANGED. A chat change that is not the fallback file leaves
the tombstone alone (its meaning is "if this name goes live, it is a draft",
and landing elsewhere is no evidence against that); an intent the page never
resolves is expired by the next boot, so nothing dangles and no wall-clock
timeout was invented. Once it fires, the file folds into the same quarantine
set `newChatuiChat()` uses — same 未完成草稿 card, same 丢弃 action, same
lease rules. The whole boot half is request-free. The decision lives in the
adapter (read-only over live identity) and the store owns the actual quarantine
write, keeping the adapter/store boundary intact. Deleting down to a
*remaining* real chat is unaffected — that path already worked and queues
nothing new.

Be precise about what that condition proves, because the two branches differ
and this document previously claimed the stronger fact for both. On the
CHAT_CHANGED branch the file really is saved already — `getChatResult()` awaits
`saveChatConditional()` before emitting, so the event cannot arrive early. The
*immediate* branch — the one a real boot actually takes, since autoload
finishes before APP_READY — reads `getCurrentChatDetails().sessionName`, which
is `characters[this_chid].chat`: the durable pointer ChatUI itself wrote before
forcing the reload. It proves identity, not a file on disk; measured on the
same host, the lease was written at t=843ms and `POST /api/chats/save` only
went out at t=985ms. Two consequences are accepted rather than overlooked: a
`saveChatConditional()` that fails outright leaves a lease pointing at a file
that never appears (recoverable through the *dormant* card — restoring checks
the raw listing and drops the lease, and discarding now reports `absent` and
drops it too; while the reader is still standing in that chat the conversation
is alive and merely unsaved, so the delete transaction withholds `absent` there
and the lease survives the next save that writes the file back), and a 丢弃
inside that ~142ms window would send DELETE before ST's CREATE, leaving the
file unleased. The window is not humanly reachable — the card must render, be
found, be clicked and its confirm accepted within a tenth of a second of the
page appearing — and closing it properly would mean waiting for a CHAT_CHANGED
that a real boot has already emitted before this code first runs, which would
strand every ordinary autoload boot instead.

ST's `power_user.auto_load_chat` is **false** by default (power-user.js:335),
and this repo's e2e fixture forces it true — which is why every earlier
real-machine result for this rule came from a non-default setting. On a stock
install the mandatory reload comes back with *no character selected at all*:
ST never loads the deleted character, never writes the fallback file, and the
credential waits for a signal that will never be sent. So when a credential is
still pending and nothing at all holds the stage,
`finalizeChatuiDraftQuarantine` selects the character that credential names.
That is the closing move of a transaction the reader committed to (they
confirmed the delete; the reload is ChatUI's own doing), not a vote on their
autoload preference — the adapter refuses the moment ST landed anywhere, group
or character (`selectCharacterIfNobodyIsOnStage`), and the credential then
keeps its ordinary meaning. It runs at most once per page load, is never
retried, and never toasts.

The character a delete like that empties is also on the spine now, which is
what makes any of it reachable by hand at all. The spine's membership rule
(`ui/spine-cast.ts`) used to be
「`chat_size > 0`」 alone, and `chat_size` is a per-boot disk snapshot that is
never refreshed inside the page — so the character you were standing on
vanished from the only rail that can change character. Membership is now the
union of four sources: conversations on disk, on stage now, holding a
quarantine lease, or named by a pending draft-quarantine credential. The
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

- abandoned temp state is a per-conversation quarantine set, not one replaceable
  pointer. Queued navigation captures after prior creation commits, local
  draft/send/attachment work adopts before ST resets UI state, and stale departure
  can deactivate only its exact active generation. Per-pointer localStorage keys
  plus `storage` synchronization prevent different tabs from overwriting unrelated
  quarantines;
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
  covers update/delete/swipe. The extracted bounded coordinator marks an active
  query dirty and requeues exactly one follow-up; inactive first-prefetch work
  awaits the old promise then calls `query.fetch()` directly;
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
