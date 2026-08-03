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
 * - every character ChatUI itself gave a conversation this session, whether by
 *   ＋新对话 or by the reload that follows deleting a character's last one
 *   (store/session-characters.ts, which is where the argument for why an
 *   in-memory ledger is the right shape lives).
 *
 * Membership is therefore the union of the three, and the union is over the
 * cast list itself (a filter, not a concatenation), so a character named by
 * several sources still occupies exactly one seat.
 *
 * That second source used to be two — a temp-chat quarantine lease and a
 * pending draft-quarantine credential — because the retired 「未完成草稿」 tier
 * happened to be tracking the same characters for an unrelated reason. Both
 * were answering this question by accident; the ledger answers it on purpose.
 *
 * ## Order
 *
 * Two bands, then recency inside each:
 *
 * 1. characters ChatUI knows are live while the disk snapshot still reports
 *    nothing (`chatSize <= 0`, i.e. enrolled *only* by a session source);
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
 * The two things ChatUI knows that a boot-time disk snapshot cannot. Both
 * optional: passing neither reproduces the plain 「has conversations on disk」
 * cast.
 */
export type SpineCastSources = {
    /** The character holding the stage, or null (nobody, or a group chat). */
    onStageAvatar?: string | null;
    /** Characters ChatUI itself gave a conversation this session. */
    sessionAvatars?: readonly string[];
};

function finiteNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Avatars ChatUI knows are live regardless of what the disk snapshot says. */
function sessionKnownAvatars(sources: SpineCastSources): Set<string> {
    const known = new Set<string>();
    if (sources.onStageAvatar) known.add(sources.onStageAvatar);
    for (const avatar of sources.sessionAvatars ?? []) {
        if (avatar) known.add(avatar);
    }
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
