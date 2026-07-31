/**
 * SillyTavern-ChatUI · 书脊入列规则 spine cast
 *
 * Who belongs on the spine, and in what order. Pure and dependency-free so the
 * rule can be unit-tested without a renderer — the same reason
 * floor-rail-math.ts / follow-scroll-math.ts live on their own — because the
 * rule is not a rendering detail: it decides whether a character the reader is
 * standing on is reachable at all.
 *
 * ## Membership
 *
 * The original filter was 「`chat_size > 0`」 alone, and its purpose is kept:
 * a character nobody has ever opened does not belong on a rail that answers
 * "who is on stage now" (Spine.tsx). But `chat_size` is a *disk snapshot*,
 * taken once per boot when ST enumerates each character's chats directory
 * (`processCharacter` → `calculateChatSize`, src/endpoints/characters.js), and
 * never refreshed inside the page. So the filter also answered "no" for three
 * characters ChatUI itself knows are live:
 *
 * - the character holding the stage right now — the spine's own contract
 *   claims to show exactly this, and it dropped it whenever the snapshot said
 *   zero (delete a character's last conversation, reload, and the character
 *   you are reading vanishes from the rail);
 * - a character holding a temp-chat quarantine lease — ChatUI is deliberately
 *   keeping an unadopted draft file for it;
 * - the character a queued-but-unresolved draft-quarantine credential names —
 *   the delete transaction is mid-flight and ST has not made its fallback file
 *   live yet (adapter/chats/deletion-finalization.ts).
 *
 * Membership is therefore the union of the four, and the union is over the
 * cast list itself (a filter, not a concatenation), so a character named by
 * several sources still occupies exactly one seat.
 *
 * ## Order
 *
 * Two bands, then recency inside each:
 *
 * 1. characters ChatUI knows are live while the disk snapshot still reports
 *    nothing (`chatSize <= 0`, i.e. enrolled *only* by one of the three
 *    session sources);
 * 2. everyone else, i.e. the ordinary cast the snapshot can speak for.
 *
 * Inside a band: `dateLastChatTs` descending, which is the order the spine has
 * always used. Band 1 exists because that key is not merely *old* for these
 * entries, it is *absent*: the same directory scan that reports `chat_size: 0`
 * reports `date_last_chat: 0`, so sorting them by it would push exactly the
 * characters this rule was added to rescue to the bottom of a rail that
 * scrolls. Anything ChatUI can see happening this session is more recent than
 * anything a boot-time snapshot can describe, so they lead.
 *
 * This changes nothing for the ordinary spine: a character with conversations
 * on disk is in band 2 whether or not it is also on stage or leased, so the
 * existing order is untouched and only otherwise-absent entries gain a
 * position.
 *
 * Ties (identical band and timestamp — which is every band-1 entry, since they
 * all carry 0) fall back to the incoming cast order, i.e. ST's own
 * `characters` array: `Array.prototype.sort` has been stable by specification
 * since ES2019, so this is a guarantee rather than an engine detail.
 */

export type SpineCastCandidate = {
    avatar: string;
    name: string;
    chatSize: number;
    dateLastChatTs: number;
};

/**
 * The three things ChatUI knows that a boot-time disk snapshot cannot. All
 * optional: passing none reproduces the plain 「has conversations on disk」
 * cast.
 */
export type SpineCastSources = {
    /** The character holding the stage, or null (nobody, or a group chat). */
    onStageAvatar?: string | null;
    /** Every character holding a temp-chat quarantine lease. */
    leasedAvatars?: readonly string[];
    /** The character a pending draft-quarantine credential names, if any. */
    pendingDraftAvatar?: string | null;
};

function finiteNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Avatars ChatUI knows are live regardless of what the disk snapshot says. */
function sessionKnownAvatars(sources: SpineCastSources): Set<string> {
    const known = new Set<string>();
    if (sources.onStageAvatar) known.add(sources.onStageAvatar);
    for (const avatar of sources.leasedAvatars ?? []) {
        if (avatar) known.add(avatar);
    }
    if (sources.pendingDraftAvatar) known.add(sources.pendingDraftAvatar);
    return known;
}

/**
 * The cast list the spine renders: enrolled by the union above, ordered by the
 * two bands above.
 */
export function orderSpineCast<T extends SpineCastCandidate>(
    characters: readonly T[],
    sources: SpineCastSources = {},
): T[] {
    const known = sessionKnownAvatars(sources);
    return characters
        .filter((character: T) => !!character.avatar
            && !!character.name
            && (finiteNumber(character.chatSize) > 0 || known.has(character.avatar)))
        .sort((a: T, b: T) => {
            const bandA = finiteNumber(a.chatSize) > 0 ? 1 : 0;
            const bandB = finiteNumber(b.chatSize) > 0 ? 1 : 0;
            if (bandA !== bandB) return bandA - bandB;
            return finiteNumber(b.dateLastChatTs) - finiteNumber(a.dateLastChatTs);
        });
}
