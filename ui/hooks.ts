import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/compat';
import type { RefObject } from 'preact';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { getChatuiState, subscribeChatuiStore } from '../store/chat-store.js';
import { getToasts, subscribeToasts } from '../store/toast-store.js';
import { getConfig, subscribeConfig } from '../store/config-store.js';
import { getUiState, subscribeUiStore } from '../store/ui-store.js';
import {
    getChatuiCurrentChatHeader,
    getTempChat,
    getTempChatDraft,
    isTempChatDraft,
    listChatuiCharacters,
    notifyChatui,
    subscribeTempChatStore,
} from './actions.js';
import {
    SIDEBAR_BACKFILL_CONCURRENCY,
    SIDEBAR_INITIAL_VISIBLE,
    SIDEBAR_MORE_SIZE,
    SIDEBAR_RECENTS_MAX,
    sidebarQueryOptions,
} from './sidebar-queries.js';
import type { CharacterSummary, CharConversationGroup, ChatListItem, ChatuiMessage, ChatuiState, ChatuiSidebarState, ChatuiConfig } from './types.js';

const INITIAL_VISIBLE_COUNT = SIDEBAR_INITIAL_VISIBLE;
const MORE_PAGE_SIZE = SIDEBAR_MORE_SIZE;
const BACKFILL_CONCURRENCY = SIDEBAR_BACKFILL_CONCURRENCY;

function chatRecencyTs(chat: ChatListItem): number {
    return Number.isFinite(chat.lastMesTs) ? chat.lastMesTs : 0;
}

function normalizeFileName(fileName: string): string {
    return fileName.replace(/\.jsonl$/i, '');
}

function dedupeSortChats(chats: ChatListItem[], limit = Number.POSITIVE_INFINITY): ChatListItem[] {
    const seen = new Set<string>();
    const unique: ChatListItem[] = [];
    for (const chat of chats.slice().sort((a, b) => chatRecencyTs(b) - chatRecencyTs(a))) {
        const fileName = normalizeFileName(chat.fileName);
        if (!fileName || seen.has(fileName)) continue;
        seen.add(fileName);
        unique.push({ ...chat, fileName });
        if (unique.length >= limit) break;
    }
    return unique;
}

function finiteNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function withSetValue<T>(source: Set<T>, value: T, included: boolean): Set<T> {
    const next = new Set(source);
    if (included) next.add(value);
    else next.delete(value);
    return next;
}

export function useConfig(): ChatuiConfig {
    const [config, setConfig] = useState<ChatuiConfig>(() => getConfig());

    useEffect(() => subscribeConfig(() => {
        setConfig(getConfig());
    }), []);

    return config;
}

/** Shape returned by useSettings; matches ChatuiUiState from store/ui-store.js. */
export type SettingsModeState = { settingsOpen: boolean; activeSettingsId: string | null };

/** Reactive read of the full settings mode state (settingsOpen + activeSettingsId). */
export function useSettings(): SettingsModeState {
    const [state, setState] = useState<SettingsModeState>(() => ({
        settingsOpen: getUiState().settingsOpen,
        activeSettingsId: getUiState().activeSettingsId,
    }));

    useEffect(() => subscribeUiStore(() => {
        const s = getUiState();
        setState({ settingsOpen: s.settingsOpen, activeSettingsId: s.activeSettingsId });
    }), []);

    return state;
}

export function useToasts(): ReturnType<typeof getToasts> {
    const [toasts, setToasts] = useState(() => getToasts());
    useEffect(() => subscribeToasts(setToasts), []);
    return toasts;
}

