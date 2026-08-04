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
    /**
     * How many messages the listing counted, or null when it did not say.
     *
     * Null is not decoration. Both consumers treat a count as evidence about
     * the file — the card meta prints 「N 条」, and ui/blank-conversation.ts
     * draws a dashed border on the strength of it — and `0` is not the absence
     * of that evidence, it is the strongest possible form of it (「nobody has
     * written here」). Collapsing an unanswered count into `0` therefore does
     * not lose information, it fabricates the opposite of it.
     */
    messageCount: number | null;
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
    /** Whether ST would seed a new chat for this character with a greeting. */
    hasGreeting: boolean;
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
    /** Whether ST would seed a new chat for this character with a greeting. */
    hasGreeting: boolean;
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
     * This conversation does not exist anywhere: the host's own raw directory
     * listing does not have the file, and nothing live is claiming the name
     * either. So there was nothing to delete and nothing failed. Distinct from
     * every other `deleted: false` outcome — those mean the delete was
     * attempted or abandoned and the file is (or may still be) on disk —
     * because the caller still has bookkeeping to settle either way: the
     * reader's intent ("this conversation should not exist") is satisfied, and
     * the sidebar's cached listing is still serving a row for a file nobody
     * will ever open (sidebar-actions.ts answers it with a composer-draft
     * delete plus `publishVanishedChat`).
     *
     * Two things it is deliberately never true for:
     * - a listing that could not be read — an unreadable directory is not
     *   evidence of absence;
     * - the chat the runtime is *standing in* — that conversation is alive and
     *   merely unsaved, and the next save writes its file back, so calling it
     *   absent would announce a vanished conversation the reader is looking at
     *   (delete-transaction.ts has the full argument).
     */
    absent: boolean;
    /**
     * Set only when deleting the *current* chat left its character with no
     * other real chat file to fall back to: the durable pointer was moved to
     * a fabricated name (delete-transaction.ts's `fallbackName`) that does
     * not exist yet. ST's own post-reload boot always materializes some file
     * there (greeting or empty, via getChatResult()'s unconditional
     * saveChatConditional()), and that file is simply this character's
     * conversation — which is what ST would have produced on its own.
     *
     * The caller reads this as a *boolean*: a non-null value means "this
     * character's history just became empty", which is the one condition under
     * which the reader has to be carried across the reload (a landing
     * credential naming the character, so the next boot can put them back and
     * the spine can still show someone whose `chat_size` snapshot predates that
     * boot's own write). DESIGN §3 / evaluation §5 3.6: never stop at
     * "character selected, no conversation". Null whenever a real
     * remaining/preferred chat was used instead, or the deletion did not target
     * the live current chat.
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
