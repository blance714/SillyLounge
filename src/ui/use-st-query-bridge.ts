import { useEffect } from 'preact/compat';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import { createBoundedWorkCoordinator } from '../store/bounded-work-coordinator.js';
import {
    chatuiEventKeys,
    disableChatui,
    getChatuiCurrentChatIdentity,
    subscribeChatuiEvent,
    subscribeVanishedChatuiChats,
} from './actions.js';
import { SIDEBAR_BACKFILL_CONCURRENCY, SIDEBAR_RECENTS_MAX, sidebarQueryKeys } from './sidebar-queries.js';

export type SidebarInvalidationScope =
    | 'header'
    | 'characters'
    | 'recents'
    | 'current-character'
    | 'all-characters';

/**
 * Single source of truth for translating ST domain events into sidebar cache
 * invalidations. Keeping this declarative makes omissions visible and lets the
 * event/cache contract be unit-tested without mounting Preact.
 *
 * ST's events are not the only input this bridge has to serve: a file that
 * vanished behind the host's back produces no event at all, and ChatUI's own
 * discovery of it arrives through store/vanished-chat-store.ts instead (wired
 * below, same translation job).
 */
export const SIDEBAR_INVALIDATIONS_BY_EVENT: Readonly<Record<string, readonly SidebarInvalidationScope[]>> = Object.freeze({
    [chatuiEventKeys.CHAT_CHANGED]: ['header', 'characters', 'current-character'],
    [chatuiEventKeys.CHAT_RENAMED]: ['header', 'current-character', 'recents'],
    // all-characters already includes the current character prefix; listing both
    // would mark the just-started fetch dirty and force a redundant follow-up.
    [chatuiEventKeys.CHAT_DELETED]: ['header', 'characters', 'all-characters', 'recents'],
    [chatuiEventKeys.MESSAGE_SENT]: ['characters', 'current-character', 'recents'],
    [chatuiEventKeys.MESSAGE_RECEIVED]: ['characters', 'current-character', 'recents'],
    [chatuiEventKeys.MESSAGE_UPDATED]: ['characters', 'current-character', 'recents'],
    [chatuiEventKeys.MESSAGE_DELETED]: ['characters', 'current-character', 'recents'],
    [chatuiEventKeys.MESSAGE_SWIPED]: ['characters', 'current-character', 'recents'],
    [chatuiEventKeys.CHARACTER_EDITED]: ['header', 'characters', 'current-character'],
    [chatuiEventKeys.CHARACTER_DELETED]: ['characters', 'all-characters', 'recents'],
    [chatuiEventKeys.CHARACTER_DUPLICATED]: ['characters', 'all-characters', 'recents'],
    [chatuiEventKeys.CHARACTER_RENAMED]: ['characters', 'all-characters', 'recents'],
    [chatuiEventKeys.CHARACTER_PAGE_LOADED]: ['characters'],
});

export function useStQueryBridge(): void {
    const queryClient = useQueryClient();

    useEffect(() => {
        const timers = new Set<ReturnType<typeof setTimeout>>();
        let disposed = false;
        const refetchCoordinator = createBoundedWorkCoordinator(
            SIDEBAR_BACKFILL_CONCURRENCY,
            error => console.error('[ChatUI] bounded character refetch failed', error),
        );

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
        const invalidateByCharacter = (avatar: string | undefined): void => {
            if (!avatar) return;
            const prefix = sidebarQueryKeys.byCharacter(avatar);
            void queryClient.invalidateQueries({ queryKey: prefix, refetchType: 'none' });
            enqueueLoadableByCharacterRefetches(prefix);
        };
        const invalidateCurrentByCharacter = (): void => {
            invalidateByCharacter(getChatuiCurrentChatIdentity()?.avatar);
        };
        const enqueueLoadableByCharacterRefetches = (prefix: QueryKey): void => {
            const loadableQueries = queryClient.getQueryCache()
                .findAll({ queryKey: prefix })
                .filter(query => query.isActive() || query.state.fetchStatus !== 'idle');
            for (const query of loadableQueries) {
                const existing = query.promise;
                refetchCoordinator.enqueue({
                    key: query.queryHash,
                    run: async () => {
                        // A first inactive prefetch is considered "disabled" by
                        // refetchQueries and its old success clears isInvalidated.
                        // Await its exact public promise, then call Query.fetch()
                        // directly so a guaranteed post-event request runs even
                        // with zero observers and no prior data.
                        if (existing) {
                            try {
                                await existing;
                            } catch {
                                // A failed/cancelled stale request still needs the
                                // same post-event retry below.
                            }
                        }
                        if (disposed) return;
                        await query.fetch();
                    },
                });
            }
        };

        const invalidateAllByCharacter = (): void => {
            const prefix = sidebarQueryKeys.byCharacterAll();
            // Mark every cached group stale without letting Query fan them all out
            // at once. Active groups are then refetched through the same bounded
            // worker count used by initial sidebar backfill.
            void queryClient.invalidateQueries({ queryKey: prefix, refetchType: 'none' });
            enqueueLoadableByCharacterRefetches(prefix);
        };

        const invalidateScope = (scope: SidebarInvalidationScope): void => {
            switch (scope) {
                case 'header': invalidateHeader(); break;
                case 'characters': invalidateCharacters(); break;
                case 'recents': invalidateRecents(); break;
                case 'current-character': invalidateCurrentByCharacter(); break;
                case 'all-characters': invalidateAllByCharacter(); break;
            }
        };

        const subscriptions: Array<() => void> = [];
        const dispose = (): void => {
            disposed = true;
            refetchCoordinator.dispose();
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            for (const unsubscribe of subscriptions.reverse()) {
                try {
                    unsubscribe();
                } catch (error) {
                    console.error('[ChatUI] sidebar query subscription cleanup failed', error);
                }
            }
        };

        try {
            for (const [eventKey, scopes] of Object.entries(SIDEBAR_INVALIDATIONS_BY_EVENT)) {
                subscriptions.push(subscribeChatuiEvent(eventKey, () => schedule(() => {
                    for (const scope of scopes) invalidateScope(scope);
                })));
            }
            // A conversation ChatUI proved absent while settling something else
            // (store/vanished-chat-store.ts). The host announced nothing, so
            // both caches that can still be serving that file — this
            // character's own listing and the recents page the playbill falls
            // back to — are refetched from the only authority there is, the
            // host's directory. Not `characters`: ST's in-memory cast is not
            // re-read from disk here, so refetching it would return the same
            // stale numbers for the cost of a full fan-out.
            subscriptions.push(subscribeVanishedChatuiChats(vanished => {
                if (!vanished) return;
                schedule(() => {
                    invalidateByCharacter(vanished.avatar);
                    invalidateRecents();
                });
            }));
        } catch (error) {
            dispose();
            console.error('[ChatUI] sidebar query bridge initialization failed', error);
            queueMicrotask(() => disableChatui());
        }

        return dispose;
    }, [queryClient]);
}

export function StQueryBridge(): null {
    useStQueryBridge();
    return null;
}
