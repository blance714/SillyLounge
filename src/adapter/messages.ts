/**
 * SillyTavern-ChatUI · message adapter
 */

import {
    eventSource,
    event_types,
    isGenerating,
    messageEdit,
    refreshSwipeButtons,
    saveChatConditional,
    saveChatDebounced,
    setEditedMessageId,
    swipe as stSwipe,
    syncSwipeToMes,
    updateEditArrowClasses,
} from '@st/script';
import { copyText } from '@st/utils';
import { branchChat, createNewBookmark } from '@st/bookmarks';
import { hideChatMessage, unhideChatMessage } from '@st/chats';
import { deleteItemizedPromptForMessage } from '@st/itemized-prompts';
import {
    _dispatchClick,
    _dispatchClickAndWait,
    _getJQueryMessage,
    _getMessageId,
    getContext,
    getCurrentChat,
    getMessageByElement,
    getMessageById,
    getMessageElementById,
} from './internals.js';
import { parseMessageRecord } from './schema.js';

type MessageId = number | string;
export type MessageAction = 'copy' | 'regen' | 'edit' | 'branch' | 'checkpoint' | 'hide';
export type SwipeDirection = 'left' | 'right';
export type DeleteIntent = 'swipe' | 'message';

type DeleteSettingsContext = {
    powerUserSettings?: {
        confirm_message_delete?: unknown;
    };
};

