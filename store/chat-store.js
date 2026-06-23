/**
 * SillyTavern-ChatUI · chat store
 *
 * Lightweight view-model store.
 * Owns ChatUI-facing message DTOs so UI modules do not need to read raw ST
 * chat objects directly.
 */

import { chatuiAdapter, stEventKeys } from '../adapter/st-adapter.js';

/**
 * @typedef {object} ChatuiMessageDto
 * @property {number} id
 * @property {string} key
 * @property {'user'|'character'|'system'} role
 * @property {boolean} isUser
 * @property {boolean} isSystem
 * @property {boolean} isChar
 * @property {string} name
 * @property {string} text
 * @property {string} displayText
 * @property {string} html
 * @property {string|number|null} sendDate
 * @property {boolean} forceAvatar
 * @property {string} forceAvatarSrc
 * @property {{ id: number, count: number, hasMultiple: boolean, label: string }} swipe
 * @property {{ display: string, inline: boolean, mediaIndex: number, media: Array<{ id: string, type: string, url: string, title: string, source: string, index: number }>, files: Array<{ id: string, name: string, url: string, size: number|null, type: string, index: number }> }} attachments
 * @property {{ type: string, isSmallSys: boolean, isToolCall: boolean, bookmarkLink: string, tokenCount: number|null, reasoning: string, reasoningHtml: string, reasoningDuration: number|string|null }} extra
 * @property {{ isLast: boolean, canShowCharActions: boolean, canShowUserMenu: boolean, canShowSwipe: boolean, needsGenerate: boolean }} ui
 */

/** @type {{ chat: { messages: Array<ChatuiMessageDto>, byId: Record<string, ChatuiMessageDto>, lastMessageId: number|null, isGroup: boolean, isGenerating: boolean, lastMessageNeedsGenerate: boolean }, ui: object }} */
let _state = {
    chat: {
        messages: [],
        byId: {},
        lastMessageId: null,
        isGroup: false,
        isGenerating: false,
        lastMessageNeedsGenerate: false,
    },
    ui: {
        openMessageMenuId: null,
        openPlusMenu: false,
    },
};

/** @type {Set<Function>} */
const _subscribers = new Set();

/** @type {Array<() => void>} */
let _unsubscribers = [];

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
 * @param {object} raw
 * @param {number} id
 * @param {number} lastMessageId
 * @returns {ChatuiMessageDto}
 */
function _toMessageDto(raw, id, lastMessageId) {
    const message = /** @type {Record<string, any>} */ (raw ?? {});
    const extra = /** @type {Record<string, any>} */ (message.extra ?? {});
    const isUser = message.is_user === true;
    const isSystem = message.is_system === true;
    const isChar = !isUser && !isSystem;
    const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    const swipeCount = Array.isArray(message.swipes) ? message.swipes.length : 0;
    const hasMultipleSwipes = swipeCount > 1;
    const role = isUser ? 'user' : (isSystem ? 'system' : 'character');
    const isLast = id === lastMessageId;
    const isSmallSys = extra.isSmallSys === true;
    const isToolCall = Array.isArray(extra.tool_invocations);
    const attachments = chatuiAdapter.mediaActions.getMessageAttachments(message);

    return {
        id,
        key: String(id),
        role,
        isUser,
        isSystem,
        isChar,
        name: _string(message.name),
        text: _string(message.mes),
        displayText: _string(extra.display_text) || _string(message.mes),
        html: chatuiAdapter.formatMessageHtml(message, id, false),
        sendDate: message.send_date ?? null,
        forceAvatar: Boolean(message.force_avatar),
        forceAvatarSrc: _string(message.force_avatar),
        swipe: {
            id: swipeId,
            count: swipeCount,
            hasMultiple: hasMultipleSwipes,
            label: hasMultipleSwipes ? `${swipeId + 1}​/​${swipeCount}` : '',
        },
        attachments,
        extra: {
            type: _string(extra.type),
            isSmallSys,
            isToolCall,
            bookmarkLink: _string(extra.bookmark_link),
            tokenCount: _numberOrNull(extra.token_count),
            reasoning: _string(extra.reasoning),
            reasoningHtml: chatuiAdapter.formatMessageHtml(message, id, true),
            reasoningDuration: extra.reasoning_duration ?? null,
        },
        ui: {
            isLast,
            canShowCharActions: isChar && !isSmallSys && !isToolCall,
            canShowUserMenu: isUser && !isSmallSys && !isToolCall,
            canShowSwipe: isLast && isChar && hasMultipleSwipes,
            needsGenerate: isLast && (isUser || isSystem),
        },
    };
}

