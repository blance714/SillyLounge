/**
 * SillyTavern-ChatUI · chat store
 *
 * Lightweight view-model store.
 * Owns ChatUI-facing message DTOs so UI modules do not need to read raw ST
 * chat objects directly.
 */

import { chatuiAdapter, stEventKeys } from '../adapter/st-adapter.js';
import {
    createCharacterChatKey,
    createConversationLocator,
    createGroupChatKey,
} from '../adapter/chat-key.js';
import type { MessageSnapshotDto } from '../adapter/schema.js';
import { createStore } from './create-store.js';
import {
    clearTempChat,
    getTempChat,
    getTempChatSnapshot,
    markTempChatActive,
    moveTempChatIfMatches,
    moveTempChatsForCharacter,
    subscribeTempChatStore,
} from './temp-chat-store.js';
import { shouldAdoptTempChatOnGenerationStart } from './temp-chat-navigation.js';
import {
    moveComposerDraft,
    moveComposerDraftCharacterScope,
} from './composer-draft-store.js';

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
    chatKey: string;
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
        /** Visible message ids; message DTOs live in a granular per-id store. */
        messageIds: number[];
        messageCount: number;
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
        messageIds: [],
        messageCount: 0,
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
const _messageSubscribers = new Map<number, Set<() => void>>();
const _messageChangeSubscribers = new Set<() => void>();
let _messageDtos = new Map<number, ChatuiMessageDto>();

let _unsubscribers: Array<() => void> = [];
let _isInitializing = false;
let _isInitialized = false;
const _deferredRefreshes = new Set<ReturnType<typeof setTimeout>>();

/** @type {number} Pending requestAnimationFrame id for coalesced streaming refreshes. */
let _streamFrame = 0;

type FormatHtmlCacheEntry = {
    text: string;
    name: string;
    isSystem: boolean;
    isUser: boolean;
    usesSystemUi: boolean;
    html: string;
};

/**
 * Keyed by `${chatKey}:${id}:${isReasoning}`. ST's own formatter re-resolves
 * non-deterministic macros (e.g. `{{random::a,b}}`) on every call, so calling
 * it again for a message whose relevant fields haven't changed produces a
 * different-looking result for no reason — this cache makes reformatting
 * conditional on those fields actually changing, matching how ST's own
 * chat window only reprints a message when it has something new to show.
 */
const _formatHtmlCache = new Map<string, FormatHtmlCacheEntry>();
let _formatCacheChatKey = '';

function _prepareFormatCache(chatKey: string): void {
    if (_formatCacheChatKey === chatKey) return;
    _formatHtmlCache.clear();
    _formatCacheChatKey = chatKey;
}

/**
 * ST's formatter stays behind the adapter and reads the live message by id.
 * The store only compares normalized snapshot fields to decide whether that
 * native formatter needs to run again.
 */
function _formatMessageHtmlCached(
    message: MessageSnapshotDto,
    chatKey: string,
    isReasoning: boolean,
): string {
    const text = isReasoning
        ? (message.reasoningDisplayText || message.reasoning)
        : message.displayText;
    const { name, isSystem, isUser, usesSystemUi } = message;

    const cacheKey = `${chatKey}:${message.id}:${isReasoning}`;
    const cached = _formatHtmlCache.get(cacheKey);
    if (
        cached
        && cached.text === text
        && cached.name === name
        && cached.isSystem === isSystem
        && cached.isUser === isUser
        && cached.usesSystemUi === usesSystemUi
    ) {
        return cached.html;
    }

    const html = chatuiAdapter.messageQueries.formatHtmlById(message.id, isReasoning);
    _formatHtmlCache.set(cacheKey, { text, name, isSystem, isUser, usesSystemUi, html });
    return html;
}

/**
 * Boundary DTO -> ChatUI view-model projection. Native HTML formatting and
 * attachment reads remain explicit adapter capabilities.
 */
