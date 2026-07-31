import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'preact/compat';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    getChatuiState,
    getMessageDtoById,
    subscribeChatuiMessage,
    subscribeChatuiMessageChanges,
    subscribeChatuiStore,
} from '../store/chat-store.js';
import { getToasts, subscribeToasts } from '../store/toast-store.js';
import { getChatuiConfirmRequest, subscribeChatuiConfirm } from '../store/confirm-store.js';
import { getConfig, subscribeConfig } from '../store/config-store.js';
import { getUiState, subscribeUiStore } from '../store/ui-store.js';
import {
    getChatuiCurrentChatHeader,
    getChatuiComposerDraftStoreSnapshot,
    getChatuiPendingDraftQuarantineCharacter,
    getTempChat,
    getTempChats,
    getTempChatDraft,
    isTempChatDraft,
    listChatuiCharacters,
    notifyChatui,
    setChatuiComposerDraft,
    stopChatuiGeneration,
    subscribeChatuiComposerDraftStore,
    subscribeTempChatStore,
} from './actions.js';
import { renderCardEmbeds } from './card-embed.js';
import { readFollowGates } from './follow-scroll-math.js';
import { orderSpineCast } from './spine-cast.js';
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

type CharacterChatsResult = { chats: ChatListItem[]; totalCount: number };

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

export function useComposerDraft(chatKey: string): {
    draft: string;
    pendingSend: ReturnType<typeof getChatuiComposerDraftStoreSnapshot>['pendingSend'];
    setDraft: (text: string) => void;
} {
    const snapshot = useSyncExternalStore(
        subscribeChatuiComposerDraftStore,
        getChatuiComposerDraftStoreSnapshot,
    );
    const setDraft = useCallback((text: string) => {
        setChatuiComposerDraft(chatKey, text);
    }, [chatKey]);

    return {
        draft: snapshot.drafts[chatKey] ?? '',
        pendingSend: snapshot.pendingSend,
        setDraft,
    };
}

export function useConfig(): ChatuiConfig {
    return useSyncExternalStore(subscribeConfig, getConfig);
}

/** Shape returned by useSettings; matches ChatuiUiState from store/ui-store.js. */
export type SettingsModeState = { settingsOpen: boolean; activeSettingsId: string | null };

/** Reactive read of the full settings mode state (settingsOpen + activeSettingsId). */
export function useSettings(): SettingsModeState {
    return useSyncExternalStore(subscribeUiStore, getUiState);
}

export function useToasts(): ReturnType<typeof getToasts> {
    return useSyncExternalStore(subscribeToasts, getToasts);
}

export function useChatuiConfirmRequest(): ReturnType<typeof getChatuiConfirmRequest> {
    return useSyncExternalStore(subscribeChatuiConfirm, getChatuiConfirmRequest);
}

function getCurrentChatSnapshot(): ChatuiState['chat']['currentChat'] {
    return getChatuiState().chat.currentChat;
}

/** Subscribe only to active-chat identity; streaming message updates stay local to the chat pane. */
export function useCurrentChatIdentity(): ChatuiState['chat']['currentChat'] {
    return useSyncExternalStore(subscribeChatuiStore, getCurrentChatSnapshot);
}