function arrayLength(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

export function getSwipeLabel(mesEl: Element): string {
    const msg = parseMessageRecord(getMessageByElement(mesEl));
    if (!msg || msg.swipes.length <= 1) return '';
    const idx = msg.swipe_id ?? 0;
    return `${idx + 1}​/​${msg.swipes.length}`;
}

/**
 * @param {HTMLElement} item
 * @param {{ isSystem?: boolean, mediaDisplay?: string }} messageMeta
 * @returns {boolean}
 */
export function isOverflowActionVisible(
    item: HTMLElement,
    messageMeta: { isSystem?: boolean; mediaDisplay?: string } = {},
) {
    const { isSystem = false, mediaDisplay = '' } = messageMeta;

    if (item.classList.contains('displayNone')) return false;
    if (item.style.display === 'none') return false;
    if (item.classList.contains('mes_copy')) return false;

    const explicitlyShown = item.style.display && item.style.display !== 'none';
    if (explicitlyShown) return true;

    if (item.matches('.mes_translate, .sd_message_gen, .mes_narrate')) return false;
    if (item.classList.contains('mes_prompt')) return false;
    if (item.classList.contains('mes_swipe_picker')) return false;
    if (item.classList.contains('mes_hide') && isSystem) return false;
    if (item.classList.contains('mes_unhide') && !isSystem) return false;
    if (item.classList.contains('mes_media_gallery') && mediaDisplay !== 'gallery') return false;
    if (item.classList.contains('mes_media_list') && mediaDisplay !== 'list') return false;

    return true;
}

export function triggerOverflowAction(original: Element): void {
    _dispatchClick(original);
}

export async function copyMessage(mesId: MessageId): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for copy: ${mesId}`);
    }
    // getMessageById + copyText is a DOM-free read (utils.js:546's clipboard API
    // main path never touches `.mes`) — Tier 1 of DOM-DECOUPLING.md.
    const rawMessage = getMessageById(normalizedId);
    if (
        !rawMessage
        || typeof rawMessage !== 'object'
        || Array.isArray(rawMessage)
        || typeof (rawMessage as Record<string, unknown>).mes !== 'string'
    ) {
        throw new Error(`[ChatUI/adapter] Message record not found for copy: ${normalizedId}`);
    }
    await copyText((rawMessage as Record<string, string>).mes);
}

/**
 * @returns {void}
 */
export function regenerateMessage() {
    if (isGenerating()) throw new Error('[ChatUI/adapter] Generation is already active');
    const button = document.getElementById('option_regenerate');
    if (!button) throw new Error('[ChatUI/adapter] Regenerate action not found');
    button.click();
}

/**
 * @returns {void}
 */
export function regenerateLast() {
    regenerateMessage();
}

export function editMessage(mesEl: Element): void {
    const $mes = _getJQueryMessage(mesEl);
    if ($mes) {
        $mes.find('.mes_edit').trigger('click');
        return;
    }
    const edit = mesEl.querySelector('.mes_edit');
    if (edit) _dispatchClick(edit);
}

/**
 * Shadow of ST's module-private `this_edit_mes_id` (script.js:610). script.js
 * exports only a setter for it (`setEditedMessageId`, script.js:7101) — there
 * is no exported getter anywhere in the pinned checkout (grepped). The
 * full-message delete fork below (`_deleteFullMessageById`) needs to
 * reproduce native `deleteMessage()`'s own `if (this_edit_mes_id === id)`
 * conditional reset (script.js:1663-1665) without being able to read the
 * real value, so this module tracks its own shadow instead.
 *
 * This is exact, not a heuristic, for every path reachable through ChatUI:
 * ChatUI's own edit UI (ui/components/message/MessageEditor.tsx) never opens
 * ST's native editor until the moment it *saves* — entering "edit mode" is
 * purely local Preact state (app.tsx's `editingMessage`) that never touches
 * this_edit_mes_id. saveMessageEditById() below is the only ChatUI path that
 * ever sets the real this_edit_mes_id (via messageEdit()) or clears it (via
 * the completed `.mes_edit_done` click, which runs ST's own
 * messageEditDone() and resets it internally as its last step,
 * script.js:8372) — and every ChatUI-triggered save/delete funnels through
 * the single serialized host-operation queue (store/host-operation-queue.ts),
 * so a save and a delete can never interleave. That leaves exactly one gap:
 * if saveMessageEditById() throws between messageEdit() (which already set
 * this_edit_mes_id) and the completed done-click (element/button missing,
 * dispatch rejects/times out), the shadow is deliberately left dangling at
 * normalizedId — exactly mirroring how the real this_edit_mes_id would also
 * stay dangling in that same failure. The one thing this cannot see is
 * direct interaction with ST's *native* DOM bypassing ChatUI's shield
 * (src/shield/st-dom-shield.ts); see DOM-DECOUPLING.md/INVARIANTS.md §15 for
 * that documented, bounded gap.
 */
let _shadowEditedMessageId: number | undefined;

/** Test-only: seed the this_edit_mes_id shadow without driving a real edit
 * flow (saveMessageEditById needs a live `#chat .mes[mesid=X]` compound
 * selector the unit-test fake DOM deliberately doesn't support — see
 * test/helpers/fake-st-host.mjs's module doc comment). Pass undefined to
 * clear it. */
export function __setShadowEditedMessageIdForTesting(value: number | undefined): void {
    _shadowEditedMessageId = value;
}

/**
 * Saves a ChatUI-owned edit through SillyTavern's native editor pipeline.
 * This preserves ST's regex, macro, bias, swipe, save, and message update logic
 * while keeping the visible edit surface owned by ChatUI.
 *
 * @param {number|string} mesId
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function saveMessageEditById(mesId: MessageId, text: string): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isFinite(normalizedId)) {
        throw new Error(`[ChatUI/adapter] Invalid message id for edit: ${mesId}`);
    }

    const mesEl = getMessageElementById(normalizedId);
    if (!mesEl) {
        throw new Error(`[ChatUI/adapter] Message element not found for edit: ${normalizedId}`);
    }

    await messageEdit(normalizedId);
    // messageEdit() sets the real this_edit_mes_id synchronously, before any
    // await inside it (verified against the pinned checkout) — mirrored here
    // the moment our own await returns.
    _shadowEditedMessageId = normalizedId;

    const textarea = mesEl.querySelector('.edit_textarea') as HTMLTextAreaElement | null;
    if (!textarea) {
        throw new Error(`[ChatUI/adapter] Native edit textarea not found for message: ${normalizedId}`);
    }

    textarea.value = text;

    const done = mesEl.querySelector('.mes_edit_done');
    if (!done) {
        throw new Error(`[ChatUI/adapter] Native edit done button not found for message: ${normalizedId}`);
    }

    // ST emits MESSAGE_UPDATED before its async save finishes. Await the actual
    // delegated jQuery handler promise so the shared host-operation lane stays
    // occupied through both the in-memory update and durable save.
    await _dispatchClickAndWait(done as HTMLElement);
    // The completed click ran ST's own messageEditDone() to completion, which
    // resets the real this_edit_mes_id as its last step — mirrored here.
    _shadowEditedMessageId = undefined;
}

export async function createBranch(mesId: MessageId): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for branch: ${mesId}`);
    }
    // branchChat() never queries `.mes` (bookmarks.js:449) — Tier 1 direct id
    // call; the chat-switch navigation side effect is intentional.
    await branchChat(normalizedId);
}

export async function createCheckpoint(mesId: MessageId): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for checkpoint: ${mesId}`);
    }
    // createNewBookmark()'s only DOM touch is a decorative ribbon-tag update
    // guarded by an empty jQuery selection when unrendered — safe no-op
    // (bookmarks.js:292-310). Tier 1 direct id call.
    await createNewBookmark(normalizedId);
}

export async function toggleHideMessage(mesId: MessageId): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for hide: ${mesId}`);
    }
    const msg = parseMessageRecord(getMessageById(normalizedId));
    if (!msg) {
        throw new Error(`[ChatUI/adapter] Message record not found for hide: ${normalizedId}`);
    }
    // Source of truth is the message flag (is_system), not native button
    // visibility — reading the DOM could pick the wrong direction.
    const action = msg.is_system === true ? unhideChatMessage(normalizedId) : hideChatMessage(normalizedId);
    await action;
}

type SwipeArrayMessage = {
    swipes?: unknown;
    swipe_info?: unknown;
    swipe_id?: unknown;
};

/**
 * Deletes exactly one swipe candidate as a self-contained mini-fork of ST's
 * exported deleteSwipe() (script.js:9279-9346) — reimplemented directly
 * against the live `chat[]` entry instead of calling ST's own function at
 * all. This mirrors how DOM-DECOUPLING.md already plans Tier 2's delete
 * (整条) fork; this graduates delete(仅 swipe) from a direct call into a
 * mini-fork with the same contract-test obligation (see the dedicated
 * `_deleteSwipeById` tests in test/messages.test.mjs).
 *
 * Why a mini-fork instead of calling ST's deleteSwipe(): when the deleted
 * swipe is the message's *active* swipe, ST's own deleteSwipe() tries to
 * resync `mes` by calling its exported swipe() internally (script.js:9333,
 * `source: SWIPE_SOURCE.DELETE`). swipe() sets the module-global
 * `swipeState = SWIPE_STATE.SWIPING` (script.js:9935) *before* its own DOM
 * gate (`![thisMesDiv.length, thisMesText.length].every(...)`,
 * script.js:9942) bails out on an unrendered message — and that gate
 * `return`s before ever reaching the `swipeState = SWIPE_STATE.NONE` reset
 * inside endSwipe() (script.js:10039). `swipeState` is a bare `export let`
 * (script.js:415) with no exported setter anywhere in script.js (verified by
 * grepping every `SWIPE_STATE` assignment in the pinned checkout) — once
 * stuck at SWIPING there is no way to reset it from outside short of a page
 * reload, and a stuck SWIPING state silently disables every future swipe
 * (isSwipingAllowed(), script.js:9111) *and* every future send
 * (sendTextareaMessage(), script.js:1711) app-wide. Since deleteMessage()
 * below always selects the message's *current* swipe_id for deletion, this
 * is always the active-swipe branch on every real call — routing through
 * deleteSwipe() at all would make the corruption reachable on every single
 * swipe-only delete of an unrendered message, not just an edge case. So this
 * function never calls ST's deleteSwipe() or swipe(): it reimplements
 * deleteSwipe()'s pure body directly (splice swipes/swipe_info, reassign
 * swipe_id, mark chat_metadata.tainted, emit MESSAGE_SWIPE_DELETED with the
 * exact payload shape ST uses, then syncSwipeToMes()/saveChatConditional() —
 * both verified DOM-free, script.js:6895 and script.js:9352).
 *
 * Exercised under truncation=0 and truncation=1 alike: this eligibility
 * policy only ever fires on the chat's last message (isLast required, see
 * deleteMessage() below), and native truncation=1 keeps exactly that message
 * rendered — so in practice this corruption path was already unreachable
 * under truncation=1 even before this fix (the DOM gate ST's swipe() checks
 * would have passed). It is truncation=0 (today's default; no code path in
 * this repo implements chat_truncation yet — see DOM-DECOUPLING.md "停用恢复
 * 机制") and any future state where the last message hasn't mounted yet
 * (e.g. a fresh chat load, a virtualization edge) that this fix actually
 * protects against. Bypassing deleteSwipe() entirely removes the dependency
 * on that DOM timing altogether, rather than relying on truncation mode to
 * keep it out of reach.
 */
export async function _deleteSwipeById(mesId: number, swipeId: number): Promise<void> {
    const rawMessage = getMessageById(mesId) as SwipeArrayMessage | null;
    const swipes = rawMessage && Array.isArray(rawMessage.swipes) ? (rawMessage.swipes as unknown[]) : null;
    if (!rawMessage || !swipes || swipes.length === 0) {
        throw new Error(`[ChatUI/adapter] No swipes to delete for message: ${mesId}`);
    }
    if (swipes.length <= 1) {
        throw new Error(`[ChatUI/adapter] Cannot delete the last swipe for message: ${mesId}`);
    }

    const normalizedSwipeId = Number(swipeId);
    if (!Number.isInteger(normalizedSwipeId) || normalizedSwipeId < 0 || normalizedSwipeId >= swipes.length) {
        throw new Error(`[ChatUI/adapter] Invalid swipe id ${swipeId} for message: ${mesId}`);
    }

    const currentSwipeId = Math.min(Math.max(Number(rawMessage.swipe_id ?? 0), 0), swipes.length - 1);

    swipes.splice(normalizedSwipeId, 1);
    const swipeInfo = rawMessage.swipe_info;
    if (Array.isArray(swipeInfo) && swipeInfo.length) {
        (swipeInfo as unknown[]).splice(normalizedSwipeId, 1);
    }

    let newSwipeId: number;
    if (normalizedSwipeId < currentSwipeId) {
        newSwipeId = currentSwipeId - 1;
    } else if (normalizedSwipeId > currentSwipeId) {
        newSwipeId = currentSwipeId;
    } else {
        // Select the next swipe, or the one before it if it was the last one.
        newSwipeId = Math.min(normalizedSwipeId, swipes.length - 1);
    }

    const ctx = getContext() as { chatMetadata?: { tainted?: boolean } };
    if (ctx.chatMetadata) ctx.chatMetadata.tainted = true;

    rawMessage.swipe_id = newSwipeId;

    await eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, {
        messageId: mesId,
        swipeId: normalizedSwipeId,
        newSwipeId,
    });

    if (normalizedSwipeId === currentSwipeId) {
        // The active swipe was removed — resync `mes` to the newly active
        // swipe's text ourselves. This is the exact job ST's own swipe()
        // would do via its own internal syncSwipeToMes() call, reached here
        // without ever entering swipe(): no DOM gate to bail on, no
        // swipeState to touch, let alone leave stuck.
        syncSwipeToMes(mesId);
    }

    await saveChatConditional();
}

