import {
    getCurrentChatDetails,
    getPastCharacterChats,
    getRequestHeaders,
    getThumbnailUrl,
} from '@st/script';
import { timestampToMoment } from '@st/utils';
import {
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
    const messageCount = entry.message_count ?? entry.chat_items ?? 0;
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
        };
    });
}
