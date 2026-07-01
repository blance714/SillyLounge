import { useEffect } from 'preact/compat';
import { useQueryClient } from '@tanstack/react-query';
import { chatuiEventKeys, getChatuiCurrentChatIdentity, subscribeChatuiEvent } from './actions.js';
import { SIDEBAR_RECENTS_MAX, sidebarQueryKeys } from './sidebar-queries.js';

export function useStQueryBridge(): void {
    const queryClient = useQueryClient();

    useEffect(() => {
        const timers = new Set<ReturnType<typeof setTimeout>>();

        const schedule = (fn: () => void): void => {
            const timer = setTimeout(() => {
                timers.delete(timer);
                fn();
            }, 0);
            timers.add(timer);
        };

        const invalidateHeader = (): void => {
            void queryClient.invalidateQueries({ queryKey: sidebarQueryKeys.header() });
        };
        const invalidateCharacters = (): void => {
            void queryClient.invalidateQueries({ queryKey: sidebarQueryKeys.characters() });
        };
        const invalidateRecents = (): void => {
            void queryClient.invalidateQueries({ queryKey: sidebarQueryKeys.recents(SIDEBAR_RECENTS_MAX) });
        };
        const invalidateCurrentByCharacter = (): void => {
            const avatar = getChatuiCurrentChatIdentity()?.avatar;
            if (avatar) void queryClient.invalidateQueries({ queryKey: sidebarQueryKeys.byCharacter(avatar) });
        };
        const invalidateAllByCharacter = (): void => {
            void queryClient.invalidateQueries({ queryKey: sidebarQueryKeys.byCharacterAll() });
        };

        const subscriptions = [
            subscribeChatuiEvent(chatuiEventKeys.CHAT_CHANGED, () => schedule(() => {
                invalidateHeader();
                invalidateCharacters();
                invalidateCurrentByCharacter();
            })),
            subscribeChatuiEvent(chatuiEventKeys.CHAT_RENAMED, () => schedule(() => {
                invalidateHeader();
                invalidateCurrentByCharacter();
                invalidateRecents();
            })),
            subscribeChatuiEvent(chatuiEventKeys.CHAT_DELETED, () => schedule(() => {
                invalidateHeader();
                invalidateCharacters();
                invalidateCurrentByCharacter();
                invalidateAllByCharacter();
                invalidateRecents();
            })),
            subscribeChatuiEvent(chatuiEventKeys.MESSAGE_SENT, () => schedule(() => {
                invalidateCharacters();
                invalidateCurrentByCharacter();
                invalidateRecents();
            })),
            subscribeChatuiEvent(chatuiEventKeys.MESSAGE_RECEIVED, () => schedule(() => {
                invalidateCharacters();
                invalidateCurrentByCharacter();
                invalidateRecents();
            })),
            subscribeChatuiEvent(chatuiEventKeys.CHARACTER_EDITED, () => schedule(() => {
                invalidateHeader();
                invalidateCharacters();
                invalidateCurrentByCharacter();
            })),
            subscribeChatuiEvent(chatuiEventKeys.CHARACTER_DELETED, () => schedule(() => {
                invalidateCharacters();
                invalidateAllByCharacter();
                invalidateRecents();
            })),
            subscribeChatuiEvent(chatuiEventKeys.CHARACTER_DUPLICATED, () => schedule(() => {
                invalidateCharacters();
                invalidateAllByCharacter();
                invalidateRecents();
            })),
            subscribeChatuiEvent(chatuiEventKeys.CHARACTER_RENAMED, () => schedule(() => {
                invalidateCharacters();
                invalidateAllByCharacter();
                invalidateRecents();
            })),
            subscribeChatuiEvent(chatuiEventKeys.CHARACTER_PAGE_LOADED, () => schedule(() => {
                invalidateCharacters();
            })),
        ];

        return () => {
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            for (const unsubscribe of subscriptions) unsubscribe();
        };
    }, [queryClient]);
}

export function StQueryBridge(): null {
    useStQueryBridge();
    return null;
}
