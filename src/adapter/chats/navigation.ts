import {
    createOrEditCharacter,
    doNewChat,
    getCurrentChatDetails,
    isChatSaving,
    openCharacterChat,
    saveSettingsDebounced,
    selectCharacterById,
    setActiveCharacter,
    setActiveGroup,
} from '@st/script';
import {
    type CharacterSwitchStatus,
    type ChatSwitchStatus,
    getCharacters,
    getCurrentCharacterId,
    getLiveCharacter,
    getStContext,
    stripChatExt,
} from './state.js';

/**
 * Mirror ST's own "remember who is selected" write after a programmatic
 * character selection.
 *
 * `selectCharacterById()` moves only the *live* selection (`this_chid`). The
 * persisted `active_character` that the next boot reads back
 * (RossAscends-mods.js's RA_autoloadchat, :272-287) is written nowhere inside
 * it: ST keeps that write in the delegated `.character_select` click handler
 * instead (RossAscends-mods.js:849-854). So every host path that selects a
 * character without going through that native list row — every path ChatUI
 * has — leaves the persisted pointer on whoever the reader last picked from
 * ST's own UI. With the spine as the only way to change character, that made
 * *any* reload (the mandatory one a current-chat delete forces, a manual
 * refresh, the disable-and-reload path) come back on a different character
 * than the one the reader was reading.
 *
 * Deliberately the same three calls that handler makes, in the same order: a
 * character selection must also retire any persisted group, or ST's boot
 * finds both set and drops the character (RA_autoloadchat :289-292).
 *
 * The live index is what gets passed, not the avatar, even though avatar is
 * this adapter's stable identity everywhere else: `getTagKeyForEntity()`
 * (tags.js:691-722) resolves an index unambiguously, but runs a string
 * through `parseInt()` first — an avatar like `3.png` would resolve to
 * `characters[3]`, a different card.
 *
 * That index goes over as a *string*, which is not cosmetic and not a style
 * choice: `setActiveCharacter` gates on truthiness before it resolves anything
 * (`active_character = entityOrKey ? getTagKeyForEntity(entityOrKey) : null`,
 * script.js:834-837). The number `0` — the first character in the list — is
 * falsy, so passing it would not persist that character but silently erase the
 * pointer, and the next boot would find nothing to come back to at all
 * (RA_autoloadchat skips the whole branch on a null `active_character`), which
 * is worse than the stale pointer this function exists to fix. ST's own
 * handler never hits that because `$(this).attr('data-chid')` is a DOM
 * attribute and therefore always a string; passing `String(index)` is
 * literally the same value it passes. `getTagKeyForEntity('0')` still resolves
 * through `parseInt()` to `characters[0]` — the ambiguity that rules out
 * strings above is about *avatars*, never about a stringified index.
 *
 * Never throws: failing to persist the selection must not fail the switch the
 * reader actually asked for.
 */
function persistStActiveCharacter(index: number): void {
    try {
        setActiveCharacter(String(index));
        setActiveGroup(null);
        saveSettingsDebounced();
    } catch (error) {
        console.error('[ChatUI] failed to persist ST active character', error);
    }
}

export async function openChatForCharacter(avatar: string, fileName: string): Promise<ChatSwitchStatus> {
    const ctx = getStContext();
    const characters = getCharacters(ctx);
    const index = characters.findIndex(character => character.avatar === avatar);
    if (index < 0) return 'notfound';

    const bareName = stripChatExt(fileName);
    if (!bareName) return 'notfound';

    if (!ctx.groupId && String(ctx.characterId) === String(index)) {
        const currentChat = stripChatExt(getCurrentChatDetails()?.sessionName);
        if (currentChat === bareName) return 'already-open';
        await openCharacterChat(bareName);
        return 'ok';
    }

    if (isChatSaving) return 'busy';
    const liveCharacter = getLiveCharacter(ctx, index);
    const previousChat = liveCharacter?.chat;
    try {
        if (liveCharacter) liveCharacter.chat = bareName;
        await selectCharacterById(index);

        const latest = getStContext();
        const selectedTarget = !latest.groupId && String(latest.characterId) === String(index);
        const openedTargetChat = stripChatExt(getCurrentChatDetails()?.sessionName) === bareName;
        if (!selectedTarget || !openedTargetChat) {
            const latestLiveCharacter = getLiveCharacter(latest, index);
            if (latestLiveCharacter) latestLiveCharacter.chat = previousChat;
            return 'busy';
        }
        // Only once the switch is confirmed landed: never persist a character
        // we failed to select.
        persistStActiveCharacter(index);

        await createOrEditCharacter(new CustomEvent('newChat'));
        return 'ok';
    } catch (error) {
        const latestLiveCharacter = getLiveCharacter(getStContext(), index);
        if (latestLiveCharacter) latestLiveCharacter.chat = previousChat;
        throw error;
    }
}

