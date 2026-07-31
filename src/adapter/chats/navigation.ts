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
 * Never throws: failing to persist the selection must not fail the switch the
 * reader actually asked for.
 */
function persistStActiveCharacter(index: number): void {
    try {
        setActiveCharacter(index);
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

export async function openCharacterChatByName(fileName: string): Promise<void> {
    const name = stripChatExt(fileName);
    if (!name) return;
    await openCharacterChat(name);
}

export async function newCharacterChat(): Promise<void> {
    await doNewChat({ deleteCurrentChat: false });
}
