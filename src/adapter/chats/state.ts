import { getCurrentChatDetails } from '@st/script';
import { getContext } from '../internals.js';
import {
    type StCharacter,
    parseCharacters,
    parseRecord,
    stringValue,
} from '../schema.js';

export type ChatListItemDto = {
    fileName: string;
    displayName: string;
    messageCount: number;
    preview: string;
    fileSize: string;
    lastMesTs: number;
    lastMesLabel: string;
    isCurrent: boolean;
};

export type CharConversationGroupDto = {
    charId: number;
    avatar: string;
    name: string;
    thumbnailUrl: string;
    isCurrent: boolean;
    dateLastChatTs: number;
    chatSize: number;
    chats: ChatListItemDto[];
    visibleCount: number;
    chatsLoaded: boolean;
    fullyLoaded: boolean;
    pending: null | 'backfill' | 'more' | 'refresh' | 'error';
};

export type CharacterSummaryDto = {
    avatar: string;
    name: string;
    thumbnailUrl: string;
    fav: boolean;
    isCurrent: boolean;
    charId: number;
    dateLastChatTs: number;
    chatSize: number;
};

export type CurrentChatHeaderDto = {
    sessionName: string;
    characterName: string;
    avatarImgURL: string;
    isGroup: boolean;
};

export type CurrentChatIdentityDto = {
    avatar: string;
    fileName: string;
};

export type DeleteCharacterChatResultDto = Readonly<{
    deleted: boolean;
    reconciled: boolean;
    uncertain: boolean;
    reloadRequired: boolean;
    /**
     * Set only when deleting the *current* chat left its character with no
     * other real chat file to fall back to: the durable pointer was moved to
     * a fabricated name (delete-transaction.ts's `fallbackName`) that does
     * not exist yet. ST's own post-reload boot always materializes some file
     * there (greeting or empty, via getChatResult()'s unconditional
     * saveChatConditional()) — this is the name of that file, so the caller
     * can fold it into the same draft quarantine every other new chat goes
     * through instead of leaving it as an unlabelled permanent history entry
     * (DESIGN §3 / evaluation §5 3.6: never stop at "character selected, no
     * conversation"). Null whenever a real remaining/preferred chat was used
     * instead, or the deletion did not target the live current chat.
     */
    fallbackChatFileName: string | null;
}>;

export type RenameCharacterChatResultDto = Readonly<{
    renamed: boolean;
    reconciled: boolean;
    uncertain: boolean;
    reloadRequired: boolean;
    avatar: string;
    oldFileName: string;
    newFileName: string;
    oldChatKey: string;
    newChatKey: string;
}>;

export type ChatSwitchStatus = 'ok' | 'notfound' | 'already-open' | 'busy';
export type CharacterSwitchStatus = 'ok' | 'notfound' | 'busy';
export type CharacterChatsOptions = { limit?: number | null; signal?: AbortSignal };

export type StContext = {
    characterId?: unknown;
    groupId?: unknown;
    characters?: unknown;
    reloadCurrentChat?: () => Promise<void> | void;
};

export type LiveCharacterRecord = { chat?: unknown };

export function getStContext(): StContext {
    return getContext() as StContext;
}

export function getCharacters(ctx: StContext = getStContext()): StCharacter[] {
    return parseCharacters(ctx.characters);
}

export function getLiveCharacter(ctx: StContext, index: number): LiveCharacterRecord | null {
    const rawCharacters = ctx.characters;
    const character = Array.isArray(rawCharacters) ? rawCharacters[index] : null;
    return character && typeof character === 'object' && !Array.isArray(character)
        ? character as LiveCharacterRecord
        : null;
}

// ST chat-list endpoints return `.jsonl` names; open/rename/delete expect bare names.
export function stripChatExt(fileName: unknown): string {
    return stringValue(fileName).replace(/\.jsonl$/i, '');
}

export function getCurrentCharacterId(ctx: StContext = getStContext()): number | null {
    const windowChid = typeof window !== 'undefined'
        ? /** @type {Window & { this_chid?: unknown }} */ (window).this_chid
        : undefined;
    const raw = ctx.characterId ?? windowChid;
    if (raw === undefined || raw === null || raw === '') return null;

    const id = Number(raw);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

export function setLiveCharacterChatIfMatches(
    avatar: string,
    expected: string,
    fileName: string,
): boolean {
    const context = getStContext();
    const index = getCharacters(context).findIndex(character => character.avatar === avatar);
    const liveCharacter = index >= 0 ? getLiveCharacter(context, index) : null;
    if (!liveCharacter || stripChatExt(liveCharacter.chat) !== expected) return false;
    liveCharacter.chat = fileName;
    return true;
}

/** Active character + chat header for the conversation list. */
export function getCurrentChatHeader(): CurrentChatHeaderDto {
    const details = parseRecord(getCurrentChatDetails());
    return {
        sessionName: stripChatExt(details.sessionName),
        characterName: stringValue(details.characterName),
        avatarImgURL: stringValue(details.avatarImgURL),
        isGroup: !!getStContext().groupId,
    };
}

/** Current single-character chat identity, or null when no character chat is active. */
export function getCurrentChatIdentity(): CurrentChatIdentityDto | null {
    const ctx = getStContext();
    if (ctx.groupId) return null;

    const characterId = getCurrentCharacterId(ctx);
    if (characterId === null) return null;

    const characters = getCharacters(ctx);
    const avatar = characters[characterId]?.avatar ?? '';
    const fileName = stripChatExt(getCurrentChatDetails()?.sessionName);

    return avatar && fileName ? { avatar, fileName } : null;
}
