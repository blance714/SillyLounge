/**
 * SillyTavern-ChatUI · ST adapter
 *
 * Boundary module for SillyTavern runtime access.
 * UI/store modules should call this adapter instead of importing ST core files
 * or dispatching native ST DOM buttons directly.
 */

import { eventSource, event_types, isGenerating, messageEdit, messageFormatting, sendTextareaMessage } from '../../../../../script.js';
import { getContext } from '../../../../st-context.js';
import { setUserAvatar, getUserAvatars, user_avatar } from '../../../../personas.js';
import { copyText } from '../../../../utils.js';
import { branchChat, createNewBookmark } from '../../../../bookmarks.js';
import { hideChatMessage, unhideChatMessage } from '../../../../chats.js';

export const stEventKeys = Object.freeze({
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    USER_MESSAGE_RENDERED: 'USER_MESSAGE_RENDERED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED',
    MESSAGE_SENT: 'MESSAGE_SENT',
    CHAT_CHANGED: 'CHAT_CHANGED',
    CHAT_LOADED: 'CHAT_LOADED',
    MORE_MESSAGES_LOADED: 'MORE_MESSAGES_LOADED',
    GENERATION_STARTED: 'GENERATION_STARTED',
    GENERATION_STOPPED: 'GENERATION_STOPPED',
    GENERATION_ENDED: 'GENERATION_ENDED',
    STREAM_TOKEN_RECEIVED: 'STREAM_TOKEN_RECEIVED',
    STREAM_REASONING_DONE: 'STREAM_REASONING_DONE',
    PRESET_CHANGED: 'PRESET_CHANGED',
    OAI_PRESET_CHANGED_AFTER: 'OAI_PRESET_CHANGED_AFTER',
    CONNECTION_PROFILE_LOADED: 'CONNECTION_PROFILE_LOADED',
    PERSONA_CHANGED: 'PERSONA_CHANGED',
});

/**
 * @param {string} key
 * @returns {string}
 */
function _resolveEventKey(key) {
    const resolved = event_types[key];
    if (!resolved) throw new Error(`[ChatUI/adapter] Unknown ST event key: ${key}`);
    return resolved;
}

/**
 * @param {Element} mesEl
 * @returns {number}
 */
function _getMessageId(mesEl) {
    return Number(mesEl.getAttribute('mesid'));
}

/**
 * @param {Element} mesEl
 * @returns {JQuery<HTMLElement>|null}
 */
function _getJQueryMessage(mesEl) {
    if (typeof window.$ !== 'function') return null;
    return window.$(mesEl);
}

/**
 * @param {Element} button
 * @returns {void}
 */
