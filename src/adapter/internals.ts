/**
 * SillyTavern-ChatUI · adapter internals
 *
 * Shared ST runtime helpers for adapter submodules.
 */

import { eventSource, event_types, getCurrentChatDetails, isGenerating, messageFormatting } from '@st/script';
import { getContext } from '@st/st-context';
import {
    type MessageIndexSnapshotDto,
    type MessageSnapshotDto,
    projectMessageIndexSnapshot,
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
    // Group-chat completion signal only: generateGroupWrapper() (group-chats.js)
    // holds is_group_generating (=> isGenerating()) true across every activated
    // member's own GENERATION_ENDED and only clears it in its `finally`, right
    // before emitting this event — see enqueueGenerationOperation in chat-actions.ts.
    GROUP_WRAPPER_FINISHED: 'GROUP_WRAPPER_FINISHED',
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

/** Diagnostic snapshot of a button for the error paths below — never the live node itself. */
function _describeButton(button: HTMLElement): { tag: string; id: string; classes: string } {
    return {
        tag: button.tagName ?? '(unknown)',
        id: button.id ?? '',
        classes: button.className ?? '',
    };
}

/**
 * Trigger a delegated jQuery click and await the async handler's return value.
 * ST's message-edit completion handler returns the `messageEditDone()` promise;
 * a plain DOM dispatch discards it and would release ChatUI's host queue before
 * the durable save finishes.
 *
 * saveMessageEditById() funnels through the single serialized host-operation
 * queue (see store/host-operation-queue.ts), so this must never resolve into a
 * permanently-pending promise: that would wedge the queue for every future host
 * operation with no diagnostics. Every path below either resolves/rejects with
 * the real outcome or rejects with a descriptive Error — the queue already
 * isolates a rejected task from the next queued one, so surfacing the failure
 * is strictly safer than failing open.
 */
export function _dispatchClickAndWait(button: HTMLElement, timeoutMs = 15000): Promise<unknown> {
    if (typeof window.$ !== 'function' || typeof window.$.Event !== 'function') {
        throw new Error('[ChatUI/adapter] jQuery event completion is unavailable');
    }
    const event = window.$.Event('click');
    window.$(button).trigger(event);
    const result = event.result;
    if (!result || typeof result.then !== 'function') {
        const context = _describeButton(button);
        console.error(
            '[ChatUI/adapter] delegated click handler returned no awaitable result; the host-operation queue would hang forever without this diagnostic',
            context,
        );
        return Promise.reject(new Error(
            `[ChatUI/adapter] delegated click handler for <${context.tag} id="${context.id}"> did not return an awaitable result`,
        ));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            const context = _describeButton(button);
            console.error(
                `[ChatUI/adapter] delegated click handler did not settle within ${timeoutMs}ms`,
                context,
            );
            reject(new Error(
                `[ChatUI/adapter] delegated click handler for <${context.tag} id="${context.id}"> timed out after ${timeoutMs}ms`,
            ));
        }, timeoutMs);

        Promise.resolve(result).then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function _isHiddenLiveElement(element: HTMLElement) {
    return element.classList.contains('qr--hidden')
        || element.classList.contains('displayNone')
        || window.getComputedStyle(element).display === 'none';
}

// Purely positional ids (`${idPrefix}-${seq}`) collide across rebuilds: ST
// rebuilds these containers on chat/set change, cache.clear() empties the
// map, and the very next rebuild hands out the exact same strings again for
// whatever now sits at each position — so an id captured before the rebuild
// can silently resolve to a *different* live element after it. Stamping a
// per-registry-rebuild generation into every id (see buildLiveElementRegistry
// below) makes a stale id's string permanently disjoint from the current
// key space; resolveLiveElement() below is the single place that enforces
// it, so every trigger path fails closed instead of guessing.
const _registryGenerations = new WeakMap<Map<string, HTMLElement>, number>();

const _LIVE_ELEMENT_ID_GENERATION = /-(\d+)-\d+$/;

function _parseLiveElementIdGeneration(id: string): number | null {
    const match = _LIVE_ELEMENT_ID_GENERATION.exec(id);
    return match ? Number(match[1]) : null;
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
    // Bump unconditionally (including the `!container` early-return below) —
    // going from "had items" to "container gone" is still a rebuild that must
    // retire every id from the previous call.
    const generation = (_registryGenerations.get(cache) ?? 0) + 1;
    _registryGenerations.set(cache, generation);
    if (!container) return [];

    const out: T[] = [];
    let seq = 0;
    for (const candidate of elements(container)) {
        if (!(candidate instanceof HTMLElement)) continue;
        if (_isHiddenLiveElement(candidate)) continue;
        if (isHidden?.(candidate)) continue;

        const id = `${idPrefix}-${generation}-${seq++}`;
        cache.set(id, candidate);
        out.push(toDto(candidate, id));
    }
    return out;
}

/**
 * Resolve a live-element id from buildLiveElementRegistry(), fail-closed.
 * Trigger paths (menu.ts triggerWandItem, qr.ts triggerQuickReply) must call
 * this instead of reading their cache Map directly: it is the single place
 * that rejects an id from a stale rebuild (generation mismatch — the cache
 * key space has moved on, whether or not the string happens to still be
 * present) and an id whose element has since been detached from the document
 * without a rebuild (e.g. removed by other host code before the registry's
 * next rebuild). A stale id must never resolve to a different live element.
 */
export function resolveLiveElement(cache: Map<string, HTMLElement>, id: string): HTMLElement | null {
    const currentGeneration = _registryGenerations.get(cache) ?? null;
    const idGeneration = _parseLiveElementIdGeneration(id);
    if (currentGeneration === null || idGeneration === null || idGeneration !== currentGeneration) {
        console.error(
            '[ChatUI/adapter] rejected stale live-element id (registry has since rebuilt)',
            { id, idGeneration, currentGeneration },
        );
        return null;
    }

    const element = cache.get(id);
    if (!element) {
        console.error('[ChatUI/adapter] live-element id not found in its own generation\'s registry', { id });
        return null;
    }
    if (!element.isConnected) {
        console.error('[ChatUI/adapter] live-element id resolved to a detached element', { id });
        return null;
    }
    return element;
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

export type CurrentMessageIndexSnapshotDto = Readonly<{
    chatKey: string;
    messages: ReadonlyArray<MessageIndexSnapshotDto>;
}>;

/** Scan the active chat into cheap immutable list/floor metadata. */
export function getCurrentMessageIndexSnapshots(): CurrentMessageIndexSnapshotDto {
    const ctx = getContext();
    const rawMessages = Array.isArray(ctx.chat) ? ctx.chat : [];
    const messages = Object.freeze(rawMessages.map((message: unknown, id: number) => (
        projectMessageIndexSnapshot(message, id)
    )));

    return Object.freeze({
        chatKey: _getCurrentChatKeyFromContext(ctx),
        messages,
    });
}

/** O(1) light-index read for message invalidation. */
export function getCurrentMessageIndexSnapshotById(
    messageId: number | string,
): MessageIndexSnapshotDto | null {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) return null;
    const rawMessages = getCurrentChat();
    return id < rawMessages.length ? projectMessageIndexSnapshot(rawMessages[id], id) : null;
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
