/**
 * SillyTavern-ChatUI · adapter internals
 *
 * Shared ST runtime helpers for adapter submodules.
 */

import { eventSource, event_types, getCurrentChatDetails, isGenerating, messageFormatting } from '../../../../../script.js';
import { getContext } from '../../../../st-context.js';

export { getContext };

export const stEventKeys = Object.freeze({
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    USER_MESSAGE_RENDERED: 'USER_MESSAGE_RENDERED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
    MESSAGE_SENT: 'MESSAGE_SENT',
    CHAT_CHANGED: 'CHAT_CHANGED',
    CHAT_RENAMED: 'CHAT_RENAMED',
    CHAT_DELETED: 'CHAT_DELETED',
    CHAT_LOADED: 'CHAT_LOADED',
    CHARACTER_EDITED: 'CHARACTER_EDITED',
    CHARACTER_DELETED: 'CHARACTER_DELETED',
    CHARACTER_DUPLICATED: 'CHARACTER_DUPLICATED',
    CHARACTER_RENAMED: 'CHARACTER_RENAMED',
    CHARACTER_PAGE_LOADED: 'CHARACTER_PAGE_LOADED',
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
export function _resolveEventKey(key) {
    const resolved = event_types[key];
    if (!resolved) throw new Error(`[ChatUI/adapter] Unknown ST event key: ${key}`);
    return resolved;
}

/**
 * @param {Element} mesEl
 * @returns {number}
 */
export function _getMessageId(mesEl) {
    return Number(mesEl.getAttribute('mesid'));
}

/**
 * @param {Element} mesEl
 * @returns {JQuery<HTMLElement>|null}
 */
export function _getJQueryMessage(mesEl) {
    if (typeof window.$ !== 'function') return null;
    return window.$(mesEl);
}

/**
 * @param {Element} button
 * @returns {void}
 */
export function _dispatchClick(button) {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * @param {string} key
 * @param {(...args: any[]) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function _waitForEvent(key, predicate, timeoutMs = 5000) {
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

/**
 * @param {Element} mesEl
 * @returns {object|null}
 */
export function getMessageByElement(mesEl) {
    const mesId = _getMessageId(mesEl);
    return getContext().chat?.[mesId] ?? null;
}

/**
 * @param {number} mesId
 * @returns {object|null}
 */
export function getMessageById(mesId) {
    return getContext().chat?.[mesId] ?? null;
}

/**
 * @param {object} rawMessage
 * @param {number} messageId
 * @param {boolean} isReasoning
 * @returns {string}
 */
export function formatMessageHtml(rawMessage, messageId, isReasoning = false) {
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
export function getMessageElementById(mesId) {
    const normalizedId = Number(mesId);
    if (!Number.isFinite(normalizedId)) return null;
    return document.querySelector(`#chat .mes[mesid="${normalizedId}"]`);
}

/**
 * @returns {Array<object>}
 */
export function getCurrentChat() {
    return getContext().chat ?? [];
}

/**
 * A stable identity for the active chat session: changes on character/group or
 * chat-file switch, stays constant within a chat. Used by the UI to tell a chat
 * switch apart from an in-place message append.
 * @returns {string}
 */
export function getCurrentChatKey() {
    const ctx = getContext();
    const scope = ctx.groupId ?? ctx.characterId ?? '';
    const session = getCurrentChatDetails()?.sessionName ?? '';
    return `${scope}::${session}`;
}

/**
 * @returns {Array<object>}
 */
export function getCharacters() {
    return getContext().characters ?? [];
}

/**
 * @returns {{ isGenerating: boolean }}
 */
export function getGenerationState() {
    return { isGenerating: isGenerating() };
}

/**
 * @returns {boolean}
 */
export function getIsGroupChat() {
    return !!getContext().groupId;
}

/**
 * @param {string} key
 * @param {Function} handler
 * @returns {() => void}
 */
export function subscribe(key, handler) {
    const type = _resolveEventKey(key);
    eventSource.on(type, handler);
    return () => eventSource.removeListener(type, handler);
}

/**
 * @returns {void}
 */
export function scrollChatToBottom() {
    const chat = document.getElementById('chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
}