/**
 * Depth-first search for the first descendant carrying `className`, walking
 * `.children` only (never a CSS selector engine). Used instead of
 * `element.querySelector('.mesIDDisplay')` because ST's `.mesIDDisplay` node
 * is nested two levels below `.mes` (`.mes > .mesAvatarWrapper >
 * .mesIDDisplay`, public/index.html's `#message_template`) and the unit-test
 * fake DOM (test/helpers/fake-st-host.mjs) only resolves `#id` through
 * `querySelector`/`querySelectorAll` — a plain tree walk works identically
 * against a real browser DOM and the fake one, so the renumber rule below can
 * be pinned by a real unit test instead of only by a browser repro.
 */
function _findDescendantByClass(root: Element, className: string): HTMLElement | null {
    for (const child of Array.from(root.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.classList.contains(className)) return child;
        const nested = _findDescendantByClass(child, className);
        if (nested) return nested;
    }
    return null;
}

/**
 * Owns the post-delete renumber outright instead of delegating to native
 * `updateViewMessageIds` (script.js:9407-9419). That function's `null`
 * startIndex branch falls back to `minId = getFirstDisplayedMessageId()`,
 * which re-scans the *current* DOM for its own minimum rendered `mesid`. Its
 * correctness silently assumes native `deleteMessage()`'s own precondition:
 * the deleted row's own `.mes` element was in the DOM and has *just* been
 * physically `.remove()`d (script.js:1633-1636 gates on exactly that before
 * ever reaching this code). Tier 2 deliberately breaks that precondition —
 * chat_truncation=1 means most deletions target a message whose row was
 * never rendered in the first place — so when `deletedId` itself was never
 * rendered while later rows are, nothing was removed from the DOM, the
 * re-scanned minimum is bytewise identical to before, and native's
 * recomputation becomes a silent no-op: every still-rendered row keeps the
 * `mesid` it already had, even though `chat.splice(deletedId, 1)` just
 * shifted every later index down by one. Empirically proved (real jQuery +
 * DOM, verbatim native `updateViewMessageIds`/`getFirstDisplayedMessageId`
 * bodies) by this fork's own review round in a scratch repro (not checked
 * into this repo — see the review notes for that round): deleted-unrendered
 * + later-rendered ("edit message 7" after deleting id 5 silently mutates
 * chat[7], which now holds former message 8's content), and
 * chat_truncation=1 (deleting an earlier unrendered id leaves the sole
 * rendered row's `mesid` pointing at an out-of-bounds `chat[]` slot). A
 * follow-up repro extended both cases with a side-by-side comparison against
 * *this* function's own rule for every configuration in this fork's test
 * matrix below.
 *
 * The correct rule is old-`mesid`-based, not DOM-position-based, and is
 * correct by construction for every rendered/unrendered combination because
 * it never re-derives a baseline from the DOM at all — it only compares each
 * currently-rendered row's own (still-stale) `mesid` attribute against the id
 * that was just spliced out of `chat[]`:
 *
 *   - a row whose `mesid` === `deletedId` no longer exists by the time this
 *     runs — its element was already `.remove()`d by the caller (mirroring
 *     native's `messageElement.remove()`, script.js:1654) if it was rendered
 *     at all;
 *   - a row with `mesid` > `deletedId` gets its `mesid` decremented by
 *     exactly one, because `chat.splice(deletedId, 1)` shifted that row's
 *     underlying chat[] entry down one slot too;
 *   - a row with `mesid` < `deletedId` is left untouched — its chat[] index
 *     never moved.
 *
 * Also reproduces every other per-row observable effect native
 * `updateViewMessageIds` produces on the same row set, in the same order:
 * the `.mesIDDisplay` text mirror, the `last_mes` class handoff to whichever
 * row is now last in DOM order, and a call to native `updateEditArrowClasses`
 * (script.js:9427) — delegated to native unmodified. That delegation is
 * provably safe, unlike `updateViewMessageIds`'s: `updateEditArrowClasses`
 * never re-derives an offset baseline from the DOM, it only compares the
 * *real* native `this_edit_mes_id` (kept in sync via `setEditedMessageId()`
 * below, a genuine write to that module-private variable, not just this
 * fork's own `_shadowEditedMessageId` mirror) against whatever `mesid`
 * attributes are on the row set *right now* — which, by the time this call
 * happens, this function has already made correct.
 *
 * `.mes` rows are always direct children of `#chat` (native only ever
 * `.append()`/`.prepend()`s them straight onto `chatElement = $('#chat')` —
 * script.js:1457/1481/1520/2530), so this walks `#chat`'s `.children`
 * directly rather than the compound CSS selector `getMessageElementById`
 * uses elsewhere in this file — the fake DOM used by this repo's unit-test
 * harness doesn't resolve compound selectors, but does support
 * getElementById/children/classList/attribute reads and writes, which is
 * exactly what this needs.
 */
