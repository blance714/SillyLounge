import {
    getChatuiCurrentChatHeader,
    listChatuiCharacters,
    listChatuiChatsForCharacterAvatar,
    listChatuiRecentCharacterChatRows,
} from './actions.js';

export const SIDEBAR_RECENTS_MAX = 100;
export const SIDEBAR_INITIAL_VISIBLE = 5;
export const SIDEBAR_MORE_SIZE = 50;
export const SIDEBAR_BACKFILL_CONCURRENCY = 4;

export const sidebarQueryKeys = {
    all: () => ['chatui'] as const,
    characters: () => ['chatui', 'characters'] as const,
    header: () => ['chatui', 'sidebar', 'header'] as const,
    recents: (max = SIDEBAR_RECENTS_MAX) => ['chatui', 'recents', { max }] as const,
    byCharacter: (avatar: string) => ['chatui', 'byCharacter', avatar] as const,
    byCharacterAll: () => ['chatui', 'byCharacter'] as const,
};

export const sidebarQueryOptions = {
    characters: () => ({
        queryKey: sidebarQueryKeys.characters(),
        queryFn: () => listChatuiCharacters(),
        staleTime: 60_000,
    }),
    header: () => ({
        queryKey: sidebarQueryKeys.header(),
        queryFn: () => getChatuiCurrentChatHeader(),
        staleTime: 1_000,
    }),
    recents: (max = SIDEBAR_RECENTS_MAX) => ({
        queryKey: sidebarQueryKeys.recents(max),
        queryFn: ({ signal }: { signal?: AbortSignal }) => listChatuiRecentCharacterChatRows({ max, signal }),
        staleTime: 5_000,
    }),
    byCharacter: (avatar: string) => ({
        queryKey: sidebarQueryKeys.byCharacter(avatar),
        queryFn: ({ signal }: { signal?: AbortSignal }) => listChatuiChatsForCharacterAvatar(avatar, { signal }),
        staleTime: 10_000,
    }),
};
