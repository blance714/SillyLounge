/**
 * SillyTavern-ChatUI · ST adapter
 *
 * Boundary module for SillyTavern runtime access.
 * UI/store modules should call this adapter instead of importing ST core files
 * or dispatching native ST DOM buttons directly.
 */

import { eventSource, event_types, isGenerating, messageEdit, messageFormatting, sendTextareaMessage } from '../../../../../script.js';
import { getContext } from '../../../../st-context.js';

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
 * @param {Element} button
 * @returns {void}
 */
function _dispatchPointerUp(button) {
    const event = typeof PointerEvent === 'function'
        ? new PointerEvent('pointerup', { bubbles: true, cancelable: true })
        : new Event('pointerup', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
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
    const copyBtn = mesEl.querySelector('.mes_copy');
    if (copyBtn) {
        _dispatchPointerUp(copyBtn);
        return;
    }

    const msg = getMessageByElement(mesEl);
    const text = typeof msg?.mes === 'string' ? msg.mes : '';
    navigator.clipboard?.writeText?.(text)?.catch(() => {});
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
    const $mes = _getJQueryMessage(mesEl);
    if ($mes) {
        $mes.find('.mes_create_branch').trigger('click');
        return;
    }
    const button = mesEl.querySelector('.mes_create_branch');
    if (button) _dispatchClick(button);
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
function createCheckpoint(mesEl) {
    const $mes = _getJQueryMessage(mesEl);
    if ($mes) {
        $mes.find('.mes_create_bookmark').trigger('click');
        return;
    }
    const button = mesEl.querySelector('.mes_create_bookmark');
    if (button) _dispatchClick(button);
}

/**
 * @param {Element} mesEl
 * @returns {void}
 */
function toggleHideMessage(mesEl) {
    const $mes = _getJQueryMessage(mesEl);
    if ($mes) {
        const $unhide = $mes.find('.mes_unhide');
        if ($unhide.is(':visible')) {
            $unhide.trigger('click');
        } else {
            $mes.find('.mes_hide').trigger('click');
        }
        return;
    }

    const unhide = mesEl.querySelector('.mes_unhide:not(.displayNone)');
    const hide = mesEl.querySelector('.mes_hide');
    if (unhide) {
        _dispatchClick(unhide);
    } else if (hide) {
        _dispatchClick(hide);
    }
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
}

/**
 * @param {string|null} accept
 * @returns {void}
 */
function openAttachmentPicker(accept = null) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('file_form_input'));

    if (input && accept !== null) {
        const prev = input.accept;
        input.accept = accept;
        clearAttachmentPickerRestore();

        input.addEventListener('change', () => {
            clearAttachmentPickerRestore();
            input.accept = prev;
        }, { once: true });

        _attachmentAcceptRestoreTimer = setTimeout(() => {
            _attachmentAcceptRestoreTimer = null;
            input.accept = prev;
        }, 60000);
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
    }),
});