function _renumberRenderedRowsAfterDelete(deletedId: number): void {
    const chatContainer = document.getElementById('chat');
    const rows = chatContainer
        ? Array.from(chatContainer.children).filter(
            (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('mes'),
        )
        : [];

    for (const row of rows) {
        const oldMesid = Number(row.getAttribute('mesid'));
        if (!Number.isFinite(oldMesid) || oldMesid <= deletedId) continue;
        const newMesid = oldMesid - 1;
        row.setAttribute('mesid', String(newMesid));
        const display = _findDescendantByClass(row, 'mesIDDisplay');
        if (display) display.textContent = `#${newMesid}`;
    }

    for (const row of rows) row.classList.remove('last_mes');
    rows[rows.length - 1]?.classList.add('last_mes');

    // Native always calls this at the end of updateViewMessageIds, even over
    // zero `.mes` rows (its own jQuery selections just degrade to no-ops) —
    // matched here unconditionally for the same reason.
    updateEditArrowClasses();
}

/**
 * Full-message delete thin fork of ST's own deleteMessage() (script.js:1618-
 * 1673, the body *after* its own DOM gate) — reimplemented directly against
 * the live host state instead of ever calling ST's exported deleteMessage()
 * at all. DOM-DECOUPLING.md Tier 2. Deliberately DOM-*tolerant*, not
 * DOM-gated like Tier 1's interim version: chat_truncation=1 only keeps the
 * chat's last message rendered, so an unrendered target (any non-last
 * message once that truncation is active, or any message before the native
 * window has ever mounted) must still delete correctly, not throw.
 *
 * Reproduces every observable side effect of the native post-gate body, in
 * the exact same order:
 *
 *  1. Look up `#chat .mes[mesid=id]`, if any (native's `messageElement`,
 *     captured before its own DOM gate, script.js:1632) — zero matches is
 *     fine here (unlike native, which gates on it); one match gets removed
 *     below.
 *  2. `chat.splice(id, 1)` against the live getContext().chat reference
 *     (script.js:1653) — same live-reference assumption Tier 1's
 *     _deleteSwipeById already relies on for its own splice.
 *  3. Remove the captured element, if it existed (script.js:1654).
 *  4. `chat_metadata.tainted = true` (script.js:1656).
 *  5. `deleteItemizedPromptForMessage(id)` (script.js:1659) — new @st/*
 *     mapping (public/scripts/itemized-prompts.js, the same up-3 pattern as
 *     @st/utils; see scripts/build.mjs/check-runtime.mjs/st-externals.d.ts/
 *     test/helpers/fake-st-host.mjs). DOM-free pure array filter+reindex,
 *     verified against the pinned checkout — not reachable via getContext()
 *     or any already-mapped @st/* module.
 *  6. `_renumberRenderedRowsAfterDelete(id)` in place of native
 *     `updateViewMessageIds(startIndex)` (script.js:1660-1661) — see that
 *     function's own doc comment for why this fork owns the renumber outright
 *     instead of delegating to native's DOM-self-recomputing version.
 *  7. `saveChatDebounced()` (script.js:1661) — note this is the *debounced*
 *     save, not saveChatConditional(): native's own deleteMessage() uses this
 *     one specifically. (_deleteSwipeById's mini-fork above correctly uses
 *     the *conditional* save instead, matching deleteSwipe()'s own choice —
 *     these are deliberately different saves for deliberately different ST
 *     functions.)
 *  8. this_edit_mes_id reset (script.js:1663-1665) via the exported
 *     setEditedMessageId() (script.js:7101) — see _shadowEditedMessageId's
 *     doc comment above saveMessageEditById for how this fork reproduces the
 *     exact `this_edit_mes_id === id` conditional without read access to the
 *     real (module-private, getter-less) variable.
 *  9. `refreshSwipeButtons()` (script.js:1667) — DOM-tolerant (bails out on
 *     an empty chat; its own internal jQuery selection degrades to zero
 *     iterations when nothing is rendered, verified against the pinned
 *     checkout).
 * 10. `eventSource.emit(MESSAGE_DELETED, chat.length)` (script.js:1669) —
 *     `chat.length` read *after* the splice, matching native exactly.
 */
async function _deleteFullMessageById(id: number): Promise<void> {
    const mesEl = getMessageElementById(id);

    const chat = getCurrentChat();
    chat.splice(id, 1);
    mesEl?.remove();

    const ctx = getContext() as { chatMetadata?: { tainted?: boolean } };
    if (ctx.chatMetadata) ctx.chatMetadata.tainted = true;

    deleteItemizedPromptForMessage(id);
    _renumberRenderedRowsAfterDelete(id);
    saveChatDebounced();

    if (_shadowEditedMessageId === id) {
        setEditedMessageId(undefined);
        _shadowEditedMessageId = undefined;
    }

    refreshSwipeButtons();

    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
}

export type DeleteEligibility = Readonly<{
    /** True exactly when ST's own `.mes_edit_delete` handler's structural
     * eligibility check would allow a swipe-only delete (script.js:11922-
     * 11928) — everything *except* the confirm_message_delete gate, which is
     * the caller's job to combine with the user's actual dialog choice (see
     * getConfirmMessageDeleteSetting below and store/chat-actions.ts). */
    canDeleteSwipe: boolean;
    /** The message's currently-selected swipe id, present only when
     * canDeleteSwipe is true. */
    swipeId: number | undefined;
}>;

/**
 * Structural delete eligibility for one message: is it a non-user message
 * with more than one swipe, is it the chat's last message, and does it have
 * a selected swipe. Mirrors ST's own `.mes_edit_delete` handler
 * (script.js:11922-11928) minus the confirm_message_delete gate — the
 * adapter must never assume whether the user wants to be asked; that is
 * store/chat-actions.ts's job, reading getConfirmMessageDeleteSetting()
 * separately and deciding the three-way-vs-two-way confirm UI from both
 * pieces together.
 */
export function getDeleteEligibility(mesId: MessageId): DeleteEligibility {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for delete: ${mesId}`);
    }
    const message = parseMessageRecord(getMessageById(normalizedId));
    if (!message) {
        throw new Error(`[ChatUI/adapter] Message record not found for delete: ${normalizedId}`);
    }
    const isLast = normalizedId === arrayLength(getCurrentChat()) - 1;
    const canDeleteSwipe = !message.is_user
        && message.swipes.length > 1
        && isLast
        && message.swipe_id !== undefined;
    return { canDeleteSwipe, swipeId: canDeleteSwipe ? message.swipe_id : undefined };
}

/**
 * Read-only view of `power_user.confirm_message_delete`, coerced to a strict
 * boolean (never forwarded as whatever raw settings value ST happens to
 * store). The adapter never decides UI from this itself — it only reports
 * it; store/chat-actions.ts is the sole reader (DOM-DECOUPLING.md decision
 * #3's Tier 2 resolution: orchestration lives in the store, the adapter
 * never shows UI).
 */
export function getConfirmMessageDeleteSetting(): boolean {
    return !!(getContext() as DeleteSettingsContext).powerUserSettings?.confirm_message_delete;
}

/**
 * Intent-explicit delete execution: the caller (store/chat-actions.ts) has
 * already decided — from getDeleteEligibility() + getConfirmMessageDeleteSetting()
 * plus, when applicable, the user's own confirm-dialog choice — exactly which
 * mutation to perform. This function never reads settings, never shows any
 * UI, and never asks anything; it only executes. `swipeId` is required (and
 * revalidated by _deleteSwipeById's own guards, protecting against staleness
 * between when eligibility was read and when the user actually confirmed)
 * when intent === 'swipe'.
 */
export async function deleteMessageWithIntent(
    mesId: MessageId,
    intent: DeleteIntent,
    swipeId?: number,
): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for delete: ${mesId}`);
    }
    if (intent === 'swipe') {
        if (swipeId === undefined) {
            throw new Error(`[ChatUI/adapter] Swipe id required for swipe-only delete: ${normalizedId}`);
        }
        await _deleteSwipeById(normalizedId, swipeId);
        return;
    }
    await _deleteFullMessageById(normalizedId);
}