export function useSidebarBasics(): {
    header: ChatuiSidebarState['header'];
    characters: CharacterSummary[];
    getDraftSnapshot: (avatar: string) => { fileNames: string[]; complete: boolean };
} {
    const queryClient = useQueryClient();
    const chatState = useChatuiSnapshot();
    const headerQuery = useQuery({
        ...sidebarQueryOptions.header(),
        initialData: getChatuiCurrentChatHeader,
    });
    const charactersQuery = useQuery({
        ...sidebarQueryOptions.characters(),
        initialData: listChatuiCharacters,
    });
    const currentChat = chatState.chat.currentChat;

    const header = headerQuery.data ?? { sessionName: '', characterName: '', avatarImgURL: '', isGroup: false };
    const characters = useMemo(() => (charactersQuery.data ?? []).map(character => ({
        ...character,
        isCurrent: !header.isGroup && currentChat?.avatar === character.avatar,
    })), [charactersQuery.data, currentChat?.avatar, header.isGroup]);

    const getDraftSnapshot = useCallback((avatar: string) => {
        const full = queryClient.getQueryData(sidebarQueryOptions.byCharacter(avatar).queryKey) as
            { chats: ChatListItem[] } | undefined;
        if (full) {
            return { fileNames: dedupeSortChats(full.chats).map(chat => chat.fileName), complete: true };
        }

        const rows = (queryClient.getQueryData(
            sidebarQueryOptions.recents(SIDEBAR_RECENTS_MAX).queryKey,
        ) as Array<{ avatar: string; chat: ChatListItem }> | undefined) ?? [];
        const recents = rows.filter(row => row.avatar === avatar).map(row => row.chat);
        return {
            fileNames: dedupeSortChats(recents, INITIAL_VISIBLE_COUNT).map(chat => chat.fileName),
            complete: false,
        };
    }, [queryClient]);

    return {
        header,
        characters,
        getDraftSnapshot,
    };
}

