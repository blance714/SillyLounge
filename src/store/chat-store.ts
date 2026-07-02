/**
 * SillyTavern-ChatUI · chat store
 *
 * Lightweight view-model store.
 * Owns ChatUI-facing message DTOs so UI modules do not need to read raw ST
 * chat objects directly.
 */

import { chatuiAdapter, stEventKeys } from '../adapter/st-adapter.js';
import { numberOrNull, stringValue } from '../adapter/schema.js';
import { createStore } from './create-store.js';
import { clearTempChat, getTempChat } from './temp-chat-store.js';

export type ChatuiMediaAttachment = {
    id: string;
    type: string;
    url: string;
    title: string;
    source: string;
    index: number;
};

export type ChatuiFileAttachment = {
    id: string;
    name: string;
    url: string;
    size: number | null;
    type: string;
    index: number;
};

export type ChatuiMessageDto = {
    id: number;
    key: string;
    role: 'user' | 'character' | 'system';
    isUser: boolean;
    isSystem: boolean;
    isChar: boolean;
    name: string;
    text: string;
    displayText: string;
    html: string;
    sendDate: string | number | null;
    forceAvatar: boolean;
    forceAvatarSrc: string;
    swipe: { id: number; count: number; hasMultiple: boolean; label: string };
    attachments: {
        display: string;
        inline: boolean;
        mediaIndex: number;
        media: ChatuiMediaAttachment[];
        files: ChatuiFileAttachment[];
    };
    extra: {
        type: string;
        isSmallSys: boolean;
        isToolCall: boolean;
        bookmarkLink: string;
        tokenCount: number | null;
        reasoning: string;
        reasoningHtml: string;
        reasoningDuration: number | string | null;
    };
    ui: {
        isLast: boolean;
        canShowCharActions: boolean;
        canShowUserMenu: boolean;
        canShowSwipe: boolean;
        needsGenerate: boolean;
    };
};

export type ChatuiChatIdentity = {
    avatar: string;
    fileName: string;
};

export type ChatuiStoreState = {
    chat: {
        messages: ChatuiMessageDto[];
        byId: Record<string, ChatuiMessageDto>;
        lastMessageId: number | null;
        chatKey: string;
        currentChat: ChatuiChatIdentity | null;
        isGroup: boolean;
        isGenerating: boolean;
        lastMessageNeedsGenerate: boolean;
    };
    ui: {
        openMessageMenuId: number | string | null;
        openPlusMenu: boolean;
    };
};

const _initialState: ChatuiStoreState = {
    chat: {
        messages: [],
        byId: {},
        lastMessageId: null,
        chatKey: '',
        currentChat: null,
        isGroup: false,
        isGenerating: false,
        lastMessageNeedsGenerate: false,
    },
    ui: {
        openMessageMenuId: null,
        openPlusMenu: false,
    },
};

const _store = createStore<ChatuiStoreState>(_initialState);

const _storeUnsubscribers = new Set<() => void>();

let _unsubscribers: Array<() => void> = [];

/** @type {number} Pending requestAnimationFrame id for coalesced streaming refreshes. */
let _streamFrame = 0;

/**
 * @param {object} raw
 * @param {number} id
 * @param {number} lastMessageId
 * @returns {ChatuiMessageDto}
 */
