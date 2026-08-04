import {
    getCurrentChatDetails,
    getPastCharacterChats,
    getRequestHeaders,
    getThumbnailUrl,
} from '@st/script';
import { timestampToMoment } from '@st/utils';
import {
    type StCharacter,
    type StChatRow,
    parseChatRows,
} from '../schema.js';
import {
    type CharacterChatsOptions,
    type CharacterSummaryDto,
    type CharConversationGroupDto,
    type ChatListItemDto,
    getCharacters,
    getCurrentCharacterId,
    getStContext,
    stripChatExt,
    type StContext,
} from './state.js';
import { listRawCharacterChatNames } from './selection-protocol.js';

function chatTimestamp(lastMes: unknown): { ts: number; label: string } {
    const moment = timestampToMoment(lastMes);
    if (!moment || typeof moment.isValid !== 'function' || !moment.isValid()) {
        return { ts: 0, label: '' };
    }
    return {
        ts: moment.valueOf(),
        label: moment.calendar(null, {
            sameDay: 'HH:mm',
            lastDay: '[昨天]',
            lastWeek: 'dddd',
            sameElse: 'YYYY-MM-DD',
        }),
    };
}

/** Map a raw ST chat summary from either the recent or search endpoint. */
function mapChatEntry(
    entry: StChatRow,
    currentChatName: string,
    ownerMatchesCurrent = true,
): ChatListItemDto {
    const fileName = stripChatExt(entry.file_name || entry.file_id);
    const { ts, label } = chatTimestamp(entry.last_mes);
    const rawPreview = entry.preview_message || entry.mes;
    const preview = /^\[The (chat|message) is empty\]$/.test(rawPreview) ? '' : rawPreview;
    // `?? null`, never `?? 0`: the two listing endpoints name the count
    // differently (`/api/chats/search` maps it to `message_count`,
    // `/api/chats/recent` and `/api/characters/chats` pass `chat_items`
    // straight through), and a row carrying neither has told us nothing — not
    // that the conversation is empty. See ChatListItemDto's own note.
    const messageCount = entry.message_count ?? entry.chat_items ?? null;
    return {
        fileName,
        displayName: fileName,
        messageCount,
        preview,
        fileSize: entry.file_size,
        lastMesTs: ts,
        lastMesLabel: label,
        isCurrent: ownerMatchesCurrent && fileName !== '' && fileName === currentChatName,
    };
}

function getCurrentChatMatch(
    ctx: StContext = getStContext(),
): { currentChatName: string; currentAvatar: string } {
    const currentChatName = stripChatExt(getCurrentChatDetails()?.sessionName);
    const currentCharId = !ctx.groupId ? getCurrentCharacterId(ctx) : null;
    const characters = getCharacters(ctx);
    const currentAvatar = currentCharId !== null ? characters[currentCharId]?.avatar ?? '' : '';
    return { currentChatName, currentAvatar };
}

export async function listCharacterChats(): Promise<ChatListItemDto[]> {
    const ctx = getStContext();
    if (ctx.groupId) return [];
    const characterId = ctx.characterId;
    if (characterId === undefined || characterId === null || characterId === '') return [];

    const raw = await getPastCharacterChats(Number(characterId)) as unknown;
    const currentName = stripChatExt(getCurrentChatDetails()?.sessionName);
    const items = parseChatRows(raw).map(chat => mapChatEntry(chat, currentName, true));
    items.sort((a, b) => b.lastMesTs - a.lastMesTs);
    return items;
}

/**
 * Whether ST would seed a new chat for this character with a greeting — i.e.
 * whether `getFirstMessage()` (script.js:7651) produces a message with any text
 * in it, which is the only thing `getChatResult()` will push.
 *
 * Mirrors that function rather than paraphrasing it, because the two differ in
 * ways that decide a card's border:
 *
 * - **`first_mes` is tested for truthiness, not for non-blankness.** ST does
 *   `characters[i].first_mes || ''`, so a greeting of only spaces is still a
 *   greeting: it gets pushed, the listing counts it, and the conversation is
 *   one nobody has written in. Trimming here would call that card written-in.
 * - **The alternate fallback takes the *first* alternate, not the first
 *   non-empty one.** ST builds `swipes = [first_mes, ...alternates]` and, when
 *   `first_mes` is empty, shifts that empty slot off and takes `swipes[0]`
 *   without looking at it. So `alternate_greetings: ['', '你好']` seeds
 *   *nothing*, and a one-message chat of that character is the reader's own
 *   line. Asking whether *some* alternate is non-empty gets that backwards and
 *   draws a written-in conversation as blank.
 *
 * The one thing this cannot mirror is `getRegexedString()`: a regex script with
 * AI_OUTPUT placement can empty a greeting on its way into the message, and
 * nothing in the character record says so. See ui/blank-conversation.ts, which
 * records that as the second of two accepted fooling states.
 */