export function useSidebarData(): ChatuiSidebarState {
    const queryClient = useQueryClient();
    const chatState = useChatuiSnapshot();
    const tempChat = useTempChat();
    const tempDraft = useTempChatDraft();
    const headerQuery = useQuery({
        ...sidebarQueryOptions.header(),
        initialData: getChatuiCurrentChatHeader,
    });
    const charactersQuery = useQuery({
        ...sidebarQueryOptions.characters(),
        initialData: listChatuiCharacters,
    });
    const recentsQuery = useQuery({
        ...sidebarQueryOptions.recents(SIDEBAR_RECENTS_MAX),
        placeholderData: [],
    });
    const currentChat = chatState.chat.currentChat;
    const recentsReady = recentsQuery.isSuccess && !recentsQuery.isPlaceholderData;
    const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
    const [pendingBackfillAvatars, setPendingBackfillAvatars] = useState<Set<string>>(() => new Set());
    const [pendingMoreAvatars, setPendingMoreAvatars] = useState<Set<string>>(() => new Set());
    const [failedFullAvatars, setFailedFullAvatars] = useState<Set<string>>(() => new Set());
    const requestedBackfillRef = useRef<Set<string>>(new Set());

    const header = headerQuery.data ?? { sessionName: '', characterName: '', avatarImgURL: '', isGroup: false };
    const characters = useMemo(() => (charactersQuery.data ?? []).map(character => ({
        ...character,
        isCurrent: !header.isGroup && currentChat?.avatar === character.avatar,
    })), [charactersQuery.data, currentChat?.avatar, header.isGroup]);

    const groupHeaders = useMemo(() => characters
        .filter(character => character.avatar && character.name && finiteNumber(character.chatSize) > 0)
        .slice()
        .sort((a, b) => finiteNumber(b.dateLastChatTs) - finiteNumber(a.dateLastChatTs)), [characters]);

    const groupAvatarKey = useMemo(() => groupHeaders.map(group => group.avatar).join('\u0001'), [groupHeaders]);

    useEffect(() => {
        const keep = new Set(groupHeaders.map(group => group.avatar));
        requestedBackfillRef.current = new Set([...requestedBackfillRef.current].filter(avatar => keep.has(avatar)));
        setPendingBackfillAvatars(prev => new Set([...prev].filter(avatar => keep.has(avatar))));
        setPendingMoreAvatars(prev => new Set([...prev].filter(avatar => keep.has(avatar))));
        setFailedFullAvatars(prev => new Set([...prev].filter(avatar => keep.has(avatar))));
        setVisibleCounts(prev => Object.fromEntries(Object.entries(prev).filter(([avatar]) => keep.has(avatar))));
    }, [groupAvatarKey, groupHeaders]);

    const byCharacterQueries = useQueries({
        queries: groupHeaders.map(group => {
            const options = sidebarQueryOptions.byCharacter(group.avatar);
            return {
                ...options,
                enabled: !!queryClient.getQueryData(options.queryKey),
            };
        }),
    });

    const byCharacterByAvatar = useMemo(() => {
        const map = new Map<string, (typeof byCharacterQueries)[number]>();
        groupHeaders.forEach((group, index) => {
            map.set(group.avatar, byCharacterQueries[index]);
        });
        return map;
    }, [byCharacterQueries, groupHeaders]);

    const recentsByAvatar = useMemo(() => {
        const map = new Map<string, ChatListItem[]>();
        for (const row of recentsQuery.data ?? []) {
            const chats = map.get(row.avatar) ?? [];
            chats.push(row.chat as ChatListItem);
            map.set(row.avatar, chats);
        }
        for (const [avatar, chats] of map) {
            map.set(avatar, dedupeSortChats(chats, INITIAL_VISIBLE_COUNT));
        }
        return map;
    }, [recentsQuery.data]);

    const backfillNeededAvatarKey = useMemo(() => groupHeaders
        .filter(group => (recentsByAvatar.get(group.avatar) ?? []).length === 0)
        .map(group => group.avatar)
        .sort()
        .join('\u0001'), [groupHeaders, recentsByAvatar]);

    useEffect(() => {
        if (!recentsReady) return;
        const avatars = (backfillNeededAvatarKey ? backfillNeededAvatarKey.split('\u0001') : [])
            .filter(avatar => {
                if (requestedBackfillRef.current.has(avatar)) return false;
                return !queryClient.getQueryData(sidebarQueryOptions.byCharacter(avatar).queryKey);
            });
        if (!avatars.length) return;
        let cancelled = false;
        let index = 0;

        const worker = async (): Promise<void> => {
            while (!cancelled && index < avatars.length) {
                const avatar = avatars[index++];
                requestedBackfillRef.current.add(avatar);
                setPendingBackfillAvatars(prev => withSetValue(prev, avatar, true));
                try {
                    await queryClient.prefetchQuery(sidebarQueryOptions.byCharacter(avatar));
                    if (cancelled) return;
                    setFailedFullAvatars(prev => withSetValue(prev, avatar, false));
                } catch (error) {
                    if (!cancelled) {
                        console.error('[ChatUI] sidebar backfill failed', avatar, error);
                        setFailedFullAvatars(prev => withSetValue(prev, avatar, true));
                    }
                } finally {
                    requestedBackfillRef.current.delete(avatar);
                    setPendingBackfillAvatars(prev => withSetValue(prev, avatar, false));
                }
            }
        };

        void Promise.all(Array.from(
            { length: Math.min(BACKFILL_CONCURRENCY, avatars.length) },
            () => worker(),
        ));

        return () => { cancelled = true; };
    }, [backfillNeededAvatarKey, queryClient, recentsReady]);

    const shouldHideChat = useCallback((avatar: string, chat: ChatListItem): boolean => {
        if (tempChat?.avatar === avatar && tempChat.fileName === normalizeFileName(chat.fileName)) return true;
        if (tempDraft?.avatar !== avatar) return false;
        return isTempChatDraft(avatar, chat.fileName);
    }, [
        tempChat?.avatar,
        tempChat?.fileName,
        tempDraft?.avatar,
        tempDraft?.knownFileNames,
    ]);

    const loadMoreCharacterChats = useCallback(async (avatar: string): Promise<void> => {
        if (!avatar) return;
        setPendingMoreAvatars(prev => withSetValue(prev, avatar, true));
        try {
            const result = await queryClient.fetchQuery(sidebarQueryOptions.byCharacter(avatar));
            setFailedFullAvatars(prev => withSetValue(prev, avatar, false));
            setVisibleCounts(prev => {
                const current = Math.max(prev[avatar] ?? INITIAL_VISIBLE_COUNT, INITIAL_VISIBLE_COUNT);
                const next = Math.min(current + MORE_PAGE_SIZE, result.totalCount);
                return { ...prev, [avatar]: next };
            });
        } catch (error) {
            console.error('[ChatUI] load more character chats failed', avatar, error);
            setFailedFullAvatars(prev => withSetValue(prev, avatar, true));
            notifyChatui('error', '加载更多对话失败');
        } finally {
            setPendingMoreAvatars(prev => withSetValue(prev, avatar, false));
        }
    }, [queryClient]);

    const retryCharacterChats = useCallback(async (avatar: string): Promise<void> => {
        if (!avatar) return;
        setPendingBackfillAvatars(prev => withSetValue(prev, avatar, true));
        try {
            await queryClient.fetchQuery(sidebarQueryOptions.byCharacter(avatar));
            setFailedFullAvatars(prev => withSetValue(prev, avatar, false));
        } catch (error) {
            console.error('[ChatUI] retry character chats failed', avatar, error);
            setFailedFullAvatars(prev => withSetValue(prev, avatar, true));
            notifyChatui('error', '加载对话失败');
        } finally {
            setPendingBackfillAvatars(prev => withSetValue(prev, avatar, false));
        }
    }, [queryClient]);

    const charGroups = useMemo(() => groupHeaders.map(group => {
        const byCharacterQuery = byCharacterByAvatar.get(group.avatar);
        const full = byCharacterQuery?.data;
        const visibleCount = Math.max(visibleCounts[group.avatar] ?? INITIAL_VISIBLE_COUNT, INITIAL_VISIBLE_COUNT);
        const recentChats = recentsByAvatar.get(group.avatar) ?? [];
        const draftActive = tempDraft?.avatar === group.avatar;
        const sourceChats = (draftActive && tempDraft && !tempDraft.complete)
            ? recentChats
            : (full?.chats ?? recentChats);
        const totalCount = full?.totalCount ?? Math.max(finiteNumber(group.chatSize), sourceChats.length);
        const visibleSourceChats = dedupeSortChats(sourceChats as ChatListItem[])
            .filter(chat => !shouldHideChat(group.avatar, chat));
        const displayChats = visibleSourceChats
            .slice(0, full ? visibleCount : INITIAL_VISIBLE_COUNT)
            .map(chat => ({
                ...chat,
                isCurrent: !!currentChat
                    && currentChat.avatar === group.avatar
                    && currentChat.fileName === normalizeFileName(chat.fileName),
            }))
            .filter(chat => !shouldHideChat(group.avatar, chat));
        const isLoadingFull = byCharacterQuery?.isFetching === true;
        const pending: CharConversationGroup['pending'] = pendingMoreAvatars.has(group.avatar)
            ? 'more'
            : pendingBackfillAvatars.has(group.avatar)
                ? 'backfill'
                : failedFullAvatars.has(group.avatar) || byCharacterQuery?.isError
                    ? 'error'
                    : isLoadingFull && full
                        ? 'refresh'
                        : null;

        return {
            charId: typeof group.charId === 'number' ? group.charId : -1,
            avatar: group.avatar,
            name: group.name,
            thumbnailUrl: group.thumbnailUrl,
            isCurrent: !!currentChat && currentChat.avatar === group.avatar,
            dateLastChatTs: finiteNumber(group.dateLastChatTs),
            chatSize: finiteNumber(group.chatSize),
            chats: displayChats,
            visibleCount: full ? visibleCount : displayChats.length,
            chatsLoaded: sourceChats.length > 0 || !!full,
            fullyLoaded: full
                ? visibleCount >= visibleSourceChats.length
                : totalCount <= sourceChats.length && displayChats.length >= visibleSourceChats.length,
            pending,
        };
    }), [
        byCharacterByAvatar,
        currentChat,
        failedFullAvatars,
        groupHeaders,
        pendingBackfillAvatars,
        pendingMoreAvatars,
        recentsByAvatar,
        shouldHideChat,
        tempDraft,
        visibleCounts,
    ]);

    const currentGroup = charGroups.find(group => currentChat?.avatar === group.avatar);

    return {
        header,
        characters,
        chats: currentGroup?.chats ?? [],
        loading: headerQuery.isLoading || charactersQuery.isLoading || recentsQuery.isLoading,
        error: headerQuery.isError || charactersQuery.isError || recentsQuery.isError ? 'load-failed' : null,
        charGroups,
        charGroupsLoading: charactersQuery.isLoading || recentsQuery.isLoading,
        charGroupsError: charactersQuery.isError || recentsQuery.isError ? 'load-failed' : null,
        loadMoreCharacterChats,
        retryCharacterChats,
    };
}