function _toMessageDto(raw: Record<string, any>, id: number, lastMessageId: number): ChatuiMessageDto {
    const message = raw ?? {};
    const extra = (message.extra ?? {}) as Record<string, any>;
    const isUser = message.is_user === true;
    const isSystem = message.is_system === true;
    const isChar = !isUser && !isSystem;
    const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    const swipeCount = Array.isArray(message.swipes) ? message.swipes.length : 0;
    const hasMultipleSwipes = swipeCount > 1;
    const role: ChatuiMessageDto['role'] = isUser ? 'user' : (isSystem ? 'system' : 'character');
    const isLast = id === lastMessageId;
    const isSmallSys = extra.isSmallSys === true;
    const isToolCall = Array.isArray(extra.tool_invocations);
    const attachments = chatuiAdapter.mediaActions.getMessageAttachments(message);
    const reasoningText = stringValue(extra.reasoning_display_text) || stringValue(extra.reasoning);

    return {
        id,
        key: String(id),
        role,
        isUser,
        isSystem,
        isChar,
        name: stringValue(message.name),
        text: stringValue(message.mes),
        displayText: stringValue(extra.display_text) || stringValue(message.mes),
        html: chatuiAdapter.formatMessageHtml(message, id, false),
        sendDate: message.send_date ?? null,
        forceAvatar: Boolean(message.force_avatar),
        forceAvatarSrc: stringValue(message.force_avatar),
        swipe: {
            id: swipeId,
            count: swipeCount,
            hasMultiple: hasMultipleSwipes,
            label: hasMultipleSwipes ? `${swipeId + 1}​/​${swipeCount}` : '',
        },
        attachments,
        extra: {
            type: stringValue(extra.type),
            isSmallSys,
            isToolCall,
            bookmarkLink: stringValue(extra.bookmark_link),
            tokenCount: numberOrNull(extra.token_count),
            reasoning: stringValue(extra.reasoning),
            reasoningHtml: reasoningText ? chatuiAdapter.formatMessageHtml(message, id, true) : '',
            reasoningDuration: extra.reasoning_duration ?? null,
        },
        ui: {
            isLast,
            canShowCharActions: isChar && !isSmallSys && !isToolCall,
            canShowUserMenu: isUser && !isSmallSys && !isToolCall,
            // Show swipe controls on the last character message even with a
            // single swipe, so the user can generate alternatives (the ‹›/counter
            // visibility within the group is decided per-button in the UI).
            canShowSwipe: isLast && isChar && !isSmallSys && !isToolCall,
            // Only a trailing USER message offers a one-click generate. A trailing
            // system message is excluded on purpose: ST's solo regenerate pops it
            // instead of generating after it, and small-sys notices are hidden from
            // the list anyway — so isUser keeps the pill from firing with no
            // visible trigger or silently deleting a message.
            needsGenerate: isLast && isUser,
        },
    };
}

/**
 * @param {Array<object>} rawMessages
 * @returns {{ messages: Array<ChatuiMessageDto>, byId: Record<string, ChatuiMessageDto>, lastMessageId: number|null, lastMessageNeedsGenerate: boolean }}
 */
