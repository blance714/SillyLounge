import {
    clearTempChatIfMatches,
    deactivateTempChatIfMatches,
    getTempChatSnapshot,
} from './temp-chat-store.js';
import type { TempChatPointer, TempChatPointerSnapshot } from './temp-chat-store.js';

type ChatIdentity = { avatar: string; fileName: string } | null | undefined;

function sameChat(a: ChatIdentity, b: ChatIdentity): boolean {
    return !!a && !!b && a.avatar === b.avatar && a.fileName === b.fileName;
}

/** Prompt previews and quiet background probes do not mutate chat history. */
export function shouldAdoptTempChatOnGenerationStart(type: unknown, isDryRun: unknown): boolean {
    return type !== 'quiet' && isDryRun !== true;
}

/**
 * Capture departure after this navigation owns the host lane. This placement is
 * what closes `new still materializing -> click old chat`: the older task commits
 * its concrete pointer before the queued navigation takes this snapshot.
 */
export function prepareTempChatDeparture(
    current: ChatIdentity,
    hasLocalWork: (pointer: TempChatPointer) => boolean,
): TempChatPointerSnapshot {
    const snapshot = getTempChatSnapshot();
    if (snapshot.pointer && sameChat(snapshot.pointer, current) && hasLocalWork(snapshot.pointer)) {
        clearTempChatIfMatches(snapshot);
        return getTempChatSnapshot();
    }
    return snapshot;
}

/**
 * Successful navigation leaves the captured file quarantined, not published.
 * A no-op navigation to the same file must keep it active so later mutations
 * can still adopt it.
 */
export function finishTempChatDeparture(
    snapshot: TempChatPointerSnapshot,
    current: ChatIdentity,
): boolean {
    if (snapshot.pointer && sameChat(snapshot.pointer, current)) return false;
    return deactivateTempChatIfMatches(snapshot);
}