export function useChatuiSnapshot(): ChatuiState {
    const [state, setState] = useState<ChatuiState>(() => getChatuiState());

    useEffect(() => subscribeChatuiStore(() => {
        setState(getChatuiState());
    }), []);

    return state;
}

export function useTempChat(): ReturnType<typeof getTempChat> {
    const [tempChat, setTempChat] = useState(() => getTempChat());

    useEffect(() => subscribeTempChatStore(() => {
        setTempChat(getTempChat());
    }), []);

    return tempChat;
}

export function useTempChatDraft(): ReturnType<typeof getTempChatDraft> {
    const [tempDraft, setTempDraft] = useState(() => getTempChatDraft());

    useEffect(() => subscribeTempChatStore(() => {
        setTempDraft(getTempChatDraft());
    }), []);

    return tempDraft;
}

export function useIsTempChatActive(): boolean {
    const state = useChatuiSnapshot();
    const tempChat = useTempChat();
    const tempDraft = useTempChatDraft();
    const current = state.chat.currentChat;
    if (tempDraft) return true;
    if (current && tempChat && current.avatar === tempChat.avatar && current.fileName === tempChat.fileName) return true;
    return false;
}

export function useRootDomEnhancements(
    rootRef: RefObject<HTMLElement>,
    messages: ChatuiMessage[],
    isGenerating: boolean,
): void {
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        root.querySelectorAll('.cui-root-message-body pre, .cui-root-reasoning-body pre').forEach(pre => {
            const block = pre instanceof HTMLElement ? pre : null;
            if (!block) return;

            const code = block.querySelector('code');
            if (!code) return;

            // Language label (top-left) — only for fences that declared a language,
            // read off the `language-xxx` class showdown emits (ChatUI renders that
            // markdown string directly; hljs auto-detection runs on ST's own DOM, not
            // here, so undeclared fences carry no class and stay unlabelled). The
            // matching top-padding is reserved in CSS via :has() off that same class,
            // so it stays put even as innerHTML is rebuilt each streaming frame.
            if (!block.querySelector('.cui-root-code-lang')) {
                const lang = /\blanguage-([\w#+.-]+)/.exec(code.className)?.[1];
                if (lang) {
                    const label = document.createElement('span');
                    label.className = 'cui-root-code-lang';
                    label.textContent = lang;
                    block.appendChild(label);
                }
            }

            // Copy button (top-right).
            if (!block.querySelector('.cui-root-code-copy')) {
                const copy = document.createElement('button');
                copy.className = 'cui-root-code-copy';
                copy.type = 'button';
                copy.setAttribute('aria-label', 'Copy code');
                copy.setAttribute('title', 'Copy code');
                copy.innerHTML = '<i class="fa-regular fa-copy"></i>';
                copy.addEventListener('click', (event) => {
                    event.stopPropagation();
                    navigator.clipboard?.writeText?.(code.textContent ?? '')?.catch(() => {});
                });

                block.appendChild(copy);
            }
        });
    }, [rootRef, messages, isGenerating]);
}