function _buildMessageDtos(rawMessages: Array<Record<string, any>>): {
    messages: ChatuiMessageDto[];
    byId: Record<string, ChatuiMessageDto>;
    lastMessageId: number | null;
    lastMessageNeedsGenerate: boolean;
} {
    const lastMessageId = rawMessages.length ? rawMessages.length - 1 : null;
    const byId: Record<string, ChatuiMessageDto> = {};
    const messages = rawMessages.map((message: Record<string, any>, id: number) => {
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
 * @returns {typeof _initialState}
 */
export function getChatuiState(): ChatuiStoreState {
    return _store.getState();
}

export function getChatuiCurrentChatIdentity() {
    return chatuiAdapter.getCurrentChatIdentity();
}

/**
 * @returns {Array<ChatuiMessageDto>}
 */
export function getMessageDtos() {
    return getChatuiState().chat.messages;
}

/**
 * @param {number|string} messageId
 * @returns {ChatuiMessageDto|null}
 */
export function getMessageDtoById(messageId: number | string) {
    return getChatuiState().chat.byId[String(messageId)] ?? null;
}

/**
 * @returns {ChatuiMessageDto|null}
 */
export function getLastMessageDto() {
    const state = getChatuiState();
    return state.chat.lastMessageId === null
        ? null
        : getMessageDtoById(state.chat.lastMessageId);
}

/**
 * @param {Element} mesEl
 * @returns {ChatuiMessageDto|null}
 */
export function getMessageDtoByElement(mesEl: Element) {
    const messageId = mesEl.getAttribute('mesid');
    return messageId === null ? null : getMessageDtoById(messageId);
}

/**
 * @param {Function} subscriber
 * @returns {() => void}
 */
export function subscribeChatuiStore(subscriber: (state: ChatuiStoreState) => void) {
    const unsubscribe = _store.subscribe(subscriber);
    _storeUnsubscribers.add(unsubscribe);
    return () => {
        _storeUnsubscribers.delete(unsubscribe);
        unsubscribe();
    };
}

/**
 * @returns {void}
 */
export function refreshChatuiStore() {
    const rawMessages = chatuiAdapter.getCurrentChat();
    const messageState = _buildMessageDtos(rawMessages);
    const state = getChatuiState();
    const isGroup = chatuiAdapter.getIsGroupChat();

    _store.setState({
        ...state,
        chat: {
            messages: messageState.messages,
            byId: messageState.byId,
            lastMessageId: messageState.lastMessageId,
            chatKey: chatuiAdapter.getCurrentChatKey(),
            currentChat: chatuiAdapter.getCurrentChatIdentity(),
            isGroup,
            isGenerating: chatuiAdapter.getGenerationState().isGenerating,
            lastMessageNeedsGenerate: messageState.lastMessageNeedsGenerate,
        },
    });
}

/**
 * Rebuild a single message DTO in place. Falls back to a full rebuild when the
 * chat length changed (append/delete) or the id is out of range, so derived
 * fields (isLast / lastMessageId) stay correct. Keeps streaming, edit, and
 * swipe updates O(1) instead of reformatting the whole chat.
 *
 * @param {number|string} messageId
 * @returns {void}
 */
export function refreshChatuiMessage(messageId: number | string) {
    const id = Number(messageId);
    const rawMessages = chatuiAdapter.getCurrentChat();
    const state = getChatuiState();

    if (
        !Number.isFinite(id)
        || id < 0
        || id >= rawMessages.length
        || rawMessages.length !== state.chat.messages.length
    ) {
        refreshChatuiStore();
        return;
    }

    const lastMessageId = rawMessages.length - 1;
    const dto = _toMessageDto(rawMessages[id], id, lastMessageId);
    const messages = state.chat.messages.slice();
    messages[id] = dto;
    const byId = { ...state.chat.byId, [dto.key]: dto };
    const lastDto = byId[String(lastMessageId)] ?? null;

    _store.setState({
        ...state,
        chat: {
            ...state.chat,
            messages,
            byId,
            lastMessageNeedsGenerate: lastDto?.ui.needsGenerate ?? false,
        },
    });
}

/**
 * @returns {void}
 */
function _clearTempChatIfCurrent() {
    const current = chatuiAdapter.getCurrentChatIdentity();
    const tempChat = getTempChat();
    if (current && tempChat && current.avatar === tempChat.avatar && current.fileName === tempChat.fileName) {
        clearTempChat();
    }
}

/**
 * Coalesce the per-token STREAM_TOKEN_RECEIVED burst into at most one
 * last-message refresh per animation frame, so streamed text renders live in
 * the ChatUI surface without a full-chat rebuild per token.
 *
 * @returns {void}
 */
function _scheduleStreamRefresh() {
    if (_streamFrame) return;
    _streamFrame = requestAnimationFrame(() => {
        _streamFrame = 0;
        const rawMessages = chatuiAdapter.getCurrentChat();
        if (rawMessages.length) refreshChatuiMessage(rawMessages.length - 1);
    });
}

/**
 * @returns {void}
 */
export function initChatuiStore() {
    if (_unsubscribers.length) return;

    refreshChatuiStore();

    const refreshNow = () => refreshChatuiStore();
    const refreshSoon = () => setTimeout(() => refreshChatuiStore(), 0);
    const refreshMessage = (messageId: number | string) => refreshChatuiMessage(messageId);
    const refreshSentMessage = (messageId: number | string) => {
        _clearTempChatIfCurrent();
        refreshChatuiMessage(messageId);
    };
    const refreshUpdatedMessage = (messageId: number | string) => {
        _clearTempChatIfCurrent();
        refreshChatuiMessage(messageId);
    };
    _unsubscribers = [
        chatuiAdapter.subscribe(stEventKeys.CHAT_CHANGED, refreshSoon),
        chatuiAdapter.subscribe(stEventKeys.CHAT_LOADED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.MORE_MESSAGES_LOADED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.MESSAGE_SENT, refreshSentMessage),
        chatuiAdapter.subscribe(stEventKeys.MESSAGE_UPDATED, refreshUpdatedMessage),
        chatuiAdapter.subscribe(stEventKeys.MESSAGE_SWIPED, refreshMessage),
        chatuiAdapter.subscribe(stEventKeys.MESSAGE_DELETED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.CHARACTER_MESSAGE_RENDERED, refreshMessage),
        chatuiAdapter.subscribe(stEventKeys.USER_MESSAGE_RENDERED, refreshMessage),
        chatuiAdapter.subscribe(stEventKeys.STREAM_TOKEN_RECEIVED, _scheduleStreamRefresh),
        chatuiAdapter.subscribe(stEventKeys.GENERATION_STARTED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.GENERATION_STOPPED, refreshNow),
        chatuiAdapter.subscribe(stEventKeys.GENERATION_ENDED, refreshNow),
    ];
}

/**
 * @returns {void}
 */
export function teardownChatuiStore() {
    if (_streamFrame) {
        cancelAnimationFrame(_streamFrame);
        _streamFrame = 0;
    }
    for (const unsubscribe of _unsubscribers) {
        unsubscribe();
    }
    _unsubscribers = [];
    for (const unsubscribe of _storeUnsubscribers) {
        unsubscribe();
    }
    _storeUnsubscribers.clear();
}