function _projectChatuiMessage(
    message: MessageSnapshotDto,
    lastMessageId: number,
    chatKey: string,
): ChatuiMessageDto {
    const { id, isUser, isSystem } = message;
    const isChar = !isUser && !isSystem;
    const swipeId = message.swipeId;
    const swipeCount = message.swipeCount;
    const hasMultipleSwipes = swipeCount > 1;
    const role: ChatuiMessageDto['role'] = isUser ? 'user' : (isSystem ? 'system' : 'character');
    const isLast = id === lastMessageId;
    const { isSmallSys, isToolCall } = message;
    const attachments = chatuiAdapter.messageQueries.getAttachmentsById(id);
    const reasoningText = message.reasoningDisplayText || message.reasoning;

    return {
        id,
        key: String(id),
        chatKey,
        role,
        isUser,
        isSystem,
        isChar,
        name: message.name,
        text: message.text,
        displayText: message.displayText,
        html: _formatMessageHtmlCached(message, chatKey, false),
        sendDate: message.sendDate,
        forceAvatar: message.forceAvatar,
        forceAvatarSrc: message.forceAvatarSrc,
        swipe: {
            id: swipeId,
            count: swipeCount,
            hasMultiple: hasMultipleSwipes,
            label: hasMultipleSwipes ? `${swipeId + 1}​/​${swipeCount}` : '',
        },
        attachments,
        extra: {
            type: message.type,
            isSmallSys,
            isToolCall,
            bookmarkLink: message.bookmarkLink,
            tokenCount: message.tokenCount,
            reasoning: message.reasoning,
            reasoningHtml: reasoningText ? _formatMessageHtmlCached(message, chatKey, true) : '',
            reasoningDuration: message.reasoningDuration,
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
 * @param snapshots Parsed adapter-boundary messages.
 * @param chatKey Active chat namespace for formatter memoization.
 */
function _buildMessageDtos(snapshots: ReadonlyArray<MessageSnapshotDto>, chatKey: string): {
    messagesById: Map<number, ChatuiMessageDto>;
    visibleMessageIds: number[];
    lastMessageId: number | null;
    lastMessageNeedsGenerate: boolean;
} {
    const lastMessageId = snapshots.length ? snapshots.length - 1 : null;
    const messagesById = new Map<number, ChatuiMessageDto>();
    const visibleMessageIds: number[] = [];
    for (const message of snapshots) {
        const dto = _projectChatuiMessage(message, lastMessageId ?? -1, chatKey);
        messagesById.set(dto.id, dto);
        if (!dto.extra.isSmallSys && !dto.extra.isToolCall) visibleMessageIds.push(dto.id);
    }
    const lastDto = lastMessageId === null ? null : messagesById.get(lastMessageId);

    return {
        messagesById,
        visibleMessageIds,
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
    return Array.from(_messageDtos.values());
}

/**
 * @param {number|string} messageId
 * @returns {ChatuiMessageDto|null}
 */
export function getMessageDtoById(messageId: number | string) {
    const id = Number(messageId);
    return Number.isInteger(id) && id >= 0 ? _messageDtos.get(id) ?? null : null;
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

/** Subscribe to one message slot; streaming updates notify only the changed row. */
export function subscribeChatuiMessage(messageId: number, onStoreChange: () => void): () => void {
    let subscribers = _messageSubscribers.get(messageId);
    if (!subscribers) {
        subscribers = new Set();
        _messageSubscribers.set(messageId, subscribers);
    }
    subscribers.add(onStoreChange);
    return () => {
        subscribers?.delete(onStoreChange);
        if (subscribers?.size === 0) _messageSubscribers.delete(messageId);
    };
}

/** Subscribe to content changes without forcing the whole chat tree to render. */
export function subscribeChatuiMessageChanges(onMessageChange: () => void): () => void {
    _messageChangeSubscribers.add(onMessageChange);
    return () => _messageChangeSubscribers.delete(onMessageChange);
}

function _notifyMessage(messageId: number): void {
    for (const subscriber of _messageSubscribers.get(messageId) ?? []) subscriber();
    for (const subscriber of _messageChangeSubscribers) subscriber();
}

function _notifyAllMessages(): void {
    for (const subscribers of _messageSubscribers.values()) {
        for (const subscriber of subscribers) subscriber();
    }
    for (const subscriber of _messageChangeSubscribers) subscriber();
}

/**
 * @returns {void}
 */
export function refreshChatuiStore() {
    const snapshot = chatuiAdapter.messageQueries.readAll();
    _prepareFormatCache(snapshot.chatKey);
    const messageState = _buildMessageDtos(snapshot.messages, snapshot.chatKey);
    const state = getChatuiState();
    const isGroup = chatuiAdapter.getIsGroupChat();
    _messageDtos = messageState.messagesById;

    _store.setState({
        ...state,
        chat: {
            messageIds: messageState.visibleMessageIds,
            messageCount: snapshot.messages.length,
            lastMessageId: messageState.lastMessageId,
            chatKey: snapshot.chatKey,
            currentChat: chatuiAdapter.getCurrentChatIdentity(),
            isGroup,
            isGenerating: chatuiAdapter.getGenerationState().isGenerating,
            lastMessageNeedsGenerate: messageState.lastMessageNeedsGenerate,
        },
    });
    _notifyAllMessages();
}

/**
 * Rebuild one granular message slot. Falls back to a full rebuild when the
 * chat length changed (append/delete) or the id is out of range, so derived
 * fields (isLast / lastMessageId) stay correct. Keeps streaming, edit, and
 * swipe updates O(1): no full message-array clone, map spread, or parent chat
 * rerender occurs for an in-place token update.
 *
 * @param {number|string} messageId
 * @returns {void}
 */
export function refreshChatuiMessage(messageId: number | string) {
    const id = Number(messageId);
    const state = getChatuiState();
    const chatKey = chatuiAdapter.getCurrentChatKey();
    const messageCount = chatuiAdapter.messageQueries.getCount();

    if (
        !Number.isFinite(id)
        || !Number.isInteger(id)
        || id < 0
        || chatKey !== state.chat.chatKey
        || id >= messageCount
        || messageCount !== state.chat.messageCount
    ) {
        refreshChatuiStore();
        return;
    }

    const message = chatuiAdapter.messageQueries.readById(id);
    if (!message) {
        refreshChatuiStore();
        return;
    }

    _prepareFormatCache(chatKey);
    const lastMessageId = messageCount - 1;
    const dto = _projectChatuiMessage(message, lastMessageId, chatKey);
    const previous = _messageDtos.get(id);
    const wasVisible = !!previous && !previous.extra.isSmallSys && !previous.extra.isToolCall;
    const isVisible = !dto.extra.isSmallSys && !dto.extra.isToolCall;
    if (wasVisible !== isVisible) {
        refreshChatuiStore();
        return;
    }

    _messageDtos.set(id, dto);
    const lastMessageNeedsGenerate = _messageDtos.get(lastMessageId)?.ui.needsGenerate ?? false;
    if (lastMessageNeedsGenerate !== state.chat.lastMessageNeedsGenerate) {
        _store.setState({
            ...state,
            chat: { ...state.chat, lastMessageNeedsGenerate },
        });
    }
    _notifyMessage(id);
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

function _stripChatExt(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\.jsonl$/i, '') : '';
}

let _pendingChatLoadTransition: Readonly<{ oldChatKey: string; newChatKey: string }> | null = null;
let _chatLoadTransitionVersion = 0;

/**
 * Native character rename reloads the newly named chat before CHAT_RENAMED.
 * Capture that exact load transition so the later event can still prove which
 * old conversation was active, including a server-sanitized destination.
 */
function _refreshAfterChatLoaded(): void {
    const oldChatKey = getChatuiState().chat.chatKey;
    refreshChatuiStore();
    const newChatKey = getChatuiState().chat.chatKey;
    if (oldChatKey && newChatKey && oldChatKey !== newChatKey) {
        if (
            _pendingChatLoadTransition?.oldChatKey !== oldChatKey
            || _pendingChatLoadTransition.newChatKey !== newChatKey
        ) {
            _pendingChatLoadTransition = { oldChatKey, newChatKey };
            _chatLoadTransitionVersion += 1;
        }
    }
}

/** Capture the transition before a later async CHAT_CHANGED listener can yield. */
function _handleChatChanged(): void {
    const oldChatKey = getChatuiState().chat.chatKey;
    const newChatKey = chatuiAdapter.getCurrentChatKey();
    const current = chatuiAdapter.getCurrentChatIdentity();
    if (current) markTempChatActive(current.avatar, current.fileName);
    _pendingChatLoadTransition = oldChatKey && newChatKey && oldChatKey !== newChatKey
        ? { oldChatKey, newChatKey }
        : null;
    _chatLoadTransitionVersion += 1;
    _scheduleDeferredRefresh();
}

/** Expire an ordinary-navigation transition after the full host event completes. */
function _scheduleChatLoadTransitionExpiry(): void {
    const version = _chatLoadTransitionVersion;
    if (!_pendingChatLoadTransition) return;
    const timer = setTimeout(() => {
        _deferredRefreshes.delete(timer);
        if (_chatLoadTransitionVersion !== version) return;
        _pendingChatLoadTransition = null;
        _chatLoadTransitionVersion += 1;
    }, 0);
    _deferredRefreshes.add(timer);
}

/** Re-key ChatUI-owned ephemeral state after a host or ChatUI filename rename. */
function _migrateRenamedChatState(eventData: unknown): void {
    if (!eventData || typeof eventData !== 'object' || Array.isArray(eventData)) return;
    const data = eventData as Record<string, unknown>;
    const avatar = typeof data.avatarId === 'string' ? data.avatarId : '';
    const groupId = data.groupId === undefined || data.groupId === null ? '' : String(data.groupId);
    const oldFileName = _stripChatExt(data.oldFileName);
    const eventNewFileName = _stripChatExt(data.newFileName);
    if ((!avatar && !groupId) || !oldFileName || !eventNewFileName) return;

    const oldLocator = createConversationLocator(oldFileName);
    const oldChatKey = groupId
        ? createGroupChatKey(groupId, oldLocator)
        : createCharacterChatKey(avatar, oldLocator);
    const loadedTransition = _pendingChatLoadTransition?.oldChatKey === oldChatKey
        ? _pendingChatLoadTransition
        : null;
    _pendingChatLoadTransition = null;
    _chatLoadTransitionVersion += 1;
    // ChatUI's direct rename leaves the store at oldChatKey until this event.
    // Native character rename instead reloads first; loadedTransition preserves
    // the old→actual key pair across that event ordering. Renaming a non-active
    // history file must never migrate its draft into the current conversation.
    const currentChatKey = chatuiAdapter.getCurrentChatKey();
    const wasActiveTarget = getChatuiState().chat.chatKey === oldChatKey
        || loadedTransition?.oldChatKey === oldChatKey;
    // Non-active native ST rename events expose the unsanitized requested name,
    // not the server-confirmed filename. Do not guess and risk overwriting an
    // unrelated draft. ChatUI's own rename action migrates that case from its
    // checked HTTP result; an active native rename can use the live adapter key.
    if (!wasActiveTarget) return;
    const newChatKey = loadedTransition?.newChatKey || currentChatKey;
    if (!newChatKey || newChatKey === oldChatKey) return;

    moveComposerDraft(oldChatKey, newChatKey);
    const temp = getTempChatSnapshot();
    if (!groupId && temp.pointer?.avatar === avatar && temp.pointer.fileName === oldFileName) {
        const newFileName = wasActiveTarget
            ? chatuiAdapter.getCurrentChatIdentity()?.fileName || eventNewFileName
            : eventNewFileName;
        moveTempChatIfMatches(temp, { avatar, fileName: newFileName });
    }
}

function _migrateRenamedCharacterState(oldAvatar: unknown, newAvatar: unknown): void {
    if (typeof oldAvatar !== 'string' || typeof newAvatar !== 'string') return;
    if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
    moveComposerDraftCharacterScope(oldAvatar, newAvatar);
    moveTempChatsForCharacter(oldAvatar, newAvatar);
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
        if (!_isInitialized) return;
        const messageCount = chatuiAdapter.messageQueries.getCount();
        if (messageCount) refreshChatuiMessage(messageCount - 1);
    });
}

function _scheduleDeferredRefresh() {
    const timer = setTimeout(() => {
        _deferredRefreshes.delete(timer);
        if (_isInitialized) refreshChatuiStore();
    }, 0);
    _deferredRefreshes.add(timer);
}

function _clearDeferredRefreshes() {
    for (const timer of _deferredRefreshes) clearTimeout(timer);
    _deferredRefreshes.clear();
}

function _runUnsubscribers(unsubscribers: Array<() => void>, phase: string) {
    for (const unsubscribe of unsubscribers.reverse()) {
        try {
            unsubscribe();
        } catch (error) {
            console.error(`[ChatUI] ${phase} unsubscribe failed`, error);
        }
    }
}

/**
 * @returns {void}
 */
export function initChatuiStore() {
    if (_isInitialized || _isInitializing) return;

    _isInitializing = true;
    const registered: Array<() => void> = [];
    try {
        const current = chatuiAdapter.getCurrentChatIdentity();
        if (current) markTempChatActive(current.avatar, current.fileName);
        refreshChatuiStore();

        const refreshNow = () => refreshChatuiStore();
        const refreshMessage = (messageId: number | string) => refreshChatuiMessage(messageId);
        const refreshSentMessage = (messageId: number | string) => {
            _clearTempChatIfCurrent();
            refreshChatuiMessage(messageId);
        };
        const refreshUpdatedMessage = (messageId: number | string) => {
            _clearTempChatIfCurrent();
            refreshChatuiMessage(messageId);
        };
        const adoptAndRefreshMessage = (messageId: number | string) => {
            _clearTempChatIfCurrent();
            refreshChatuiMessage(messageId);
        };
        const adoptAndRefreshNow = () => {
            _clearTempChatIfCurrent();
            refreshChatuiStore();
        };
        const register = (key: string, handler: (...args: any[]) => void) => {
            registered.push(chatuiAdapter.subscribe(key, handler));
        };
        const registerFirst = (key: string, handler: (...args: any[]) => void) => {
            registered.push(chatuiAdapter.subscribeFirst(key, handler));
        };
        const registerLast = (key: string, handler: (...args: any[]) => void) => {
            registered.push(chatuiAdapter.subscribeLast(key, handler));
        };

        // Storage merges cannot inspect ST from the ST-free temp store. Rebind
        // any newly arrived lease that already matches this tab's loaded chat.
        registered.push(subscribeTempChatStore(() => {
            const loaded = chatuiAdapter.getCurrentChatIdentity();
            if (loaded) markTempChatActive(loaded.avatar, loaded.fileName);
        }));

        registerFirst(stEventKeys.CHAT_CHANGED, _handleChatChanged);
        registerLast(stEventKeys.CHAT_CHANGED, _scheduleChatLoadTransitionExpiry);
        // Consume the captured transition before async third-party listeners;
        // event order is part of the native rename correlation contract.
        registerFirst(stEventKeys.CHAT_RENAMED, (eventData: unknown) => {
            _migrateRenamedChatState(eventData);
            _scheduleDeferredRefresh();
        });
        register(stEventKeys.CHARACTER_RENAMED, (oldAvatar: unknown, newAvatar: unknown) => {
            _migrateRenamedCharacterState(oldAvatar, newAvatar);
            _scheduleDeferredRefresh();
        });
        registerFirst(stEventKeys.CHAT_LOADED, _refreshAfterChatLoaded);
        registerLast(stEventKeys.CHAT_LOADED, _scheduleChatLoadTransitionExpiry);
        register(stEventKeys.MORE_MESSAGES_LOADED, refreshNow);
        register(stEventKeys.MESSAGE_SENT, refreshSentMessage);
        register(stEventKeys.MESSAGE_UPDATED, refreshUpdatedMessage);
        register(stEventKeys.MESSAGE_EDITED, adoptAndRefreshMessage);
        register(stEventKeys.MESSAGE_SWIPED, adoptAndRefreshMessage);
        register(stEventKeys.MESSAGE_SWIPE_DELETED, adoptAndRefreshNow);
        register(stEventKeys.MESSAGE_DELETED, adoptAndRefreshNow);
        register(stEventKeys.MESSAGE_FILE_EMBEDDED, adoptAndRefreshMessage);
        register(stEventKeys.MESSAGE_REASONING_EDITED, adoptAndRefreshMessage);
        register(stEventKeys.MESSAGE_REASONING_DELETED, adoptAndRefreshMessage);
        register(stEventKeys.MESSAGE_RECEIVED, (_messageId: number | string, type: unknown) => {
            // ST emits `first_message` while constructing the untouched greeting.
            // Every other received message is user work and adopts the temp chat.
            if (type !== 'first_message') _clearTempChatIfCurrent();
        });
        register(stEventKeys.CHARACTER_MESSAGE_RENDERED, refreshMessage);
        register(stEventKeys.USER_MESSAGE_RENDERED, refreshMessage);
        register(stEventKeys.STREAM_TOKEN_RECEIVED, _scheduleStreamRefresh);
        register(stEventKeys.GENERATION_STARTED, (
            type: unknown,
            _params: unknown,
            isDryRun: unknown,
        ) => {
            if (shouldAdoptTempChatOnGenerationStart(type, isDryRun)) {
                _clearTempChatIfCurrent();
            }
            refreshChatuiStore();
        });
        register(stEventKeys.GENERATION_STOPPED, refreshNow);
        register(stEventKeys.GENERATION_ENDED, refreshNow);

        _unsubscribers = registered;
        _isInitialized = true;
    } catch (error) {
        _clearDeferredRefreshes();
        _runUnsubscribers(registered, 'store-init rollback');
        throw error;
    } finally {
        _isInitializing = false;
    }
}

/**
 * @returns {void}
 */
export function teardownChatuiStore() {
    _isInitialized = false;
    _isInitializing = false;

    if (_streamFrame) {
        cancelAnimationFrame(_streamFrame);
        _streamFrame = 0;
    }
    _clearDeferredRefreshes();
    _pendingChatLoadTransition = null;
    _chatLoadTransitionVersion += 1;

    const eventUnsubscribers = _unsubscribers;
    _unsubscribers = [];
    _runUnsubscribers(eventUnsubscribers, 'store teardown');

    const storeUnsubscribers = [..._storeUnsubscribers];
    _storeUnsubscribers.clear();
    _runUnsubscribers(storeUnsubscribers, 'store-listener teardown');

    _messageSubscribers.clear();
    _messageChangeSubscribers.clear();
    _messageDtos = new Map();

    _formatHtmlCache.clear();
    _formatCacheChatKey = '';
}