/**
 * @param {Array<object>} rawMessages
 * @returns {{ messages: Array<ChatuiMessageDto>, byId: Record<string, ChatuiMessageDto>, lastMessageId: number|null, lastMessageNeedsGenerate: boolean }}
 */
function _buildMessageDtos(rawMessages) {
    const lastMessageId = rawMessages.length ? rawMessages.length - 1 : null;
    const byId = {};
    const messages = rawMessages.map((message, id) => {
        const dto = _toMessageDto(message, id, lastMessageId ?? -1);
        byId[dto.key] = dto;
        return dto;
    });
    const lastDto = lastMessageId === null ? null : byId[String(lastMessageId)];

    return {
        messages,
        byId,
        lastMessageId,
        lastMessageNeedsGenerate: lastDto?.ui.needsGenerate ?? false,
    };
}

/**
 * @returns {typeof _state}
 */
export function getChatuiState() {
    return _state;
}

/**
 * @returns {Array<ChatuiMessageDto>}
 */
export function getMessageDtos() {
    return _state.chat.messages;
}

/**
 * @param {number|string} messageId
 * @returns {ChatuiMessageDto|null}
 */
export function getMessageDtoById(messageId) {
    return _state.chat.byId[String(messageId)] ?? null;
}

/**
 * @returns {ChatuiMessageDto|null}
 */
export function getLastMessageDto() {
    return _state.chat.lastMessageId === null
        ? null
        : getMessageDtoById(_state.chat.lastMessageId);
}

/**
 * @param {Element} mesEl
 * @returns {ChatuiMessageDto|null}
 */
export function getMessageDtoByElement(mesEl) {
    const messageId = mesEl.getAttribute('mesid');
    return messageId === null ? null : getMessageDtoById(messageId);
}

/**
 * @param {Function} subscriber
 * @returns {() => void}
 */
export function subscribeChatuiStore(subscriber) {
    _subscribers.add(subscriber);
    return () => _subscribers.delete(subscriber);
}

/**
 * @returns {void}
 */
function _emit() {
    for (const subscriber of _subscribers) {
        subscriber(_state);
    }
}

/**
 * @returns {void}
 */
export function refreshChatuiStore() {
    const rawMessages = chatuiAdapter.getCurrentChat();
    const messageState = _buildMessageDtos(rawMessages);

    _state = {
        ..._state,
        chat: {
            messages: messageState.messages,
            byId: messageState.byId,
            lastMessageId: messageState.lastMessageId,
            isGroup: chatuiAdapter.getIsGroupChat(),
            isGenerating: chatuiAdapter.getGenerationState().isGenerating,
            lastMessageNeedsGenerate: messageState.lastMessageNeedsGenerate,
        },
    };
    _emit();
}

/**
 * @returns {void}
 */
export function initChatuiStore() {
    if (_unsubscribers.length) return;

    refreshChatuiStore();

    const refreshNow = () => refreshChatuiStore();
    const refreshSoon = () => setTimeout(() => refreshChatuiStore(), 0);
    _unsubscribers = [
        chatuiAdapter.subscribe(stEventKeys.CHAT_CHANGED, refreshSoon),
        chatuiAdapter.subscribe(stEventKeys.CHAT_LOADED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.MORE_MESSAGES_LOADED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.MESSAGE_SENT, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.MESSAGE_UPDATED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.MESSAGE_SWIPED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.CHARACTER_MESSAGE_RENDERED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.USER_MESSAGE_RENDERED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.GENERATION_STARTED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.GENERATION_STOPPED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.GENERATION_ENDED, refreshNow),
    ];
}

/**
 * @returns {void}
 */
export function teardownChatuiStore() {
    for (const unsubscribe of _unsubscribers) {
        unsubscribe();
    }
    _unsubscribers = [];
    _subscribers.clear();
}