function characterHasGreeting(entry: StCharacter): boolean {
    if (entry.first_mes !== '') return true;
    const alternates = entry.data?.alternate_greetings;
    return Array.isArray(alternates) && alternates.length > 0 && alternates[0] !== '';
}

export function listCharacterConversationHeaders(): CharConversationGroupDto[] {
    const ctx = getStContext();
    const rawChars = getCharacters(ctx);
    const currentCharId = !ctx.groupId ? getCurrentCharacterId(ctx) : null;

    return rawChars
        .map((entry, index): CharConversationGroupDto => {
            const avatar = entry.avatar;
            const name = entry.name;
            const chatSize = entry.chat_size;
            const dateLastChatTs = entry.date_last_chat;
            return {
                charId: index,
                avatar,
                name,
                thumbnailUrl: avatar && avatar !== 'none' ? getThumbnailUrl('avatar', avatar) : '',
                isCurrent: currentCharId !== null && index === currentCharId,
                dateLastChatTs,
                chatSize,
                hasGreeting: characterHasGreeting(entry),
                chats: [],
                visibleCount: 0,
                chatsLoaded: false,
                fullyLoaded: false,
                pending: null,
            };
        })
        .filter(group => group.name && group.avatar && group.chatSize > 0)
        .sort((a, b) => b.dateLastChatTs - a.dateLastChatTs);
}

export async function listRecentCharacterChatRows(
    { max = 100, signal }: { max?: number; signal?: AbortSignal } = {},
): Promise<Array<{ avatar: string; chat: ChatListItemDto }>> {
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        signal,
        body: JSON.stringify({ max, metadata: false }),
    });
    if (!response.ok) throw new Error('recent-chats-failed');

    const data = await response.json() as unknown;
    const rows = parseChatRows(data);
    const { currentChatName, currentAvatar } = getCurrentChatMatch();
    return rows
        .filter(row => row.avatar && !row.group)
        .map(row => {
            const avatar = row.avatar;
            return {
                avatar,
                chat: mapChatEntry(row, currentChatName, avatar === currentAvatar),
            };
        })
        .filter(row => row.chat.fileName);
}

export async function listChatsForCharacterAvatar(
    avatar: string,
    { limit = null, signal }: CharacterChatsOptions = {},
): Promise<{ chats: ChatListItemDto[]; totalCount: number }> {
    if (typeof avatar !== 'string' || !avatar) return { chats: [], totalCount: 0 };
    const response = await fetch('/api/chats/search', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        signal,
        body: JSON.stringify({ query: '', avatar_url: avatar }),
    });
    if (!response.ok) throw new Error('character-chat-search-failed');

    const data = await response.json() as unknown;
    const rows = parseChatRows(data);
    const { currentChatName, currentAvatar } = getCurrentChatMatch();
    const chats = rows
        .map(row => mapChatEntry(row, currentChatName, avatar === currentAvatar))
        .filter(chat => chat.fileName)
        .sort((a, b) => b.lastMesTs - a.lastMesTs);
    return {
        chats: typeof limit === 'number' ? chats.slice(0, limit) : chats,
        totalCount: chats.length,
    };
}

export function listCharacters(): CharacterSummaryDto[] {
    const ctx = getStContext();
    const characters = getCharacters(ctx);
    const currentId = ctx.characterId;
    const hasCurrent = currentId !== undefined && currentId !== null && currentId !== '';

    return characters.map((entry, index) => {
        const avatar = entry.avatar;
        return {
            charId: index,
            avatar,
            name: entry.name,
            thumbnailUrl: avatar && avatar !== 'none' ? getThumbnailUrl('avatar', avatar) : '',
            fav: entry.fav,
            isCurrent: hasCurrent && !ctx.groupId && String(index) === String(currentId),
            dateLastChatTs: entry.date_last_chat,
            chatSize: entry.chat_size,
            hasGreeting: characterHasGreeting(entry),
        };
    });
}
