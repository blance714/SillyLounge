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
import { parseMessageRecord } from './schema.js';

type MessageId = number | string;
export type MessageAction = 'copy' | 'regen' | 'edit' | 'branch' | 'checkpoint' | 'hide' | 'delete';
export type SwipeDirection = 'left' | 'right';

type DeleteSettingsContext = {
    powerUserSettings?: {
        confirm_message_delete?: unknown;
    };
};

function reportAsyncFailure(work: unknown, message: string): void {
    Promise.resolve(work).catch((error: unknown) => console.error(message, error));
}

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
    const msg = parseMessageRecord(getMessageByElement(mesEl));
    const text = msg?.mes ?? '';
    await copyText(text);
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

    const updated = _waitForEvent(
        stEventKeys.MESSAGE_UPDATED,
        (updatedMessageId: unknown) => Number(updatedMessageId) === normalizedId,
    );
    _dispatchClick(done);
    await updated;
}

export function createBranch(mesEl: Element): void {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;
    reportAsyncFailure(branchChat(mesId), '[ChatUI/adapter] branchChat failed');
}

export function createCheckpoint(mesEl: Element): void {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;
    reportAsyncFailure(createNewBookmark(mesId), '[ChatUI/adapter] createNewBookmark failed');
}

export function toggleHideMessage(mesEl: Element): void {
    const mesId = _getMessageId(mesEl);
    const msg = parseMessageRecord(getMessageById(mesId));
    if (!msg) return;
    // Source of truth is the message flag (is_system), not native button
    // visibility — reading the DOM could pick the wrong direction.
    const action = msg.is_system === true ? unhideChatMessage(mesId) : hideChatMessage(mesId);
    reportAsyncFailure(action, '[ChatUI/adapter] toggle hide failed');
}

export function deleteMessage(mesEl: Element): void {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;

    // Call ST's exported deleteMessage(id, swipeIndex, askConfirmation) directly
    // instead of simulating an edit-mode → .mes_edit_delete click on the
    // shield-relocated node, but mirror that handler's policy exactly so we keep
    // native semantics: honour the user's confirm-before-delete preference, and
    // when removing the last message that has multiple swipes, drop only the
    // selected swipe rather than the whole message. (fromSlashCommand is always
    // false from the ChatUI surface.)  See ST script.js .mes_edit_delete handler.
    const message = parseMessageRecord(getMessageById(mesId));
    const confirm = !!(getContext() as DeleteSettingsContext).powerUserSettings?.confirm_message_delete;
    const swipes = message?.swipes ?? [];
    const selectedSwipe = message?.swipe_id;
    const isLast = mesId === arrayLength(getCurrentChat()) - 1;
    const deleteOnlySwipe = confirm
        && !message?.is_user
        && swipes.length > 1
        && isLast
        && selectedSwipe !== undefined;

    reportAsyncFailure(
        stDeleteMessage(mesId, deleteOnlySwipe ? selectedSwipe : undefined, confirm),
        '[ChatUI/adapter] deleteMessage failed',
    );
}

export function swipeMessage(mesEl: Element, direction: SwipeDirection): void {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;
    // Call ST's exported swipe() with forceMesId (it tolerates a null event when
    // forceMesId is a number) instead of clicking the off-screen .swipe_left /
    // .swipe_right buttons. direction 'left'|'right' matches ST's SWIPE_DIRECTION.
    reportAsyncFailure(
        stSwipe(null, direction, { forceMesId: mesId, message: getMessageById(mesId) ?? undefined }),
        '[ChatUI/adapter] swipe failed',
    );
}

export function triggerMessageAction(mesEl: Element, action: MessageAction): Promise<void> | void {
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

export function triggerMessageActionById(mesId: MessageId, action: MessageAction): Promise<void> | void {
    if (action === 'regen') {
        regenerateMessage();
        return;
    }

    const mesEl = getMessageElementById(mesId);
    if (!mesEl) return;
    return triggerMessageAction(mesEl, action);
}

export function swipeMessageById(mesId: MessageId, direction: SwipeDirection): void {
    const mesEl = getMessageElementById(mesId);
    if (!mesEl) return;
    swipeMessage(mesEl, direction);
}
