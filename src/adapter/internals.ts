/**
 * SillyTavern-ChatUI · adapter internals
 *
 * Shared ST runtime helpers for adapter submodules.
 */

import { eventSource, event_types, getCurrentChatDetails, isGenerating, messageFormatting } from '@st/script';
import { getContext } from '@st/st-context';
import {
    type MessageSnapshotDto,
    projectMessageSnapshot,
} from './schema.js';
import {
    createCharacterChatKey,
    createConversationLocator,
    createGroupChatKey,
    createUnscopedChatKey,
} from './chat-key.js';

export { getContext };

export const stEventKeys = Object.freeze({
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    USER_MESSAGE_RENDERED: 'USER_MESSAGE_RENDERED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_SWIPE_DELETED: 'MESSAGE_SWIPE_DELETED',
    MESSAGE_EDITED: 'MESSAGE_EDITED',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
    MESSAGE_FILE_EMBEDDED: 'MESSAGE_FILE_EMBEDDED',
    MESSAGE_REASONING_EDITED: 'MESSAGE_REASONING_EDITED',
    MESSAGE_REASONING_DELETED: 'MESSAGE_REASONING_DELETED',
    MESSAGE_SENT: 'MESSAGE_SENT',
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
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
export function _resolveEventKey(key: any) {
    const resolved = event_types[key];
    if (!resolved) throw new Error(`[ChatUI/adapter] Unknown ST event key: ${key}`);
    return resolved;
}

/**
 * @param {Element} mesEl
 * @returns {number}
 */
export function _getMessageId(mesEl: any) {
    return Number(mesEl.getAttribute('mesid'));
}

/**
 * @param {Element} mesEl
 * @returns {JQuery<HTMLElement>|null}
 */
export function _getJQueryMessage(mesEl: any) {
    if (typeof window.$ !== 'function') return null;
    return window.$(mesEl);
}

/**
 * @param {Element} button
 * @returns {void}
 */
export function _dispatchClick(button: any) {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * Trigger a delegated jQuery click and await the async handler's return value.
 * ST's message-edit completion handler returns the `messageEditDone()` promise;
 * a plain DOM dispatch discards it and would release ChatUI's host queue before
 * the durable save finishes.
 */
export function _dispatchClickAndWait(button: HTMLElement): Promise<unknown> {
    if (typeof window.$ !== 'function' || typeof window.$.Event !== 'function') {
        throw new Error('[ChatUI/adapter] jQuery event completion is unavailable');
    }
    const event = window.$.Event('click');
    window.$(button).trigger(event);
    const result = event.result;
    if (!result || typeof result.then !== 'function') {
        // The mutation has already entered ST, so failing open would permit a
        // navigation/rename race. Keep the lane owned when the host no longer
        // exposes an awaitable delegated handler contract.
        return new Promise(() => undefined);
    }
    return Promise.resolve(result);
}

function _isHiddenLiveElement(element: HTMLElement) {
    return element.classList.contains('qr--hidden')
        || element.classList.contains('displayNone')
        || window.getComputedStyle(element).display === 'none';
}

export function buildLiveElementRegistry<T>(
    container: Element | null,
    cache: Map<string, HTMLElement>,
    {
        idPrefix,
        elements,
        isHidden,
        toDto,
    }: {
        idPrefix: string;
        elements: (container: Element) => Iterable<Element>;
        isHidden?: (element: HTMLElement) => boolean;
        toDto: (element: HTMLElement, id: string) => T;
    },
): T[] {
    cache.clear();
    if (!container) return [];

    const out: T[] = [];
    let seq = 0;
    for (const candidate of elements(container)) {
        if (!(candidate instanceof HTMLElement)) continue;
        if (_isHiddenLiveElement(candidate)) continue;
        if (isHidden?.(candidate)) continue;

        const id = `${idPrefix}-${seq++}`;
        cache.set(id, candidate);
        out.push(toDto(candidate, id));
    }
    return out;
}

/**
 * @param {string} key
 * @param {(...args: any[]) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function _waitForEvent(key: any, predicate: any, timeoutMs = 5000): Promise<void> {
    const type = _resolveEventKey(key);

    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
            if (timer !== null) clearTimeout(timer);
            eventSource.removeListener(type, handler);
        };
        const handler = (...args: any[]) => {
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
export function getMessageByElement(mesEl: any) {
    const mesId = _getMessageId(mesEl);
    return getCurrentChat()[mesId] ?? null;
}

/**
 * @param {number} mesId
 * @returns {object|null}
 */
export function getMessageById(mesId: any) {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) return null;
    return getCurrentChat()[normalizedId] ?? null;
}

/**
 * Format one already-normalized snapshot through ST's native formatter.
 */
function _formatMessageSnapshotHtml(message: MessageSnapshotDto, isReasoning: boolean): string {
    const text = isReasoning
        ? (message.reasoningDisplayText || message.reasoning)
        : message.displayText;
    const sanitizerOverrides = message.usesSystemUi ? { MESSAGE_ALLOW_SYSTEM_UI: true } : {};

    return messageFormatting(
        text,
        message.name,
        message.isSystem,
        message.isUser,
        message.id,
        sanitizerOverrides,
        isReasoning,
    );
}

/** Format one live message by id without exposing its raw host object. */
export function formatMessageHtmlById(messageId: number | string, isReasoning = false): string {
    const message = getCurrentMessageSnapshotById(messageId);
    return message ? _formatMessageSnapshotHtml(message, isReasoning) : '';
}

/**
 * @param {number|string} mesId
 * @returns {Element|null}
 */
export function getMessageElementById(mesId: any) {
    const normalizedId = Number(mesId);
    if (!Number.isFinite(normalizedId)) return null;
    return document.querySelector(`#chat .mes[mesid="${normalizedId}"]`);
}

/**
 * Internal raw-host reader for adapter action modules. This must not be
 * exported from the public facade.
 */
export function getCurrentChat(): unknown[] {
    const chat = getContext().chat;
    return Array.isArray(chat) ? chat : [];
}

function _getCurrentChatKeyFromContext(ctx: ReturnType<typeof getContext>): string {
    const rawSession = getCurrentChatDetails()?.sessionName;
    const session = typeof rawSession === 'string' ? rawSession : '';
    // Session filename, not chat_metadata.integrity, is the distinguishing host
    // coordinate. ST deliberately copies metadata into branches/checkpoints and
    // legacy chats can receive an unsaved random integrity value on each load.
    // ChatUI migrates its own state after a confirmed rename.
    const conversationLocator = createConversationLocator(session);
    const groupId = ctx.groupId;
    if (groupId !== undefined && groupId !== null && groupId !== '') {
        return createGroupChatKey(String(groupId), conversationLocator);
    }

    const characterId = Number(ctx.characterId);
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const selected = Number.isInteger(characterId) && characterId >= 0
        ? characters[characterId]
        : null;
    const avatar = selected && typeof selected === 'object' && typeof selected.avatar === 'string'
        ? selected.avatar
        : '';
    return avatar
        ? createCharacterChatKey(avatar, conversationLocator)
        : createUnscopedChatKey(conversationLocator);
}

/**
 * A stable identity for the active chat session: changes on character/group or
 * chat-file switch, stays constant within a chat. Used by the UI to tell a chat
 * switch apart from an in-place message append.
 * @returns {string}
 */
export function getCurrentChatKey() {
    return _getCurrentChatKeyFromContext(getContext());
}

export type CurrentMessagesSnapshotDto = Readonly<{
    chatKey: string;
    messages: ReadonlyArray<MessageSnapshotDto>;
}>;

/** Parse the active chat once into immutable boundary DTOs. */
export function getCurrentMessageSnapshots(): CurrentMessagesSnapshotDto {
    const ctx = getContext();
    const rawMessages = Array.isArray(ctx.chat) ? ctx.chat : [];
    const messages = Object.freeze(rawMessages.map((message: unknown, id: number) => (
        projectMessageSnapshot(message, id)
    )));

    return Object.freeze({
        chatKey: _getCurrentChatKeyFromContext(ctx),
        messages,
    });
}

/** O(1) live-message read for streaming/edit/swipe updates. */
export function getCurrentMessageSnapshotById(messageId: number | string): MessageSnapshotDto | null {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) return null;
    const rawMessages = getCurrentChat();
    return id < rawMessages.length ? projectMessageSnapshot(rawMessages[id], id) : null;
}

/** O(1) active chat length read; does not parse the message array. */
export function getCurrentMessageCount(): number {
    return getCurrentChat().length;
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
export function subscribe(key: any, handler: any) {
    const type = _resolveEventKey(key);
    eventSource.on(type, handler);
    return () => eventSource.removeListener(type, handler);
}

/** Subscribe ahead of async third-party listeners when event ordering is data. */
export function subscribeFirst(key: any, handler: any) {
    const type = _resolveEventKey(key);
    eventSource.makeFirst(type, handler);
    return () => eventSource.removeListener(type, handler);
}

/** Subscribe after existing listeners when their completion closes a causal window. */
export function subscribeLast(key: any, handler: any) {
    const type = _resolveEventKey(key);
    eventSource.makeLast(type, handler);
    return () => eventSource.removeListener(type, handler);
}
