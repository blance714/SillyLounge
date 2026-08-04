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
import type {
    MessageIndexSnapshotDto,
    MessageSnapshotDto,
} from '../adapter/schema.js';
import { createStore } from './create-store.js';
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
    /**
     * 1-based floor (楼) this message belongs to: the Nth user turn plus the
     * reply that answered it share floor N. `null` when the message belongs to
     * no floor at all — an opening greeting that precedes every user turn, a
     * system notice, or (in a group chat) the 2nd..Nth character reply inside
     * one turn, since a turn records only the first responder. The header
     * renders the floor segment only when this is a number, so "no defined
     * floor" stays visibly absent instead of being invented.
     */
    floorNumber: number | null;
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
        canShowSwipe: boolean;
        needsGenerate: boolean;
    };
};

export type ChatuiChatIdentity = {
    avatar: string;
    fileName: string;
};

export type ChatuiUserTurn = {
    userMessageId: number;
    responseMessageId: number | null;
};

export type ChatuiStoreState = {
    chat: {
        /** Visible message ids; full DTOs are materialized lazily per virtual row. */
        messageIds: number[];
        /** User-authored turns paired with their immediately following character reply. */
        userTurns: ChatuiUserTurn[];
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
        userTurns: [],
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
const MESSAGE_DTO_CACHE_LIMIT = 96;
const FORMAT_HTML_CACHE_LIMIT = 1024;
let _messageIndexes: ReadonlyArray<MessageIndexSnapshotDto> = [];
/**
 * messageId -> 1-based floor, derived from the same user-turn pass that feeds
 * the floor rail. It lives beside `_messageIndexes` rather than in store state
 * because it is index-derived data the lazy DTO projection reads, not something
 * the UI subscribes to: every path that can change floors (append, delete,
 * role flip) already funnels through `refreshChatuiStore`, which rebuilds both
 * this map and the DTO cache together. `refreshChatuiMessage` deliberately
 * cannot reach those cases — it bails out to a full rebuild first.
 */
let _floorNumbers: ReadonlyMap<number, number> = new Map();
let _messageDtos = new Map<number, ChatuiMessageDto>();
let _messageDtoBuildCount = 0;

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

function _setFormatCacheEntry(cacheKey: string, entry: FormatHtmlCacheEntry): void {
    _formatHtmlCache.delete(cacheKey);
    _formatHtmlCache.set(cacheKey, entry);
    while (_formatHtmlCache.size > FORMAT_HTML_CACHE_LIMIT) {
        const oldestKey = _formatHtmlCache.keys().next().value;
        if (oldestKey === undefined) break;
        _formatHtmlCache.delete(oldestKey);
    }
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
        _formatHtmlCache.delete(cacheKey);
        _formatHtmlCache.set(cacheKey, cached);
        return cached.html;
    }

    const html = chatuiAdapter.messageQueries.formatHtmlById(message.id, isReasoning);
    _setFormatCacheEntry(cacheKey, { text, name, isSystem, isUser, usesSystemUi, html });
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
    floorNumber: number | null,
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
        floorNumber,
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
 * Build all-history navigation metadata without reading or formatting message
 * bodies. Full ChatuiMessageDto instances are loaded separately on demand.
 */
function _buildMessageIndex(snapshots: ReadonlyArray<MessageIndexSnapshotDto>): {
    visibleMessageIds: number[];
    userTurns: ChatuiUserTurn[];
    floorNumbers: Map<number, number>;
    lastMessageId: number | null;
    lastMessageNeedsGenerate: boolean;
} {
    const lastMessageId = snapshots.length ? snapshots.length - 1 : null;
    const visibleMessageIds: number[] = [];
    for (const message of snapshots) {
        if (!message.isSmallSys && !message.isToolCall) visibleMessageIds.push(message.id);
    }
    const userTurns: ChatuiUserTurn[] = [];
    let pendingTurnIndex: number | null = null;
    for (const messageId of visibleMessageIds) {
        const message = snapshots[messageId];
        if (!message) continue;
        if (message.isUser) {
            userTurns.push({ userMessageId: messageId, responseMessageId: null });
            pendingTurnIndex = userTurns.length - 1;
            continue;
        }
        if (!message.isUser && !message.isSystem && pendingTurnIndex !== null) {
            userTurns[pendingTurnIndex] = {
                ...userTurns[pendingTurnIndex],
                responseMessageId: messageId,
            };
            pendingTurnIndex = null;
        }
    }
    // One floor per user turn, numbered the same way the floor rail numbers its
    // ticks (turn index + 1), so "第 N 楼" in a message header and "第 N 楼" in
    // the rail popover always name the same turn. Both members of the turn — the
    // user message and the reply it drew — carry that number; everything else
    // (greeting, system notice, extra group responders) stays unnumbered.
    const floorNumbers = new Map<number, number>();
    for (const [index, turn] of userTurns.entries()) {
        const floorNumber = index + 1;
        floorNumbers.set(turn.userMessageId, floorNumber);
        if (turn.responseMessageId !== null) floorNumbers.set(turn.responseMessageId, floorNumber);
    }
    const lastMessage = lastMessageId === null ? null : snapshots[lastMessageId];

    return {
        visibleMessageIds,
        userTurns,
        floorNumbers,
        lastMessageId,
        lastMessageNeedsGenerate: lastMessage?.isUser ?? false,
    };
}

function _pruneMessageDtoCache(): void {
    while (_messageDtos.size > MESSAGE_DTO_CACHE_LIMIT) {
        let removed = false;
        for (const messageId of _messageDtos.keys()) {
            if ((_messageSubscribers.get(messageId)?.size ?? 0) > 0) continue;
            _messageDtos.delete(messageId);
            removed = true;
            break;
        }
        if (!removed) break;
    }
}

function _cacheMessageDto(message: ChatuiMessageDto): ChatuiMessageDto {
    _messageDtos.delete(message.id);
    _messageDtos.set(message.id, message);
    _pruneMessageDtoCache();
    return message;
}

function _materializeMessageDto(messageId: number): ChatuiMessageDto | null {
    const cached = _messageDtos.get(messageId);
    if (cached) return _cacheMessageDto(cached);

    const state = getChatuiState();
    if (
        messageId < 0
        || messageId >= _messageIndexes.length
        || messageId >= state.chat.messageCount
        || state.chat.chatKey !== chatuiAdapter.getCurrentChatKey()
    ) {
        return null;
    }

    const message = chatuiAdapter.messageQueries.readById(messageId);
    if (!message) return null;
    _prepareFormatCache(state.chat.chatKey);
    _messageDtoBuildCount += 1;
    return _cacheMessageDto(_projectChatuiMessage(
        message,
        state.chat.lastMessageId ?? -1,
        state.chat.chatKey,
        _floorNumbers.get(messageId) ?? null,
    ));
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
    return Array.from(_messageDtos.values()).sort((left, right) => left.id - right.id);
}

/**
 * @param {number|string} messageId
 * @returns {ChatuiMessageDto|null}
 */
export function getMessageDtoById(messageId: number | string) {
    const id = Number(messageId);
    return Number.isInteger(id) && id >= 0 ? _materializeMessageDto(id) : null;
}

export function getChatuiMessageCacheStats() {
    return Object.freeze({
        indexedMessages: _messageIndexes.length,
        materializedMessages: _messageDtos.size,
        materializationsSinceRefresh: _messageDtoBuildCount,
        formattedEntries: _formatHtmlCache.size,
        messageLimit: MESSAGE_DTO_CACHE_LIMIT,
        formatLimit: FORMAT_HTML_CACHE_LIMIT,
    });
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
        _pruneMessageDtoCache();
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
    const snapshot = chatuiAdapter.messageQueries.readIndex();
    _prepareFormatCache(snapshot.chatKey);
    const messageState = _buildMessageIndex(snapshot.messages);
    const state = getChatuiState();
    const isGroup = chatuiAdapter.getIsGroupChat();
    _messageIndexes = snapshot.messages;
    _floorNumbers = messageState.floorNumbers;
    _messageDtos = new Map();
    _messageDtoBuildCount = 0;

    _store.setState({
        ...state,
        chat: {
            messageIds: messageState.visibleMessageIds,
            userTurns: messageState.userTurns,
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

    const index = chatuiAdapter.messageQueries.readIndexById(id);
    const previousIndex = _messageIndexes[id];
    if (!index || !previousIndex) {
        refreshChatuiStore();
        return;
    }

    if (
        index.isUser !== previousIndex.isUser
        || index.isSystem !== previousIndex.isSystem
        || index.isSmallSys !== previousIndex.isSmallSys
        || index.isToolCall !== previousIndex.isToolCall
    ) {
        refreshChatuiStore();
        return;
    }

    _messageDtos.delete(id);
    const lastMessageId = messageCount - 1;
    const lastMessageNeedsGenerate = id === lastMessageId
        ? index.isUser
        : state.chat.lastMessageNeedsGenerate;
    if (lastMessageNeedsGenerate !== state.chat.lastMessageNeedsGenerate) {
        _store.setState({
            ...state,
            chat: { ...state.chat, lastMessageNeedsGenerate },
        });
    }
    _notifyMessage(id);
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
}

function _migrateRenamedCharacterState(oldAvatar: unknown, newAvatar: unknown): void {
    if (typeof oldAvatar !== 'string' || typeof newAvatar !== 'string') return;
    if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
    moveComposerDraftCharacterScope(oldAvatar, newAvatar);
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
        refreshChatuiStore();

        const refreshNow = () => refreshChatuiStore();
        const refreshMessage = (messageId: number | string) => refreshChatuiMessage(messageId);
        const register = (key: string, handler: (...args: any[]) => void) => {
            registered.push(chatuiAdapter.subscribe(key, handler));
        };
        const registerFirst = (key: string, handler: (...args: any[]) => void) => {
            registered.push(chatuiAdapter.subscribeFirst(key, handler));
        };
        const registerLast = (key: string, handler: (...args: any[]) => void) => {
            registered.push(chatuiAdapter.subscribeLast(key, handler));
        };

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
        register(stEventKeys.MESSAGE_SENT, refreshMessage);
        register(stEventKeys.MESSAGE_UPDATED, refreshMessage);
        register(stEventKeys.MESSAGE_EDITED, refreshMessage);
        register(stEventKeys.MESSAGE_SWIPED, refreshMessage);
        register(stEventKeys.MESSAGE_SWIPE_DELETED, refreshNow);
        register(stEventKeys.MESSAGE_DELETED, refreshNow);
        register(stEventKeys.MESSAGE_FILE_EMBEDDED, refreshMessage);
        register(stEventKeys.MESSAGE_REASONING_EDITED, refreshMessage);
        register(stEventKeys.MESSAGE_REASONING_DELETED, refreshMessage);
        register(stEventKeys.CHARACTER_MESSAGE_RENDERED, refreshMessage);
        register(stEventKeys.USER_MESSAGE_RENDERED, refreshMessage);
        register(stEventKeys.STREAM_TOKEN_RECEIVED, _scheduleStreamRefresh);
        register(stEventKeys.GENERATION_STARTED, refreshNow);
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
    _messageIndexes = [];
    _floorNumbers = new Map();
    _messageDtos = new Map();
    _messageDtoBuildCount = 0;

    _formatHtmlCache.clear();
    _formatCacheChatKey = '';
}
