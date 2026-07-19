/**
 * SillyTavern-ChatUI · message adapter
 */

import {
    deleteMessage as stDeleteMessage,
    eventSource,
    event_types,
    isGenerating,
    messageEdit,
    saveChatConditional,
    swipe as stSwipe,
    syncSwipeToMes,
} from '@st/script';
import { copyText } from '@st/utils';
import { branchChat, createNewBookmark } from '@st/bookmarks';
import { hideChatMessage, unhideChatMessage } from '@st/chats';
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
export type MessageAction = 'copy' | 'regen' | 'edit' | 'branch' | 'checkpoint' | 'hide' | 'delete';
export type SwipeDirection = 'left' | 'right';

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
 * Full-message delete stays DOM-gated: DOM-DECOUPLING.md scopes the DOM-free
 * dispatch to delete(仅 swipe) alone (Tier 1) — delete(整条) is Tier 2's thin
 * fork, not yet built. ST's own deleteMessage() still gates the *entire*
 * function, including its own confirm popup, on a live `.mes` node
 * (script.js:1632-1636, `messageElement.length === 0` -> silent `return`);
 * until Tier 2 removes that dependency, an unrendered target must fail
 * loudly here instead of silently no-op-ing through ST's own gate.
 */
async function _deleteFullMessageById(mesId: number, confirm: boolean): Promise<void> {
    const mesEl = getMessageElementById(mesId);
    if (!mesEl) {
        throw new Error(
            `[ChatUI/adapter] Message element not found for delete: ${mesId} `
            + '(full-message delete stays DOM-gated until DOM-DECOUPLING.md Tier 2 lands)',
        );
    }
    await stDeleteMessage(mesId, undefined, confirm);
}

type StPopupContext = {
    callGenericPopup: (
        content: unknown,
        type: unknown,
        inputValue: unknown,
        options: { okButton?: unknown; cancelButton?: unknown; customButtons?: unknown[] | null },
    ) => Promise<unknown>;
    POPUP_TYPE: { CONFIRM: unknown };
    POPUP_RESULT: { AFFIRMATIVE: unknown };
    t: (strings: TemplateStringsArray, ...values: unknown[]) => string;
};

/**
 * Restores the confirmation step ST's own deleteMessage() always showed
 * before this branch started calling the swipe-only mini-fork directly
 * (script.js:1638-1647's askConfirmation branch, canDeleteSwipe === true
 * case). deleteMessage() below no longer routes through ST's deleteMessage()
 * wrapper for this sub-case, so it must reproduce that same popup itself or
 * silently defeat the user's confirm_message_delete preference
 * (DOM-DECOUPLING.md decision #3: "不静默绕过用户偏好").
 *
 * getContext() already re-exports callGenericPopup/POPUP_TYPE/POPUP_RESULT/t
 * (public/scripts/st-context.js, all confirmed present in the pinned
 * checkout) through the already-mapped @st/st-context module — no new
 * @st/* module target is needed for this.
 *
 * Mirrors ST's wording/behavior exactly: Cancel (or Escape) aborts with no
 * mutation; the default "Delete Swipe" button proceeds with the swipe-only
 * delete; the "Delete Message" custom button escalates to a full message
 * delete (still DOM-gated — see _deleteFullMessageById above).
 */
async function _confirmSwipeOnlyDelete(): Promise<'swipe' | 'message' | 'cancelled'> {
    const ctx = getContext() as StPopupContext;
    const { t, callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx;
    const result = await callGenericPopup(
        t`Are you sure you want to delete this message?`,
        POPUP_TYPE.CONFIRM,
        null,
        {
            okButton: t`Delete Swipe`,
            cancelButton: 'Cancel',
            customButtons: [t`Delete Message`],
        },
    );
    if (!result) return 'cancelled';
    return result === POPUP_RESULT.AFFIRMATIVE ? 'swipe' : 'message';
}

export async function deleteMessage(mesId: MessageId): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for delete: ${mesId}`);
    }

    // Mirror ST's .mes_edit_delete handler policy exactly so we keep native
    // semantics: honour the user's confirm-before-delete preference, and when
    // removing the last message that has multiple swipes, drop only the
    // selected swipe rather than the whole message. (fromSlashCommand is
    // always false from the ChatUI surface.) See ST script.js:11922-11928's
    // .mes_edit_delete handler — note canDeleteSwipe itself requires
    // confirm_message_delete, so `confirm` is always true whenever this
    // branch is taken (the popup below is never skipped for it).
    const message = parseMessageRecord(getMessageById(normalizedId));
    if (!message) {
        throw new Error(`[ChatUI/adapter] Message record not found for delete: ${normalizedId}`);
    }
    const confirm = !!(getContext() as DeleteSettingsContext).powerUserSettings?.confirm_message_delete;
    const swipes = message.swipes;
    const selectedSwipe = message.swipe_id;
    const isLast = normalizedId === arrayLength(getCurrentChat()) - 1;
    const canDeleteSwipe = confirm
        && !message.is_user
        && swipes.length > 1
        && isLast
        && selectedSwipe !== undefined;

    if (canDeleteSwipe) {
        const choice = await _confirmSwipeOnlyDelete();
        if (choice === 'cancelled') return;
        if (choice === 'message') {
            // User escalated from "Delete Swipe" to "Delete Message" in the
            // popup ST itself offers here — already confirmed, so no second
            // popup; still routes through the DOM-gated full-delete path.
            await _deleteFullMessageById(normalizedId, false);
            return;
        }
        await _deleteSwipeById(normalizedId, selectedSwipe);
        return;
    }

    await _deleteFullMessageById(normalizedId, confirm);
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
 * DOM-DECOUPLING.md Tier 1: copy / branch / checkpoint / hide / delete(仅
 * swipe) never require a live `.mes` node — the blanket getMessageElementById
 * gate that used to guard every action here is gone for exactly those. The
 * one exception living inside 'delete' is its full-message sub-case, which
 * still requires a live element — but that gate is applied explicitly
 * *inside* deleteMessage() -> _deleteFullMessageById(), not here, because
 * only deleteMessage() (after reading the message record) can tell which of
 * the two sub-cases applies; this dispatcher can't distinguish them ahead of
 * time. `edit` and `regen` still resolve and require the live element
 * explicitly right here (edit clicks `.mes_edit`; regen is unaffected by the
 * id but keeps its historical DOM precondition unchanged this tier) — see
 * DOM-DECOUPLING.md §「推进顺序」Tier 1/2/3 for what stays DOM-gated and why.
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
        case 'delete':     await deleteMessage(normalizedId);     return;
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
