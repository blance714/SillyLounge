/**
 * SillyTavern-ChatUI · topbar 操作纯逻辑
 *
 * Two gates the topbar's title and its ⋯ menu both need, pulled out pure and
 * dependency-free (the same reason floor-rail-math.ts / follow-scroll-math.ts /
 * spine-cast.ts live on their own) because both decide whether a click is
 * allowed to reach a host-mutating action at all, not merely how something is
 * drawn.
 */

/** The chat a rename/delete affordance acts on — never a group (DESIGN §4.1). */
export type TopbarChatTarget = Readonly<{
    avatar: string;
    fileName: string;
    displayName: string;
}>;

export type TopbarRenameCommit = Readonly<{
    avatar: string;
    fileName: string;
    nextName: string;
}>;

/**
 * Decide what an Enter/blur-commit on the topbar's in-place rename input
 * should do. Returns `null` for every no-op case:
 *
 * - an empty or whitespace-only draft;
 * - a draft identical (after trim) to the name already on record — refusing
 *   here keeps a no-op keystroke from taking a slot in the host queue;
 * - a live chat identity that no longer matches the chat the rename was
 *   started against. The title's own rename UI is cancelled the moment the
 *   open chat changes underneath it (app.tsx), so this is normally
 *   unreachable by the time a user's Enter fires — but it is the same race
 *   TopbarMenu's pre-refactor `_isLiveTarget` guarded against, and it is
 *   cheap insurance against ever renaming a chat the reader is no longer
 *   looking at.
 */
export function resolveTopbarRenameCommit(
    target: TopbarChatTarget,
    draft: string,
    liveIdentity: { avatar: string; fileName: string } | null | undefined,
): TopbarRenameCommit | null {
    const nextName = draft.trim();
    if (!nextName || nextName === target.displayName) return null;
    if (!liveIdentity || liveIdentity.avatar !== target.avatar || liveIdentity.fileName !== target.fileName) {
        return null;
    }
    return { avatar: target.avatar, fileName: target.fileName, nextName };
}

export type BranchFromLastFloor = Readonly<{
    enabled: boolean;
    messageId: number | null;
}>;

/**
 * Whether the ⋯ menu's「从末楼开新分支」row may fire, and which message id it
 * should branch from. Mirrors app.tsx's `handleEditLast` gate (last message +
 * not currently generating) rather than inventing a new rule — branching from
 * a floor that is still being written would fork a reply that has not
 * finished landing.
 */
export function resolveBranchFromLastFloor(
    messageIds: readonly number[],
    isGenerating: boolean,
): BranchFromLastFloor {
    if (isGenerating || messageIds.length === 0) return { enabled: false, messageId: null };
    return { enabled: true, messageId: messageIds[messageIds.length - 1] };
}
