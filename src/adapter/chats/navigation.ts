import {
    createOrEditCharacter,
    doNewChat,
    getCurrentChatDetails,
    isChatSaving,
    openCharacterChat,
    selectCharacterById,
} from '@st/script';
import {
    type CharacterSwitchStatus,
    type ChatSwitchStatus,
    getCharacters,
    getLiveCharacter,
    getStContext,
    stripChatExt,
} from './state.js';

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
    return String(getStContext().characterId) === String(index) ? 'ok' : 'busy';
}

export async function openCharacterChatByName(fileName: string): Promise<void> {
    const name = stripChatExt(fileName);
    if (!name) return;
    await openCharacterChat(name);
}

export async function newCharacterChat(): Promise<void> {
    await doNewChat({ deleteCurrentChat: false });
}
