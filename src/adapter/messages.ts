/**
 * SillyTavern-ChatUI · message adapter
 */

import { deleteMessage as stDeleteMessage, isGenerating, messageEdit, swipe as stSwipe } from '@st/script';
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

export async function copyMessage(mesEl: Element): Promise<void> {
    const rawMessage = getMessageByElement(mesEl);
    if (
        !rawMessage
        || typeof rawMessage !== 'object'
        || Array.isArray(rawMessage)
        || typeof (rawMessage as Record<string, unknown>).mes !== 'string'
    ) {
        throw new Error(`[ChatUI/adapter] Message record not found for copy: ${_getMessageId(mesEl)}`);
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

export async function createBranch(mesEl: Element): Promise<void> {
    const mesId = _getMessageId(mesEl);
    if (!Number.isInteger(mesId) || mesId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for branch: ${mesId}`);
    }
    await branchChat(mesId);
}

export async function createCheckpoint(mesEl: Element): Promise<void> {
    const mesId = _getMessageId(mesEl);
    if (!Number.isInteger(mesId) || mesId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for checkpoint: ${mesId}`);
    }
    await createNewBookmark(mesId);
}

export async function toggleHideMessage(mesEl: Element): Promise<void> {
    const mesId = _getMessageId(mesEl);
    if (!Number.isInteger(mesId) || mesId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for hide: ${mesId}`);
    }
    const msg = parseMessageRecord(getMessageById(mesId));
    if (!msg) {
        throw new Error(`[ChatUI/adapter] Message record not found for hide: ${mesId}`);
    }
    // Source of truth is the message flag (is_system), not native button
    // visibility — reading the DOM could pick the wrong direction.
    const action = msg.is_system === true ? unhideChatMessage(mesId) : hideChatMessage(mesId);
    await action;
}

export async function deleteMessage(mesEl: Element): Promise<void> {
    const mesId = _getMessageId(mesEl);
    if (!Number.isInteger(mesId) || mesId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for delete: ${mesId}`);
    }

    // Call ST's exported deleteMessage(id, swipeIndex, askConfirmation) directly
    // instead of simulating an edit-mode → .mes_edit_delete click on the
    // shield-relocated node, but mirror that handler's policy exactly so we keep
    // native semantics: honour the user's confirm-before-delete preference, and
    // when removing the last message that has multiple swipes, drop only the
    // selected swipe rather than the whole message. (fromSlashCommand is always
    // false from the ChatUI surface.)  See ST script.js .mes_edit_delete handler.
    const message = parseMessageRecord(getMessageById(mesId));
    if (!message) {
        throw new Error(`[ChatUI/adapter] Message record not found for delete: ${mesId}`);
    }
    const confirm = !!(getContext() as DeleteSettingsContext).powerUserSettings?.confirm_message_delete;
    const swipes = message.swipes;
    const selectedSwipe = message.swipe_id;
    const isLast = mesId === arrayLength(getCurrentChat()) - 1;
    const deleteOnlySwipe = confirm
        && !message.is_user
        && swipes.length > 1
        && isLast
        && selectedSwipe !== undefined;

    await stDeleteMessage(mesId, deleteOnlySwipe ? selectedSwipe : undefined, confirm);
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

export async function triggerMessageAction(mesEl: Element, action: MessageAction): Promise<void> {
    switch (action) {
        case 'copy':       await copyMessage(mesEl);       break;

        case 'regen':      regenerateMessage();         break;
        case 'edit':       editMessage(mesEl);         break;
        case 'branch':     await createBranch(mesEl);     break;
        case 'checkpoint': await createCheckpoint(mesEl); break;
        case 'hide':       await toggleHideMessage(mesEl); break;
        case 'delete':     await deleteMessage(mesEl);     break;
        default: break;
    }
}

export async function triggerMessageActionById(mesId: MessageId, action: MessageAction): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for ${action}: ${mesId}`);
    }

    const mesEl = getMessageElementById(normalizedId);
    if (!mesEl) {
        throw new Error(`[ChatUI/adapter] Message element not found for ${action}: ${normalizedId}`);
    }
    await triggerMessageAction(mesEl, action);
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
