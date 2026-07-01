/**
 * SillyTavern-ChatUI · message adapter
 */

import { deleteMessage as stDeleteMessage, isGenerating, messageEdit, swipe as stSwipe } from '@st/script';
import { copyText } from '@st/utils';
import { branchChat, createNewBookmark } from '@st/bookmarks';
import { hideChatMessage, unhideChatMessage } from '@st/chats';
import {
    _dispatchClick,
    _getJQueryMessage,
    _getMessageId,
    _waitForEvent,
    getContext,
    getCurrentChat,
    getMessageByElement,
    getMessageById,
    getMessageElementById,
    stEventKeys,
} from './internals.js';

/**
 * @param {Element} mesEl
 * @returns {string}
 */
export function getSwipeLabel(mesEl: any) {
    const msg = getMessageByElement(mesEl);
    if (!msg || !Array.isArray(msg.swipes) || msg.swipes.length <= 1) return '';
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

/**
 * @param {Element} original
 * @returns {void}
 */
export function triggerOverflowAction(original: any) {
    _dispatchClick(original);
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
export function copyMessage(mesEl: any) {
    const msg = getMessageByElement(mesEl);
    const text = typeof msg?.mes === 'string' ? msg.mes : '';
    return Promise.resolve(copyText(text));
}

/**
 * @returns {void}
 */
export function regenerateMessage() {
    if (isGenerating()) return;
    document.getElementById('option_regenerate')?.click();
}

/**
 * @returns {void}
 */
export function regenerateLast() {
    if (isGenerating()) return;
    document.getElementById('option_regenerate')?.click();
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
export function editMessage(mesEl: any) {
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
export async function saveMessageEditById(mesId: any, text: any) {
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

    const updated = _waitForEvent(
        stEventKeys.MESSAGE_UPDATED,
        (updatedMessageId: any) => Number(updatedMessageId) === normalizedId,
    );
    _dispatchClick(done);
    await updated;
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
export function createBranch(mesEl: any) {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;
    branchChat(mesId).catch((error: any) => console.error('[ChatUI/adapter] branchChat failed', error));
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
export function createCheckpoint(mesEl: any) {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;
    createNewBookmark(mesId).catch((error: any) => console.error('[ChatUI/adapter] createNewBookmark failed', error));
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
export function toggleHideMessage(mesEl: any) {
    const mesId = _getMessageId(mesEl);
    const msg = getMessageById(mesId);
    if (!msg) return;
    // Source of truth is the message flag (is_system), not native button
    // visibility — reading the DOM could pick the wrong direction.
    const action = msg.is_system === true ? unhideChatMessage(mesId) : hideChatMessage(mesId);
    action.catch((error: any) => console.error('[ChatUI/adapter] toggle hide failed', error));
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
export function deleteMessage(mesEl: any) {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;

    // Call ST's exported deleteMessage(id, swipeIndex, askConfirmation) directly
    // instead of simulating an edit-mode → .mes_edit_delete click on the
    // shield-relocated node, but mirror that handler's policy exactly so we keep
    // native semantics: honour the user's confirm-before-delete preference, and
    // when removing the last message that has multiple swipes, drop only the
    // selected swipe rather than the whole message. (fromSlashCommand is always
    // false from the ChatUI surface.)  See ST script.js .mes_edit_delete handler.
    const message = getMessageById(mesId);
    const confirm = !!getContext().powerUserSettings?.confirm_message_delete;
    const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
    const selectedSwipe = message?.swipe_id ?? undefined;
    const isLast = mesId === getCurrentChat().length - 1;
    const deleteOnlySwipe = confirm
        && !message?.is_user
        && swipes.length > 1
        && isLast
        && selectedSwipe !== undefined;

    stDeleteMessage(mesId, deleteOnlySwipe ? selectedSwipe : undefined, confirm)
        .catch((error: any) => console.error('[ChatUI/adapter] deleteMessage failed', error));
}

/**
 * @param {Element} mesEl
 * @param {'left'|'right'} direction
 * @returns {void}
 */
export function swipeMessage(mesEl: any, direction: any) {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;
    // Call ST's exported swipe() with forceMesId (it tolerates a null event when
    // forceMesId is a number) instead of clicking the off-screen .swipe_left /
    // .swipe_right buttons. direction 'left'|'right' matches ST's SWIPE_DIRECTION.
    stSwipe(null, direction, { forceMesId: mesId, message: getMessageById(mesId) ?? undefined })
        .catch((error: any) => console.error('[ChatUI/adapter] swipe failed', error));
}

/**
 * @param {Element} mesEl
 * @param {string} action
 * @returns {void}
 */
export function triggerMessageAction(mesEl: any, action: any) {
    switch (action) {
        case 'copy':       return copyMessage(mesEl);

        case 'regen':      regenerateMessage();         break;
        case 'edit':       editMessage(mesEl);         break;
        case 'branch':     createBranch(mesEl);        break;
        case 'checkpoint': createCheckpoint(mesEl);    break;
        case 'hide':       toggleHideMessage(mesEl);   break;
        case 'delete':     deleteMessage(mesEl);       break;
        default: break;
    }
}

/**
 * @param {number|string} mesId
 * @param {string} action
 * @returns {void}
 */
export function triggerMessageActionById(mesId: any, action: any) {
    if (action === 'regen') {
        regenerateMessage();
        return;
    }

    const mesEl = getMessageElementById(mesId);
    if (!mesEl) return;
    return triggerMessageAction(mesEl, action);
}

/**
 * @param {number|string} mesId
 * @param {'left'|'right'} direction
 * @returns {void}
 */
export function swipeMessageById(mesId: any, direction: any) {
    const mesEl = getMessageElementById(mesId);
    if (!mesEl) return;
    swipeMessage(mesEl, direction);
}