/** Distance (px) from the bottom within which we treat the view as "pinned". */
const AT_BOTTOM_THRESHOLD = 80;

/**
 * Auto-scroll that respects the reader. New messages/tokens only pull the view
 * to the bottom when the user is already near the bottom; if they have scrolled
 * up to read history, their position is left alone and `atBottom` flips false so
 * the caller can show a "back to bottom" affordance.
 */
export function useAutoScroll(
    rootRef: RefObject<HTMLElement>,
    messages: ChatuiMessage[],
    isGenerating: boolean,
    chatKey: string,
): { atBottom: boolean; scrollToBottom: () => void } {
    const [atBottom, setAtBottom] = useState(true);
    // Authoritative "was the user pinned to the bottom" flag, updated on scroll.
    // A ref (not state) so the content effect below reads the value from BEFORE
    // the new content grew scrollHeight.
    const wasAtBottomRef = useRef(true);
    // null sentinel so the very first render also counts as a switch → land at bottom.
    const chatKeyRef = useRef<string | null>(null);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const onScroll = () => {
            const distance = root.scrollHeight - root.scrollTop - root.clientHeight;
            const pinned = distance < AT_BOTTOM_THRESHOLD;
            wasAtBottomRef.current = pinned;
            setAtBottom(prev => (prev === pinned ? prev : pinned));
        };

        root.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
        return () => root.removeEventListener('scroll', onScroll);
    }, [rootRef]);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        // A chat switch (or first mount) always lands at the latest message,
        // regardless of where the previous chat was scrolled. An in-place
        // append/edit/stream only follows when the reader is already pinned — so
        // scrolling up to read history during streaming is never interrupted.
        const switched = chatKeyRef.current !== chatKey;
        chatKeyRef.current = chatKey;

        if (!switched && !wasAtBottomRef.current) return;
        root.scrollTop = root.scrollHeight;
        wasAtBottomRef.current = true;
        setAtBottom(true);
    }, [rootRef, messages, isGenerating, chatKey]);

    const scrollToBottom = useCallback(() => {
        const root = rootRef.current;
        if (!root) return;
        root.scrollTop = root.scrollHeight;
        wasAtBottomRef.current = true;
        setAtBottom(true);
    }, [rootRef]);

    return { atBottom, scrollToBottom };
}