export function useSidebarBasics(): {
    header: ChatuiSidebarState['header'];
    characters: CharacterSummary[];
    getDraftSnapshot: (avatar: string) => { fileNames: string[]; complete: boolean };
} {
    const queryClient = useQueryClient();
    const currentChat = useCurrentChatIdentity();
    const headerQuery = useQuery({
        ...sidebarQueryOptions.header(),
        initialData: getChatuiCurrentChatHeader,
    });
    const charactersQuery = useQuery({
        ...sidebarQueryOptions.characters(),
        initialData: listChatuiCharacters,
    });
    const header = headerQuery.data ?? { sessionName: '', characterName: '', avatarImgURL: '', isGroup: false };
    const characters = useMemo<CharacterSummary[]>(() => (charactersQuery.data ?? []).map(character => ({
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

/**
 * Spine feed. Deliberately built on useSidebarBasics rather than
 * useSidebarData: the spine needs the cast and nothing else, and
 * useSidebarData fans out one per-character chat query per entry — work the
 * playbill already pays for and the book spine has no use for.
 *
 * The membership rule itself lives in ui/spine-cast.ts (pure, unit-tested);
 * everything here is the wiring that hands it the three things ChatUI knows
 * and ST's boot-time `chat_size` snapshot does not. Two of the three are
 * reactive stores, so the rail follows them: the on-stage avatar arrives
 * through `useSidebarBasics`'s `isCurrent` (which already honours the group
 * case), and the leases through `useTempChats`. The third — the pending
 * draft-quarantine credential — is a `sessionStorage` record with no change
 * notification, and needs none: the only thing that ever clears it is the
 * commit that puts a lease in its place, so the lease store's own update is
 * exactly when this is re-read.
 *
 * `isGroupActive` is the whole of ChatUI's group knowledge today: the header
 * says whether the open chat is a group, and there is no adapter query that
 * enumerates groups. So the spine can honestly show that a group holds the
 * stage; it cannot yet offer to switch to one (DESIGN §4.2 defers full group
 * support to its own project).
 */
export function useSpineCharacters(): { characters: CharacterSummary[]; isGroupActive: boolean } {
    const { characters, header } = useSidebarBasics();
    const tempChats = useTempChats();
    const cast = useMemo(() => orderSpineCast(characters, {
        onStageAvatar: characters.find((character: CharacterSummary) => character.isCurrent)?.avatar ?? null,
        leasedAvatars: tempChats.map(pointer => pointer.avatar),
        pendingDraftAvatar: getChatuiPendingDraftQuarantineCharacter(),
    }), [characters, tempChats]);
    return { characters: cast, isGroupActive: header.isGroup };
}

export function useSidebarData(): ChatuiSidebarState {
    const queryClient = useQueryClient();
    const currentChat = useCurrentChatIdentity();
    const tempChats = useTempChats();
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
    const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
    const [pendingBackfillAvatars, setPendingBackfillAvatars] = useState<Set<string>>(() => new Set());
    const [pendingMoreAvatars, setPendingMoreAvatars] = useState<Set<string>>(() => new Set());
    const [failedFullAvatars, setFailedFullAvatars] = useState<Set<string>>(() => new Set());
    const requestedBackfillRef = useRef<Set<string>>(new Set());

    const header = headerQuery.data ?? { sessionName: '', characterName: '', avatarImgURL: '', isGroup: false };
    const characters = useMemo<CharacterSummary[]>(() => (charactersQuery.data ?? []).map(character => ({
        ...character,
        isCurrent: !header.isGroup && currentChat?.avatar === character.avatar,
    })), [charactersQuery.data, currentChat?.avatar, header.isGroup]);

    // The playbill lists exactly one character (DESIGN §4.2), so this fan-out
    // is one entry wide. It used to be the whole cast, back when the column
    // was a whole-cast accordion; leaving it that wide now would keep firing a
    // /api/chats/search backfill per character to fill groups nothing renders.
    // Everything downstream is per-group and unchanged — 更多 paging, retry and
    // the temp-chat hiding all still work, they just work on the one group.
    //
    // Note this selects the current character *directly* rather than by
    // filtering the spine's cast: the playbill is one character's programme,
    // and a character whose boot-time `chatSize` snapshot has not caught up
    // must never end up with an open conversation and no column to list it in.
    const groupHeaders = useMemo<CharacterSummary[]>(
        () => characters.filter((character: CharacterSummary) => character.isCurrent),
        [characters],
    );

    const groupAvatarKey = useMemo(() => groupHeaders.map((group: CharacterSummary) => group.avatar).join('\u0001'), [groupHeaders]);

    useEffect(() => {
        const keep = new Set(groupHeaders.map((group: CharacterSummary) => group.avatar));
        requestedBackfillRef.current = new Set([...requestedBackfillRef.current].filter(avatar => keep.has(avatar)));
        setPendingBackfillAvatars(prev => new Set([...prev].filter(avatar => keep.has(avatar))));
        setPendingMoreAvatars(prev => new Set([...prev].filter(avatar => keep.has(avatar))));
        setFailedFullAvatars(prev => new Set([...prev].filter(avatar => keep.has(avatar))));
        setVisibleCounts(prev => Object.fromEntries(Object.entries(prev).filter(([avatar]) => keep.has(avatar))));
    }, [groupAvatarKey, groupHeaders]);

    const byCharacterQueries = useQueries({
        queries: groupHeaders.map((group: CharacterSummary) => {
            const options = sidebarQueryOptions.byCharacter(group.avatar);
            return {
                ...options,
                enabled: !!queryClient.getQueryData(options.queryKey),
            };
        }),
    });

    const byCharacterByAvatar = useMemo(() => {
        const map = new Map<string, (typeof byCharacterQueries)[number]>();
        groupHeaders.forEach((group: CharacterSummary, index: number) => {
            map.set(group.avatar, byCharacterQueries[index]);
        });
        return map;
    }, [byCharacterQueries, groupHeaders]);

    const recentsByAvatar = useMemo(() => {
        const map = new Map<string, ChatListItem[]>();
        for (const row of recentsQuery.data ?? []) {
            const chats = map.get(row.avatar) ?? [];
            chats.push(row.chat);
            map.set(row.avatar, chats);
        }
        for (const [avatar, chats] of map) {
            map.set(avatar, dedupeSortChats(chats, INITIAL_VISIBLE_COUNT));
        }
        return map;
    }, [recentsQuery.data]);

    // Every character in the feed — which is now just the one the playbill is
    // showing — gets its full listing fetched, not only the ones missing from
    // the recents page. Back when this fanned out over the whole cast, "only
    // if recents told us nothing" was the rule that kept a large cast from
    // firing one request per character; one column of one character costs one
    // request, and without it the recents page (capped at five rows per
    // character) is all the column ever has: no honest 「的对话 · N」, no way
    // past the fifth conversation, and a draft snapshot that has to declare
    // itself incomplete.
    const backfillNeededAvatarKey = useMemo(() => groupHeaders
        .map((group: CharacterSummary) => group.avatar)
        .sort()
        .join('\u0001'), [groupHeaders]);

    useEffect(() => {
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
    }, [backfillNeededAvatarKey, queryClient]);

    const shouldHideChat = useCallback((avatar: string, chat: ChatListItem): boolean => {
        if (tempChats.some(pointer => (
            pointer.avatar === avatar && pointer.fileName === normalizeFileName(chat.fileName)
        ))) return true;
        if (tempDraft?.avatar !== avatar) return false;
        return isTempChatDraft(avatar, chat.fileName);
    }, [
        tempChats,
        tempDraft?.avatar,
        tempDraft?.knownFileNames,
    ]);

    const loadMoreCharacterChats = useCallback(async (avatar: string): Promise<void> => {
        if (!avatar) return;
        setPendingMoreAvatars(prev => withSetValue(prev, avatar, true));
        try {
            const result = await queryClient.fetchQuery(sidebarQueryOptions.byCharacter(avatar)) as CharacterChatsResult;
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

    const charGroups = useMemo<CharConversationGroup[]>(() => groupHeaders.map((group: CharacterSummary) => {
        const byCharacterQuery = byCharacterByAvatar.get(group.avatar);
        const full = byCharacterQuery?.data as CharacterChatsResult | undefined;
        const visibleCount = Math.max(visibleCounts[group.avatar] ?? INITIAL_VISIBLE_COUNT, INITIAL_VISIBLE_COUNT);
        const recentChats = recentsByAvatar.get(group.avatar) ?? [];
        const draftActive = tempDraft?.avatar === group.avatar;
        const sourceChats = (draftActive && tempDraft && !tempDraft.complete)
            ? recentChats
            : (full?.chats ?? recentChats);
        // Raw listing size, drafts included — only ever compared against the
        // source list to decide whether more pages exist. The count the header
        // prints is the ordinary-conversation one further down.
        const sourceTotalCount = full?.totalCount ?? Math.max(finiteNumber(group.chatSize), sourceChats.length);
        const dedupedSourceChats = dedupeSortChats(sourceChats);
        const visibleSourceChats = dedupedSourceChats
            .filter(chat => !shouldHideChat(group.avatar, chat));
        // Draft cards are driven by the lease set, not by the chat listing:
        // the quarantine is what makes a file a draft, and it is authoritative
        // even when the listing has not caught up. The listing only decorates
        // (title/preview/time); an undecorated draft still gets a card, which
        // is why the fallback below is a bare pointer rather than a skip.
        const draftChats = tempChats
            .filter(pointer => pointer.avatar === group.avatar && !(
                currentChat?.avatar === pointer.avatar && currentChat.fileName === pointer.fileName
            ))
            .map(pointer => dedupedSourceChats.find(
                chat => normalizeFileName(chat.fileName) === pointer.fileName,
            ) ?? {
                fileName: pointer.fileName,
                displayName: pointer.fileName,
                messageCount: 0,
                preview: '',
                fileSize: '',
                lastMesTs: 0,
                lastMesLabel: '',
                isCurrent: false,
            })
            .sort((a, b) => chatRecencyTs(b) - chatRecencyTs(a));
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
            draftChats,
            // Honest only once the full per-character listing has landed: until
            // then `sourceChats` is the recents page, capped at five, and
            // `chatSize` is a byte count. Null means "unknown", and the header
            // prints nothing rather than a number it cannot stand behind.
            totalCount: full ? visibleSourceChats.length : null,
            visibleCount: full ? visibleCount : displayChats.length,
            chatsLoaded: sourceChats.length > 0 || !!full,
            fullyLoaded: full
                ? visibleCount >= visibleSourceChats.length
                : sourceTotalCount <= sourceChats.length && displayChats.length >= visibleSourceChats.length,
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
        tempChats,
        tempDraft,
        visibleCounts,
    ]);

    const currentGroup = charGroups.find((group: CharConversationGroup) => currentChat?.avatar === group.avatar);

    return {
        header,
        characters,
        chats: currentGroup?.chats ?? [],
        loading: headerQuery.isLoading || charactersQuery.isLoading || recentsQuery.isLoading,
        error: headerQuery.isError || charactersQuery.isError || recentsQuery.isError ? 'load-failed' : null,
        charGroups,
        charGroupsLoading: charactersQuery.isLoading || recentsQuery.isLoading,
        // Only a failed *character* list is a column-wide failure. The recents
        // page is a first-paint shortcut the playbill can do without now that
        // it fetches the current character's own listing unconditionally, and
        // a failure of that listing is reported inside the column with a retry
        // (group.pending === 'error') — which is both more accurate and more
        // actionable than painting 「加载失败」 over a list that loaded.
        charGroupsError: charactersQuery.isError ? 'load-failed' : null,
        loadMoreCharacterChats,
        retryCharacterChats,
    };
}

export function useChatuiSnapshot(): ChatuiState {
    return useSyncExternalStore(subscribeChatuiStore, getChatuiState);
}

/** Granular message subscription: only the changed row rerenders while streaming. */
export function useChatuiMessage(messageId: number): ChatuiMessage | null {
    const subscribe = useCallback(
        (onStoreChange: () => void) => subscribeChatuiMessage(messageId, onStoreChange),
        [messageId],
    );
    const getSnapshot = useCallback(() => getMessageDtoById(messageId), [messageId]);
    return useSyncExternalStore(subscribe, getSnapshot);
}

export function useTempChat(): ReturnType<typeof getTempChat> {
    return useSyncExternalStore(subscribeTempChatStore, getTempChat);
}

export function useTempChats(): ReturnType<typeof getTempChats> {
    return useSyncExternalStore(subscribeTempChatStore, getTempChats);
}

export function useTempChatDraft(): ReturnType<typeof getTempChatDraft> {
    return useSyncExternalStore(subscribeTempChatStore, getTempChatDraft);
}

export function useIsTempChatActive(): boolean {
    const current = useCurrentChatIdentity();
    const tempChats = useTempChats();
    const tempDraft = useTempChatDraft();
    if (tempDraft) return true;
    if (current && tempChats.some(pointer => (
        pointer.avatar === current.avatar && pointer.fileName === current.fileName
    ))) return true;
    return false;
}

export function useRootDomEnhancements(
    root: HTMLElement | null,
    messages: ChatuiMessage[],
    isGenerating: boolean,
): void {
    useEffect(() => {
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
    }, [root, messages, isGenerating]);
}

export function useCardEmbedRendering(
    root: HTMLElement | null,
    messages: ChatuiMessage[],
    isGenerating: boolean,
): void {
    // useLayoutEffect (not useEffect) so the raw ```html code block is hidden
    // and replaced with the iframe before the browser paints — otherwise the
    // (often very long) raw source flashes visibly for one frame first.
    useLayoutEffect(() => {
        if (!root) return;

        renderCardEmbeds(root, messages, isGenerating);
    }, [root, messages, isGenerating]);
}

/**
 * Auto-scroll that respects the reader. New messages/tokens only pull the view
 * to the bottom when the user is already near the bottom; if they have scrolled
 * up to read history, their position is left alone and `awayFromLatest` flips
 * true once the end is genuinely off screen, so the caller can float the
 * 「回到最新」 capsule.
 *
 * The two gates are read from follow-scroll-math.ts, which documents why they
 * are separate numbers; everything here is wiring. Only `awayFromLatest` is
 * state, because it is the only one anything renders — whether the view is
 * pinned is a scroll-behaviour fact, and lives in a ref so reading it never
 * costs a render.
 */
export function useAutoScroll(
    root: HTMLElement | null,
    messageIds: readonly number[],
    isGenerating: boolean,
    chatKey: string,
): { awayFromLatest: boolean; scrollToBottom: () => void } {
    const [awayFromLatest, setAwayFromLatest] = useState(false);
    // Authoritative "was the user pinned to the bottom" flag, updated on scroll.
    // A ref (not state) so the content effect below reads the value from BEFORE
    // the new content grew scrollHeight.
    const wasAtBottomRef = useRef(true);
    // null sentinel so the very first render also counts as a switch → land at bottom.
    const chatKeyRef = useRef<string | null>(null);
    const contentFrameRef = useRef(0);

    /** Re-read both gates off the live container. Costs one layout read. */
    const syncFollowGates = useCallback(() => {
        if (!root) return;
        const { pinned, awayFromLatest: away } = readFollowGates(root);
        wasAtBottomRef.current = pinned;
        setAwayFromLatest(prev => (prev === away ? prev : away));
    }, [root]);

    const followContent = useCallback(() => {
        if (!root || !wasAtBottomRef.current) return;
        root.scrollTop = root.scrollHeight;
        wasAtBottomRef.current = true;
        setAwayFromLatest(false);
    }, [root]);

    useEffect(() => {
        if (!root) return;
        return subscribeChatuiMessageChanges(() => {
            if (contentFrameRef.current) return;
            contentFrameRef.current = requestAnimationFrame(() => {
                contentFrameRef.current = 0;
                // Pinned: pull the view down with the new content. Not pinned:
                // nothing moves, but the growing content just pushed the end
                // further away without emitting a scroll event — appending below
                // the viewport never does. The capsule's gate sits above the
                // follow gate, so it can now be crossed by content alone, and a
                // reader who paused 100px up during a long generation would
                // otherwise never be offered the way back. Re-reading here is
                // what keeps the gate honest; it is one layout read per frame,
                // the same one the pinned branch already pays.
                if (wasAtBottomRef.current) followContent();
                else syncFollowGates();
            });
        });
    }, [followContent, root, syncFollowGates]);

    useEffect(() => () => {
        if (contentFrameRef.current) cancelAnimationFrame(contentFrameRef.current);
        contentFrameRef.current = 0;
    }, []);

    useEffect(() => {
        if (!root) return;

        root.addEventListener('scroll', syncFollowGates, { passive: true });
        syncFollowGates();
        return () => root.removeEventListener('scroll', syncFollowGates);
    }, [root, syncFollowGates]);

    useEffect(() => {
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
        // Design §47: the capsule never survives a chat switch. It cannot — the
        // new chat lands at its own latest message, and this is that landing.
        setAwayFromLatest(false);
    }, [root, messageIds, isGenerating, chatKey]);

    const scrollToBottom = useCallback(() => {
        if (!root) return;
        root.scrollTop = root.scrollHeight;
        wasAtBottomRef.current = true;
        setAwayFromLatest(false);
    }, [root]);

    return { awayFromLatest, scrollToBottom };
}

/**
 * Global Escape-to-stop-generation, owned by ChatUI itself rather than relying
 * on ST's native document keydown handler (script.js), which only fires when
 * $('#mes_stop').is(':visible') — true under the shield's current CSS-clip
 * hiding, but permanently false once #send_form is display:none. Mirrors ST's
 * own IME-composing guard. Skips entirely while a message is being edited:
 * MessageEditor's own Escape handler (cancel edit) calls stopPropagation(),
 * so this listener simply never sees the keydown in that case — matching ST's
 * native priority of "close edit box" over "stop generation".
 */
export function useEscapeToStopGeneration(isGenerating: boolean): void {
    useEffect(() => {
        if (!isGenerating) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.isComposing) return;
            event.preventDefault();
            stopChatuiGeneration();
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isGenerating]);
}