export async function switchCharacter(avatar: string): Promise<CharacterSwitchStatus> {
    if (typeof avatar !== 'string' || !avatar) return 'notfound';
    const ctx = getStContext();
    const characters = getCharacters(ctx);
    const index = characters.findIndex(character => character.avatar === avatar);
    if (index < 0) return 'notfound';
    if (!ctx.groupId && String(ctx.characterId) === String(index)) return 'ok';

    await selectCharacterById(index);
    if (String(getStContext().characterId) !== String(index)) return 'busy';
    persistStActiveCharacter(index);
    return 'ok';
}

/**
 * Land on a character *only* if ST's boot stopped short of choosing anybody.
 *
 * `power_user.auto_load_chat` is **false** by default (power-user.js:335), and
 * this repo's e2e fixture is the reason that was easy to miss — it forces the
 * flag on (scripts/e2e/generate-data-root.mjs). On a stock install, the reload
 * a current-chat delete forces comes back with no character selected at all,
 * so the fallback file ST was supposed to materialize is never written, the
 * draft-quarantine credential waits forever, and the reader is left standing
 * in front of nothing with the transaction they started half-applied.
 *
 * Finishing it is this function's whole purpose, and the guard is what keeps it
 * from being something else. It refuses the moment anybody already holds the
 * stage — a group, or the character the reader's own `auto_load_chat` setting
 * brought back — because in that case ST *did* express a preference and the
 * pending credential's ordinary semantics ("if this file goes live, it is a
 * draft") still apply, unchanged, whenever the reader walks over. Completing a
 * transaction the reader committed to is not the same as overriding the
 * autoload preference they chose, and this refusal is the difference.
 *
 * `characters` is fully loaded well before the only caller runs: ST awaits
 * `getCharacters()` in `firstLoadInit` (script.js:757) many steps before it
 * emits APP_READY (script.js:788). `notfound` is therefore a real absence
 * (the card was deleted between the two page loads), not an early read.
 *
 * Persisting the landing mirrors every other selection that lands
 * (persistStActiveCharacter): `active_character` is "who was last selected",
 * not a preference, and we did just select them. A host that ignores
 * `auto_load_chat` never reads it back, so this cannot smuggle autoload in.
 */
export async function selectCharacterIfNobodyIsOnStage(
    avatar: string,
): Promise<'selected' | 'occupied' | 'notfound' | 'refused'> {
    if (typeof avatar !== 'string' || !avatar) return 'notfound';
    const ctx = getStContext();
    if (ctx.groupId) return 'occupied';
    if (getCurrentCharacterId(ctx) !== null) return 'occupied';

    const index = getCharacters(ctx).findIndex(character => character.avatar === avatar);
    if (index < 0) return 'notfound';

    await selectCharacterById(index);
    // ST silently returns from selectCharacterById while a chat is saving, so
    // the landing is confirmed rather than assumed — exactly as switchCharacter
    // does, and for the same reason: never persist a selection that failed.
    if (String(getStContext().characterId) !== String(index)) return 'refused';
    persistStActiveCharacter(index);
    return 'selected';
}

export async function openCharacterChatByName(fileName: string): Promise<void> {
    const name = stripChatExt(fileName);
    if (!name) return;
    await openCharacterChat(name);
}

export async function newCharacterChat(): Promise<void> {
    await doNewChat({ deleteCurrentChat: false });
}