function _dispatchClick(button) {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * @param {string} key
 * @param {(...args: any[]) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function _waitForEvent(key, predicate, timeoutMs = 5000) {
    const type = _resolveEventKey(key);

    return new Promise((resolve, reject) => {
        /** @type {ReturnType<typeof setTimeout>|null} */
        let timer = null;
        const cleanup = () => {
            if (timer !== null) clearTimeout(timer);
            eventSource.removeListener(type, handler);
        };
        const handler = (...args) => {
            if (!predicate(...args)) return;
            cleanup();
            resolve();
        };

        timer = setTimeout(() => {
            cleanup();
            reject(new Error(`[ChatUI/adapter] Timed out waiting for ST event: ${key}`));
        }, timeoutMs);
        eventSource.on(type, handler);
    });
}

/** @type {ReturnType<typeof setTimeout>|null} */
let _attachmentAcceptRestoreTimer = null;

/** @type {(() => void)|null} */
let _attachmentAcceptRestore = null;

/**
 * @param {Element} mesEl
 * @returns {object|null}
 */
function getMessageByElement(mesEl) {
    const mesId = _getMessageId(mesEl);
    return getContext().chat?.[mesId] ?? null;
}

/**
 * @param {number} mesId
 * @returns {object|null}
 */
function getMessageById(mesId) {
    return getContext().chat?.[mesId] ?? null;
}

/**
 * @param {object} rawMessage
 * @param {number} messageId
 * @param {boolean} isReasoning
 * @returns {string}
 */
function formatMessageHtml(rawMessage, messageId, isReasoning = false) {
    const message = /** @type {Record<string, any>} */ (rawMessage ?? {});
    const extra = /** @type {Record<string, any>} */ (message.extra ?? {});
    const text = isReasoning
        ? (extra.reasoning_display_text || extra.reasoning || '')
        : (extra.display_text || message.mes || '');
    const sanitizerOverrides = extra.uses_system_ui ? { MESSAGE_ALLOW_SYSTEM_UI: true } : {};

    return messageFormatting(
        String(text),
        typeof message.name === 'string' ? message.name : '',
        message.is_system === true,
        message.is_user === true,
        messageId,
        sanitizerOverrides,
        isReasoning,
    );
}

/**
 * @param {number|string} mesId
 * @returns {Element|null}
 */
function getMessageElementById(mesId) {
    const normalizedId = Number(mesId);
    if (!Number.isFinite(normalizedId)) return null;
    return document.querySelector(`#chat .mes[mesid="${normalizedId}"]`);
}

/**
 * @returns {Array<object>}
 */
function getCurrentChat() {
    return getContext().chat ?? [];
}

/**
 * @returns {Array<object>}
 */
function getCharacters() {
    return getContext().characters ?? [];
}

/**
 * @returns {{ isGenerating: boolean }}
 */
function getGenerationState() {
    return { isGenerating: isGenerating() };
}

/**
 * @returns {HTMLTextAreaElement|null}
 */
function getNativeComposerTextarea() {
    return /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
}

/**
 * @param {string} text
 * @returns {void}
 */
function setNativeComposerText(text) {
    const textarea = getNativeComposerTextarea();
    if (!textarea) return;

    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
async function sendComposerMessage(text) {
    setNativeComposerText(text);
    await sendTextareaMessage();
}

/**
 * @returns {void}
 */
function stopGeneration() {
    const stopButton = document.querySelector('.mes_stop');
    if (stopButton) _dispatchClick(stopButton);
}

/**
 * @param {string} selector
 * @returns {Element|null}
 */
function getElement(selector) {
    return document.querySelector(selector);
}

/**
 * @param {string} selector
 * @returns {void}
 */
function clickElement(selector) {
    const element = getElement(selector);
    if (element) _dispatchClick(element);
}

/**
 * @param {string} drawerSelector
 * @returns {void}
 */
function openDrawer(drawerSelector) {
    const drawer = getElement(drawerSelector);
    if (!drawer) return;

    const content = drawer.querySelector('.drawer-content');
    if (content?.classList.contains('openDrawer')) return;

    const icon = drawer.querySelector('.drawer-toggle, .drawer-icon');
    if (icon) _dispatchClick(icon);
}

/**
 * @param {string} selector
 * @returns {void}
 */
function openRightDrawerPanel(selector) {
    openDrawer('#rightNavHolder');
    setTimeout(() => clickElement(selector), 0);
}

/**
 * @param {string} action
 * @returns {void}
 */
function triggerShellAction(action) {
    switch (action) {
        case 'characters': openRightDrawerPanel('#rm_button_characters'); break;
        case 'characterCreate': openRightDrawerPanel('#rm_button_create'); break;
        case 'groupChats': openRightDrawerPanel('#rm_button_group_chats'); break;
        case 'aiConfig': openDrawer('#ai-config-button'); break;
        case 'worldInfo': openDrawer('#WI-SP-button'); break;
        case 'userSettings': openDrawer('#user-settings-button'); break;
        case 'extensions': openDrawer('#extensions-settings-button'); break;
        case 'personas': openDrawer('#persona-management-button'); break;
        default: break;
    }
}

/**
 * @returns {boolean}
 */
function getIsGroupChat() {
    return !!getContext().groupId;
}

/**
 * @param {string} key
 * @param {Function} handler
 * @returns {() => void}
 */
function subscribe(key, handler) {
    const type = _resolveEventKey(key);
    eventSource.on(type, handler);
    return () => eventSource.removeListener(type, handler);
}

/**
 * @param {Element} mesEl
 * @returns {string}
 */
function getSwipeLabel(mesEl) {
    const msg = getMessageByElement(mesEl);
    if (!msg || !Array.isArray(msg.swipes) || msg.swipes.length <= 1) return '';
    const idx = msg.swipe_id ?? 0;
    return `${idx + 1}​/​${msg.swipes.length}`;
}

/**
 * @returns {void}
 */
function scrollChatToBottom() {
    const chat = document.getElementById('chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
}

/**
 * @param {HTMLElement} item
 * @param {{ isSystem?: boolean, mediaDisplay?: string }} messageMeta
 * @returns {boolean}
 */
function isOverflowActionVisible(item, messageMeta = {}) {
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
function triggerOverflowAction(original) {
    _dispatchClick(original);
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
function copyMessage(mesEl) {
    const msg = getMessageByElement(mesEl);
    const text = typeof msg?.mes === 'string' ? msg.mes : '';
    Promise.resolve(copyText(text))
        .then(() => globalThis.toastr?.info?.('Copied!', '', { timeOut: 2000 }))
        .catch(error => console.error('[ChatUI/adapter] copy failed', error));
}

/**
 * @returns {void}
 */
function regenerateMessage() {
    if (isGenerating()) return;
    document.getElementById('option_regenerate')?.click();
}

/**
 * @returns {void}
 */
function regenerateLast() {
    if (isGenerating()) return;
    document.getElementById('option_regenerate')?.click();
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
function editMessage(mesEl) {
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
async function saveMessageEditById(mesId, text) {
    const normalizedId = Number(mesId);
    if (!Number.isFinite(normalizedId)) {
        throw new Error(`[ChatUI/adapter] Invalid message id for edit: ${mesId}`);
    }

    const mesEl = getMessageElementById(normalizedId);
    if (!mesEl) {
        throw new Error(`[ChatUI/adapter] Message element not found for edit: ${normalizedId}`);
    }

    await messageEdit(normalizedId);

    const textarea = /** @type {HTMLTextAreaElement|null} */ (mesEl.querySelector('.edit_textarea'));
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
        updatedMessageId => Number(updatedMessageId) === normalizedId,
    );
    _dispatchClick(done);
    await updated;
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
function createBranch(mesEl) {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;
    branchChat(mesId).catch(error => console.error('[ChatUI/adapter] branchChat failed', error));
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
function createCheckpoint(mesEl) {
    const mesId = _getMessageId(mesEl);
    if (!Number.isFinite(mesId)) return;
    createNewBookmark(mesId).catch(error => console.error('[ChatUI/adapter] createNewBookmark failed', error));
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
function toggleHideMessage(mesEl) {
    const mesId = _getMessageId(mesEl);
    const msg = getMessageById(mesId);
    if (!msg) return;
    // Source of truth is the message flag (is_system), not native button
    // visibility — reading the DOM could pick the wrong direction.
    const action = msg.is_system === true ? unhideChatMessage(mesId) : hideChatMessage(mesId);
    action.catch(error => console.error('[ChatUI/adapter] toggle hide failed', error));
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
function deleteMessage(mesEl) {
    const $mes = _getJQueryMessage(mesEl);
    if ($mes) {
        if (!$mes.find('.mes_edit_buttons').is(':visible')) {
            $mes.find('.mes_edit').trigger('click');
            setTimeout(() => $mes.find('.mes_edit_delete').trigger('click'), 0);
        } else {
            $mes.find('.mes_edit_delete').trigger('click');
        }
        return;
    }

    const editButtons = mesEl.querySelector('.mes_edit_buttons');
    const editButton = mesEl.querySelector('.mes_edit');
    const deleteButton = mesEl.querySelector('.mes_edit_delete');
    if (editButtons && getComputedStyle(editButtons).display !== 'none') {
        if (deleteButton) _dispatchClick(deleteButton);
    } else if (editButton) {
        _dispatchClick(editButton);
        setTimeout(() => {
            const deferredDelete = mesEl.querySelector('.mes_edit_delete');
            if (deferredDelete) _dispatchClick(deferredDelete);
        }, 0);
    }
}

/**
 * @param {Element} mesEl
 * @param {'left'|'right'} direction
 * @returns {void}
 */
function swipeMessage(mesEl, direction) {
    const selector = direction === 'left' ? '.swipe_left' : '.swipe_right';
    const $mes = _getJQueryMessage(mesEl);
    if ($mes) {
        $mes.find(selector).trigger('click');
        return;
    }
    const button = mesEl.querySelector(selector);
    if (button) _dispatchClick(button);
}

/**
 * @param {Element} mesEl
 * @param {string} action
 * @returns {void}
 */
function triggerMessageAction(mesEl, action) {
    switch (action) {
        case 'copy':       copyMessage(mesEl);         break;
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
function triggerMessageActionById(mesId, action) {
    if (action === 'regen') {
        regenerateMessage();
        return;
    }

    const mesEl = getMessageElementById(mesId);
    if (!mesEl) return;
    triggerMessageAction(mesEl, action);
}

/**
 * @param {number|string} mesId
 * @param {'left'|'right'} direction
 * @returns {void}
 */
function swipeMessageById(mesId, direction) {
    const mesEl = getMessageElementById(mesId);
    if (!mesEl) return;
    swipeMessage(mesEl, direction);
}

/**
 * @param {string} optionId
 * @returns {void}
 */
function triggerOptionsAction(optionId) {
    if (typeof window.$ === 'function') {
        window.$(`#options #${optionId}`).trigger('click', [{ fromSlashCommand: true }]);
        return;
    }

    const button = document.querySelector(`#options #${optionId}`);
    if (button) _dispatchClick(button);
}

/**
 * @returns {void}
 */
function continueMessage() {
    triggerOptionsAction('option_continue');
}

/**
 * @returns {void}
 */
function impersonateMessage() {
    triggerOptionsAction('option_impersonate');
}

/**
 * @returns {void}
 */
function openDeleteMessageMode() {
    triggerOptionsAction('option_delete_mes');
}

/**
 * @returns {void}
 */
function regenerateFromPlusMenu() {
    triggerOptionsAction('option_regenerate');
}

/**
 * @returns {void}
 */
function clearAttachmentPickerRestore() {
    if (_attachmentAcceptRestoreTimer !== null) {
        clearTimeout(_attachmentAcceptRestoreTimer);
        _attachmentAcceptRestoreTimer = null;
    }
    if (_attachmentAcceptRestore) {
        window.removeEventListener('focus', _attachmentAcceptRestore);
        _attachmentAcceptRestore = null;
    }
}

/**
 * @param {string|null} accept
 * @returns {void}
 */
function openAttachmentPicker(accept = null) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('file_form_input'));

    if (input && accept !== null) {
        // Capture the original accept only when no restore cycle is pending, so a
        // second narrowed open before the picker closes still restores to the true
        // default rather than the first call's temporary filter.
        if (!_attachmentAcceptRestore) {
            const prev = input.accept;
            // ST's #attachFile handler does $fileInput.off('change'), which strips
            // any change-listener added here — so restore the accept filter when the
            // OS picker closes (the window regains focus), with a timer as a backstop.
            const restore = () => {
                clearAttachmentPickerRestore();
                input.accept = prev;
            };
            _attachmentAcceptRestore = restore;
            window.addEventListener('focus', restore, { once: true });
            _attachmentAcceptRestoreTimer = setTimeout(restore, 60000);
        }
        input.accept = accept;
    }

    const attachButton = document.querySelector('#attachFile');
    if (attachButton) _dispatchClick(attachButton);
}

/**
 * @param {Element} original
 * @returns {void}
 */
function triggerWandAction(original) {
    _dispatchClick(original);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function _string(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function _numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {Record<string, any>} attachment
 * @param {number} index
 * @returns {{ id: string, type: string, url: string, title: string, source: string, index: number }}
 */
function toMediaDto(attachment, index) {
    const type = _string(attachment.type) || 'image';
    const url = _string(attachment.url);
    const title = _string(attachment.title) || _string(attachment.name) || url.split('/').pop() || type;

    return {
        id: `${index}:${type}:${url}`,
        type,
        url,
        title,
        source: _string(attachment.source),
        index,
    };
}

/**
 * @param {Record<string, any>} file
 * @param {number} index
 * @returns {{ id: string, name: string, url: string, size: number|null, type: string, index: number }}
 */
function toFileDto(file, index) {
    const name = _string(file.name) || _string(file.url).split('/').pop() || 'Attachment';

    return {
        id: `${index}:${name}:${_string(file.url)}`,
        name,
        url: _string(file.url),
        size: _numberOrNull(file.size),
        type: _string(file.type),
        index,
    };
}

/**
 * @param {object} rawMessage
 * @returns {{ display: string, inline: boolean, mediaIndex: number, media: Array<object>, files: Array<object> }}
 */
function getMessageAttachments(rawMessage) {
    const message = /** @type {Record<string, any>} */ (rawMessage ?? {});
    const extra = /** @type {Record<string, any>} */ (message.extra ?? {});
    const media = Array.isArray(extra.media)
        ? extra.media
        : [
            ...(_string(extra.image) ? [{ type: 'image', url: _string(extra.image), title: _string(extra.title) }] : []),
            ...(_string(extra.video) ? [{ type: 'video', url: _string(extra.video), title: _string(extra.title) }] : []),
            ...(Array.isArray(extra.image_swipes) ? extra.image_swipes.map(url => ({ type: 'image', url: _string(url), title: _string(extra.title) })) : []),
        ];
    const files = Array.isArray(extra.files)
        ? extra.files
        : (extra.file ? [extra.file] : []);
    const display = _string(extra.media_display) || (media.length > 1 ? 'list' : '');

    return {
        display,
        inline: extra.inline_image !== false,
        mediaIndex: typeof extra.media_index === 'number' ? extra.media_index : 0,
        media: media
            .filter(item => item && typeof item === 'object')
            .map((item, index) => toMediaDto(/** @type {Record<string, any>} */ (item), index))
            .filter(item => item.url),
        files: files
            .filter(item => item && typeof item === 'object')
            .map((item, index) => toFileDto(/** @type {Record<string, any>} */ (item), index)),
    };
}

/**
 * @param {number|string} messageId
 * @param {number} mediaIndex
 * @returns {void}
 */
function openMessageMedia(messageId, mediaIndex) {
    const mesEl = getMessageElementById(messageId);
    const button = mesEl?.querySelector(`.mes_media_container[data-index="${mediaIndex}"] .mes_media_enlarge`);
    if (button) {
        _dispatchClick(button);
        return;
    }

    const media = mesEl?.querySelector(`.mes_media_container[data-index="${mediaIndex}"] .mes_img, .mes_media_container[data-index="${mediaIndex}"] .mes_video`);
    if (media) _dispatchClick(media);
}

/**
 * @param {number|string} messageId
 * @param {number} fileIndex
 * @returns {void}
 */
function openMessageFile(messageId, fileIndex) {
    const mesEl = getMessageElementById(messageId);
    const button = mesEl?.querySelector(`.mes_file_container[data-index="${fileIndex}"] .mes_file_open`);
    if (button) _dispatchClick(button);
}

// ── Wand / extension tools (proxy ST's #extensionsMenu items) ──────────────────

/** @type {Map<string, HTMLElement>} */
const _wandItemMap = new Map();

/**
 * Enumerate visible wand items from ST's #extensionsMenu. Rebuilds the internal
 * id->liveElement map each call (ST rebuilds items on chat change). The live
 * elements stay private to the adapter; the UI only ever sees plain DTOs.
 *
 * @returns {{ id: string, label: string, iconHtml: string }[]}
 */
function listWandItems() {
    _wandItemMap.clear();
    const wandMenu = document.getElementById('extensionsMenu');
    if (!wandMenu) return [];

    const out = [];
    let seq = 0;
    const consider = (el) => {
        if (!(el instanceof HTMLElement)) return;
        if (el.classList.contains('displayNone')) return;
        if (window.getComputedStyle(el).display === 'none') return;
        const label = (el.querySelector('span')?.textContent || el.textContent || '').trim();
        const iconEl = el.querySelector('.extensionsMenuExtensionButton, [class*="fa-"]');
        const id = `wand-${seq++}`;
        _wandItemMap.set(id, el);
        out.push({ id, label, iconHtml: iconEl ? iconEl.outerHTML : '' });
    };

    // Primary: items inside each .extension_container.
    wandMenu.querySelectorAll('.extension_container').forEach(container => {
        Array.from(container.children).forEach(consider);
    });
    // Fallback: items appended directly to #extensionsMenu (e.g. gallery).
    Array.from(wandMenu.children).forEach(child => {
        if (child instanceof HTMLElement && child.classList.contains('extension_container')) return;
        consider(child);
    });
    return out;
}

/**
 * Proxy a click onto the live mapped wand element (never a clone).
 *
 * @param {string} id opaque id from listWandItems()
 * @returns {boolean}
 */
function triggerWandItem(id) {
    const el = _wandItemMap.get(id);
    if (!el) return false;
    triggerWandAction(el);
    return true;
}

// ── Pending composer attachments (ST stages them in #file_form_input.files) ────

/**
 * @returns {HTMLInputElement|null}
 */
function _pendingInput() {
    const el = document.getElementById('file_form_input');
    return el instanceof HTMLInputElement ? el : null;
}

/**
 * List files the user has staged but not yet sent.
 *
 * @returns {{ id: string, name: string, type: string, size: number }[]}
 */
function getPendingAttachments() {
    const input = _pendingInput();
    if (!input || !input.files) return [];
    return Array.from(input.files).map((file, index) => ({
        id: `${index}:${file.name}:${file.size}:${file.lastModified}`,
        name: file.name,
        type: file.type || '',
        size: file.size,
    }));
}

/**
 * Remove one staged file before send by rebuilding the input FileList
 * (FileList is read-only, so this uses a DataTransfer like ST itself does).
 *
 * @param {string} id
 * @returns {void}
 */
function removePendingAttachment(id) {
    const input = _pendingInput();
    if (!input || !input.files) return;

    const transfer = new DataTransfer();
    Array.from(input.files).forEach((file, index) => {
        const fileId = `${index}:${file.name}:${file.size}:${file.lastModified}`;
        if (fileId !== id) transfer.items.add(file);
    });
    input.files = transfer.files;

    if (input.files.length === 0) {
        const form = document.getElementById('file_form');
        if (form instanceof HTMLFormElement) form.reset();
    }
    _emitPendingChanged();
}

/** @type {Set<() => void>} */
const _pendingListeners = new Set();

/** @type {MutationObserver|null} */
let _pendingObserver = null;

/**
 * @returns {void}
 */
function _emitPendingChanged() {
    for (const listener of _pendingListeners) {
        try {
            listener();
        } catch (error) {
            console.error('[ChatUI/adapter] pending-attachment listener failed', error);
        }
    }
}

/**
 * ST fires no event for pending attach/remove, so synthesize one by observing
 * #file_form (it toggles .displayNone + preview text on attach/reset/send).
 *
 * @param {() => void} handler
 * @returns {() => void}
 */
function subscribePendingChanged(handler) {
    if (!_pendingObserver) {
        const form = document.getElementById('file_form');
        if (form) {
            _pendingObserver = new MutationObserver(() => _emitPendingChanged());
            _pendingObserver.observe(form, {
                attributes: true,
                attributeFilter: ['class'],
                childList: true,
                subtree: true,
            });
        }
    }
    _pendingListeners.add(handler);
    return () => {
        _pendingListeners.delete(handler);
    };
}

// ── Selector chips (preset / model / persona quick-switch) ─────────────────────

/**
 * @returns {any}
 */
function _presetManager() {
    return getContext().getPresetManager?.() ?? null;
}

/**
 * @returns {{ value: string, label: string, selected: boolean }[]}
 */
function _presetOptions() {
    const pm = _presetManager();
    if (!pm) return [];
    const names = pm.getAllPresets() ?? [];
    const current = pm.getSelectedPresetName();
    return names.map(name => ({ value: name, label: name, selected: name === current }));
}

/**
 * @returns {{ value: string, label: string, selected: boolean }[]}
 */
function _modelOptions() {
    const cm = getContext().extensionSettings?.connectionManager;
    const profiles = Array.isArray(cm?.profiles) ? cm.profiles : [];
    const selected = cm?.selectedProfile ?? '';
    const options = [{ value: '', label: '— 默认 —', selected: !selected }];
    [...profiles]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach(profile => options.push({
            value: profile.id,
            label: profile.name ?? profile.id,
            selected: profile.id === selected,
        }));
    return options;
}

/**
 * @returns {Promise<{ value: string, label: string, selected: boolean }[]>}
 */
async function _personaOptions() {
    let ids = [];
    try {
        ids = await getUserAvatars(false);
    } catch {
        ids = [];
    }
    const personas = getContext().powerUserSettings?.personas ?? {};
    return (Array.isArray(ids) ? ids : []).map(id => ({
        value: id,
        label: personas[id] ?? id,
        selected: id === user_avatar,
    }));
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @returns {Promise<{ value: string, label: string, selected: boolean }[]>}
 */
async function getSelectorOptions(kind) {
    if (kind === 'preset') return _presetOptions();
    if (kind === 'model') return _modelOptions();
    if (kind === 'persona') return _personaOptions();
    return [];
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @returns {Promise<{ value: string, label: string }|null>}
 */
async function getSelectedSelector(kind) {
    const options = await getSelectorOptions(kind);
    const current = options.find(option => option.selected);
    return current ? { value: current.value, label: current.label } : null;
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @param {string} value
 * @returns {Promise<void>}
 */
async function selectSelector(kind, value) {
    if (kind === 'preset') {
        const pm = _presetManager();
        if (!pm) return;
        const resolved = pm.findPreset(value);
        if (resolved !== undefined && resolved !== null) pm.selectPreset(resolved);
        return;
    }
    if (kind === 'model') {
        const select = document.getElementById('connection_profiles');
        if (!(select instanceof HTMLSelectElement)) return;
        select.value = value;
        select.dispatchEvent(new Event('change'));
        return;
    }
    if (kind === 'persona') {
        if (!value) return;
        await setUserAvatar(value);
    }
}

export const chatuiAdapter = Object.freeze({
    getContext,
    getCurrentChat,
    getCharacters,
    getMessageById,
    getMessageByElement,
    getMessageElementById,
    formatMessageHtml,
    getGenerationState,
    getIsGroupChat,
    subscribe,
    scrollChatToBottom,
    composerActions: Object.freeze({
        getNativeComposerTextarea,
        setNativeComposerText,
        sendComposerMessage,
        stopGeneration,
    }),
    shellActions: Object.freeze({
        triggerShellAction,
    }),
    mediaActions: Object.freeze({
        getMessageAttachments,
        openMessageMedia,
        openMessageFile,
    }),
    messageActions: Object.freeze({
        copyMessage,
        regenerateMessage,
        regenerateLast,
        editMessage,
        saveMessageEditById,
        createBranch,
        createCheckpoint,
        toggleHideMessage,
        deleteMessage,
        swipeMessage,
        swipeMessageById,
        triggerMessageAction,
        triggerMessageActionById,
        getSwipeLabel,
        isOverflowActionVisible,
        triggerOverflowAction,
    }),
    menuActions: Object.freeze({
        triggerOptionsAction,
        regenerateFromPlusMenu,
        continueMessage,
        impersonateMessage,
        openDeleteMessageMode,
        openAttachmentPicker,
        clearAttachmentPickerRestore,
        triggerWandAction,
        listWandItems,
        triggerWandItem,
        getPendingAttachments,
        removePendingAttachment,
        subscribePendingChanged,
    }),
    selectorActions: Object.freeze({
        getSelectorOptions,
        getSelectedSelector,
        selectSelector,
    }),
});