export async function swipeMessage(mesEl: Element, direction: SwipeDirection): Promise<void> {
    const mesId = _getMessageId(mesEl);
    if (!Number.isInteger(mesId) || mesId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for swipe: ${mesId}`);
    }
    const rawMessage = getMessageById(mesId);
    if (!parseMessageRecord(rawMessage)) {
        throw new Error(`[ChatUI/adapter] Message record not found for swipe: ${mesId}`);
    }
    // Call ST's exported swipe() with forceMesId (it tolerates a null event when
    // forceMesId is a number) instead of clicking the off-screen .swipe_left /
    // .swipe_right buttons. direction 'left'|'right' matches ST's SWIPE_DIRECTION.
    await stSwipe(null, direction, { forceMesId: mesId, message: rawMessage });
}

/**
 * DOM-DECOUPLING.md: copy / branch / checkpoint / hide never require a live
 * `.mes` node (Tier 1) — the blanket getMessageElementById gate that used to
 * guard every action here is gone for exactly those. `delete` is no longer
 * dispatched through this generic entry point at all as of Tier 2: it needs
 * to read confirm_message_delete and (conditionally) await a ChatUI-owned
 * confirm dialog *before* deciding which mutation to run, which this
 * dispatcher's synchronous-switch shape can't accommodate — see
 * store/chat-actions.ts's dedicated delete orchestration, which calls
 * getDeleteEligibility() / getConfirmMessageDeleteSetting() /
 * deleteMessageWithIntent() directly instead. `edit` and `regen` still
 * resolve and require the live element explicitly right here (edit clicks
 * `.mes_edit`; regen is unaffected by the id but keeps its historical DOM
 * precondition unchanged this tier) — see DOM-DECOUPLING.md §「推进顺序」for
 * what stays DOM-gated and why.
 */
export async function triggerMessageActionById(mesId: MessageId, action: MessageAction): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for ${action}: ${mesId}`);
    }

    switch (action) {
        case 'copy':       await copyMessage(normalizedId);       return;
        case 'branch':     await createBranch(normalizedId);      return;
        case 'checkpoint': await createCheckpoint(normalizedId);  return;
        case 'hide':       await toggleHideMessage(normalizedId); return;
        case 'regen':
        case 'edit': {
            const mesEl = getMessageElementById(normalizedId);
            if (!mesEl) {
                throw new Error(`[ChatUI/adapter] Message element not found for ${action}: ${normalizedId}`);
            }
            if (action === 'regen') regenerateMessage();
            else editMessage(mesEl);
            return;
        }
        default:
            return;
    }
}

export async function swipeMessageById(mesId: MessageId, direction: SwipeDirection): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for swipe: ${mesId}`);
    }
    const mesEl = getMessageElementById(normalizedId);
    if (!mesEl) {
        throw new Error(`[ChatUI/adapter] Message element not found for swipe: ${normalizedId}`);
    }
    await swipeMessage(mesEl, direction);
}
