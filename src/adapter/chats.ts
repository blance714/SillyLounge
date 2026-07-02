/**
 * SillyTavern-ChatUI · chat-file adapter
 */

import {
    createOrEditCharacter,
    deleteCharacterChatByName,
    doNewChat,
    getCurrentChatDetails,
    getPastCharacterChats,
    getRequestHeaders,
    getThumbnailUrl,
    isChatSaving,
    openCharacterChat,
    renameChat,
    selectCharacterById,
} from '@st/script';
import { timestampToMoment } from '@st/utils';
import { getContext } from './internals.js';
import {
    type StCharacter,
    type StChatRow,
    type UnknownRecord,
    parseCharacters,
    parseChatRows,
    parseOptionalRecord,
    parseRecord,
    parseRecordArray,
    stringValue,
} from './schema.js';

type StContext = {
    characterId?: unknown;
    groupId?: unknown;
    characters?: unknown;
    reloadCurrentChat?: () => Promise<void> | void;
};

type LiveCharacterRecord = { chat?: unknown };
type ReadChatFileOptions = { signal?: AbortSignal };
type CharacterChatSnapshot = { metadata: UnknownRecord | null; messages: UnknownRecord[] };

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

type ChatSwitchStatus = 'ok' | 'notfound' | 'already-open' | 'busy';
type CharacterSwitchStatus = 'ok' | 'notfound' | 'busy';
type CharacterChatsOptions = { limit?: number | null; signal?: AbortSignal };

// ── Sidebar / conversation list (Region 5) ────────────────────────────────────

function _getContext(): StContext {
    return getContext() as StContext;
}

function _getCharacters(ctx: StContext = _getContext()): StCharacter[] {
    return parseCharacters(ctx.characters);
}

function _getLiveCharacter(ctx: StContext, index: number): LiveCharacterRecord | null {
    const rawCharacters = ctx.characters;
    const character = Array.isArray(rawCharacters) ? rawCharacters[index] : null;
    return character && typeof character === 'object' && !Array.isArray(character)
        ? character as LiveCharacterRecord
        : null;
}

// ST chat-list endpoints return `.jsonl` names; open/rename/delete expect bare names.
function _stripChatExt(fileName: unknown): string {
    return stringValue(fileName).replace(/\.jsonl$/i, '');
}

// ChatUI treats zero-message and greeting-only chats as fresh new chats.
function _hasNoUserTurn(messages: unknown): boolean {
    const rows = parseRecordArray(messages);
    return rows.length === 0 || !rows.some(message => message.is_user === true);
}

/**
 * @param {StContext} [ctx]
 * @returns {number|null}
 */
function _getCurrentCharacterId(ctx: StContext = _getContext()): number | null {
    const windowChid = typeof window !== 'undefined'
        ? /** @type {Window & { this_chid?: unknown }} */ (window).this_chid
        : undefined;
    const raw = ctx.characterId ?? windowChid;
    if (raw === undefined || raw === null || raw === '') return null;

    const id = Number(raw);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

function _findCharacterIndexByAvatar(avatar: string): number {
    return _getCharacters().findIndex(character => character.avatar === avatar);
}

/**
 * Read a character chat file without changing the active ST chat.
 * @param {number} characterId
 * @param {string} fileName Bare chat file name.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<CharacterChatSnapshot|null>}
 */
async function _readCharacterChatFile(
    characterId: number,
    fileName: string,
    { signal }: ReadChatFileOptions = {},
): Promise<CharacterChatSnapshot | null> {
    const characters = _getCharacters();
    const character = characters[characterId];
    const chName = character?.name ?? '';
    const avatar = character?.avatar ?? '';
    if (!chName || !avatar || !fileName) return null;

    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        signal,
        body: JSON.stringify({
            ch_name: chName,
            file_name: fileName,
            avatar_url: avatar,
        }),
    });
    if (!response.ok) return null;

    const data = await response.json() as unknown;
    if (!Array.isArray(data) || data.length === 0) return null;

    const [headerValue, ...messageValues] = data;
    const header = parseRecord(headerValue);
    const metadata = parseOptionalRecord(header.chat_metadata);
    return { metadata, messages: messageValues.map(parseRecord) };
}

/**
 * Normalize a chat's `last_mes` (epoch-ms number for empty chats, or an ST date
 * string for non-empty ones) into a sort key + a compact display label, using
 * ST's own timestampToMoment so parsing matches native behaviour.
 * @param {unknown} lastMes
 * @returns {{ ts: number, label: string }}
 */
function _chatTimestamp(lastMes: unknown): { ts: number; label: string } {
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

/**
 * Shared mapping from a raw ST chat summary entry to a ChatListItemDto.
 * Handles both recent rows (`chat_items`/`mes`) and search rows
 * (`message_count`/`preview_message`).
 * @param {StChatRow} entry
 * @param {string} currentChatName  Bare session name from _stripChatExt(getCurrentChatDetails()?.sessionName)
 * @param {boolean} ownerMatchesCurrent Whether this chat belongs to the current character
 * @returns {ChatListItemDto}
 */
function _mapChatEntry(entry: StChatRow, currentChatName: string, ownerMatchesCurrent = true): ChatListItemDto {
    const fileName = _stripChatExt(entry.file_name || entry.file_id);
    const { ts, label } = _chatTimestamp(entry.last_mes);
    // ST fills `mes` with a bracketed placeholder for empty chats/messages;
    // blank it so the row preview stays clean.
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

/**
 * @param {StContext} [ctx]
 * @returns {{ currentChatName: string, currentAvatar: string }}
 */
function _getCurrentChatMatch(ctx: StContext = _getContext()): { currentChatName: string; currentAvatar: string } {
    const currentChatName = _stripChatExt(getCurrentChatDetails()?.sessionName);
    const currentCharId = !ctx.groupId
        ? _getCurrentCharacterId(ctx)
        : null;
    const characters = _getCharacters(ctx);
    const currentAvatar = currentCharId !== null ? characters[currentCharId]?.avatar ?? '' : '';
    return { currentChatName, currentAvatar };
}

/**
 * List the current character's past chats as plain DTOs, newest-first.
 * ST's getPastCharacterChats sorts ALPHABETICALLY by file_name, so we re-sort by
 * last activity here. Returns [] in a group chat or when no character is
 * selected (Mode A is single-character).
 * @returns {Promise<ChatListItemDto[]>}
 */
export async function listCharacterChats(): Promise<ChatListItemDto[]> {
    const ctx = _getContext();
    if (ctx.groupId) return [];
    const characterId = ctx.characterId;
    if (characterId === undefined || characterId === null || characterId === '') return [];

    const raw = await getPastCharacterChats(Number(characterId)) as unknown;
    const currentName = _stripChatExt(getCurrentChatDetails()?.sessionName);

    const items = parseChatRows(raw).map(chat => {
        return _mapChatEntry(chat, currentName, true);
    });

    items.sort((a, b) => b.lastMesTs - a.lastMesTs);
    return items;
}

/**
 * List chats for ANY character by index.
 * Uses /api/characters/chats (metadata only — no full JSONL reads).
 * @param {number} charIndex
 * @param {{ limit?: number|null }} [options]
 * @returns {Promise<ChatListItemDto[]>}
 */
async function _listChatsForCharacter(charIndex: number, { limit = null }: { limit?: number | null } = {}): Promise<ChatListItemDto[]> {
    const raw = await getPastCharacterChats(charIndex) as unknown;
    const ctx = _getContext();
    const currentName = _stripChatExt(getCurrentChatDetails()?.sessionName);
    const currentCharId = !ctx.groupId && ctx.characterId !== undefined && ctx.characterId !== null
        ? Number(ctx.characterId)
        : -1;
    const ownerMatchesCurrent = Number(charIndex) === currentCharId;
    const items = parseChatRows(raw).map(chat => {
        return _mapChatEntry(chat, currentName, ownerMatchesCurrent);
    });
    items.sort((a, b) => b.lastMesTs - a.lastMesTs);
    return typeof limit === 'number' ? items.slice(0, limit) : items;
}

/**
 * Header-only character groups from ST's in-memory character list.
 * No network calls.
 * @returns {CharConversationGroupDto[]}
 */
export function listCharacterConversationHeaders(): CharConversationGroupDto[] {
    const ctx = _getContext();
    const rawChars = _getCharacters(ctx);
    const currentCharId = !ctx.groupId ? _getCurrentCharacterId(ctx) : null;

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

/**
 * Recent chat rows across all entities. Only single-character rows are returned.
 * @param {{ max?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{ avatar: string, chat: ChatListItemDto }>>}
 */
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
    const { currentChatName, currentAvatar } = _getCurrentChatMatch();
    return rows
        .filter(row => row.avatar && !row.group)
        .map(row => {
            const avatar = row.avatar;
            return {
                avatar,
                chat: _mapChatEntry(row, currentChatName, avatar === currentAvatar),
            };
        })
        .filter(row => row.chat.fileName);
}

/**
 * List chats for a character avatar via the same search endpoint ST's native
 * past-chats popup uses.
 * @param {string} avatar
 * @param {{ limit?: number|null, signal?: AbortSignal }} [options]
 * @returns {Promise<{ chats: ChatListItemDto[], totalCount: number }>}
 */
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
    const { currentChatName, currentAvatar } = _getCurrentChatMatch();
    const chats = rows
        .map(row => _mapChatEntry(row, currentChatName, avatar === currentAvatar))
        .filter(chat => chat.fileName)
        .sort((a, b) => b.lastMesTs - a.lastMesTs);
    return {
        chats: typeof limit === 'number' ? chats.slice(0, limit) : chats,
        totalCount: chats.length,
    };
}

/**
 * Open a specific past chat, switching to a different character if necessary.
 * @param {string} avatar  Stable character avatar identifier
 * @param {string} fileName  Chat file name (bare or with .jsonl)
 * @returns {Promise<'ok'|'notfound'|'already-open'|'busy'>}
 */
export async function openChatForCharacter(avatar: string, fileName: string): Promise<ChatSwitchStatus> {
    const ctx = _getContext();
    const characters = _getCharacters(ctx);
    const index = characters.findIndex(character => character.avatar === avatar);
    if (index < 0) return 'notfound';

    const bareName = _stripChatExt(fileName);
    if (!bareName) return 'notfound';

    if (!ctx.groupId && String(ctx.characterId) === String(index)) {
        // Already on this character — check if the target chat is already open
        const currentChat = _stripChatExt(getCurrentChatDetails()?.sessionName);
        if (currentChat === bareName) return 'already-open';
        await openCharacterChat(bareName);
        return 'ok';
    } else {
        if (isChatSaving) return 'busy';
        const liveCharacter = _getLiveCharacter(ctx, index);
        const previousChat = liveCharacter?.chat;
        try {
            // Pre-set the desired chat file so selectCharacterById's getChat()
            // call loads it directly. On success, persist with the same exported
            // save path openCharacterChat uses; if the switch/load fails, rollback
            // this in-memory hint so another character is not left polluted.
            if (liveCharacter) liveCharacter.chat = bareName;
            await selectCharacterById(index);

            const latest = _getContext();
            const selectedTarget = !latest.groupId && String(latest.characterId) === String(index);
            const openedTargetChat = _stripChatExt(getCurrentChatDetails()?.sessionName) === bareName;
            if (!selectedTarget || !openedTargetChat) {
                const latestLiveCharacter = _getLiveCharacter(latest, index);
                if (latestLiveCharacter) latestLiveCharacter.chat = previousChat;
                return 'busy';
            }

            await createOrEditCharacter(new CustomEvent('newChat'));
            return 'ok';
        } catch (error) {
            const latestLiveCharacter = _getLiveCharacter(_getContext(), index);
            if (latestLiveCharacter) latestLiveCharacter.chat = previousChat;
            throw error;
        }
    }
}

/**
 * All loaded characters as plain DTOs for the Mode-A character switcher.
 * `avatar` is the STABLE id (the numeric chid index is unstable across
 * getCharacters() reloads, so never persist it); isCurrent compares the index
 * to getContext().characterId (= stringified this_chid).
 * @returns {CharacterSummaryDto[]}
 */
export function listCharacters(): CharacterSummaryDto[] {
    const ctx = _getContext();
    const characters = _getCharacters(ctx);
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

/**
 * Switch the active character by STABLE avatar (resolves to the current index
 * fresh, since the index isn't stable). ST's selectCharacterById fires
 * CHAT_CHANGED on success → sidebar auto-refresh. Returns a status so the caller
 * can distinguish a real failure from ST deferring the switch:
 * - 'ok'       switched (or already current)
 * - 'notfound' avatar not in the loaded list
 * - 'busy'     ST skipped it (chat saving / generation in flight)
 * @param {string} avatar
 * @returns {Promise<'ok'|'notfound'|'busy'>}
 */
export async function switchCharacter(avatar: string): Promise<CharacterSwitchStatus> {
    if (typeof avatar !== 'string' || !avatar) return 'notfound';
    const ctx = _getContext();
    const characters = _getCharacters(ctx);
    const index = characters.findIndex(character => character.avatar === avatar);
    if (index < 0) return 'notfound';
    if (!ctx.groupId && String(ctx.characterId) === String(index)) return 'ok';

    await selectCharacterById(index);
    return String(_getContext().characterId) === String(index) ? 'ok' : 'busy';
}

/**
 * Active character + chat header for the conversation list. Strips ST's group
 * object down to a boolean so no live ST object escapes the adapter.
 * @returns {{ sessionName: string, characterName: string, avatarImgURL: string, isGroup: boolean }}
 */
export function getCurrentChatHeader(): CurrentChatHeaderDto {
    const details = parseRecord(getCurrentChatDetails());
    return {
        sessionName: _stripChatExt(details.sessionName),
        characterName: stringValue(details.characterName),
        avatarImgURL: stringValue(details.avatarImgURL),
        isGroup: !!_getContext().groupId,
    };
}

/**
 * Current single-character chat identity. Returns null for groups, no selected
 * character, or a missing session name.
 * @returns {{ avatar: string, fileName: string }|null}
 */
export function getCurrentChatIdentity(): CurrentChatIdentityDto | null {
    const ctx = _getContext();
    if (ctx.groupId) return null;

    const characterId = _getCurrentCharacterId(ctx);
    if (characterId === null) return null;

    const characters = _getCharacters(ctx);
    const avatar = characters[characterId]?.avatar ?? '';
    const fileName = _stripChatExt(getCurrentChatDetails()?.sessionName);

    return avatar && fileName ? { avatar, fileName } : null;
}

/**
 * Open one of the current character's past chats by bare file name (no .jsonl).
 * Requires the live ST DOM (#selected_chat_pole) + a selected character — both
 * hold here since the shield keeps native DOM alive.
 * @param {string} fileName
 * @returns {Promise<void>}
 */
export async function openCharacterChatByName(fileName: string): Promise<void> {
    const name = _stripChatExt(fileName);
    if (!name) return;
    await openCharacterChat(name);
}

/**
 * Create a new chat for the currently-selected character.
 * @returns {Promise<void>}
 */
export async function newCharacterChat(): Promise<void> {
    await doNewChat({ deleteCurrentChat: false });
}

/**
 * Re-read a temp chat immediately before deleting it. Missing files are treated
 * as already gone; files containing a user turn are kept.
 * @param {string} avatar
 * @param {string} fileName Bare chat file name.
 * @returns {Promise<boolean>}
 */
export async function deleteChatFileIfSafe(avatar: string, fileName: string): Promise<boolean> {
    const bareName = _stripChatExt(fileName);
    const index = _findCharacterIndexByAvatar(avatar);
    if (index < 0 || !bareName) return false;

    const current = getCurrentChatIdentity();
    if (current?.avatar === avatar && current?.fileName === bareName) return false;

    let snapshot: CharacterChatSnapshot | null = null;
    try {
        snapshot = await _readCharacterChatFile(index, bareName);
    } catch {
        return true;
    }

    if (!snapshot) return true;
    if (!_hasNoUserTurn(snapshot.messages)) return false;

    await deleteCharacterChatByName(index, bareName);
    return true;
}

/**
 * Rename a chat of the CURRENT character (ST's renameChat operates on this_chid).
 * Pass bare names — ST appends `.jsonl` itself. ST shows its own error popup and
 * emits CHAT_RENAMED on success (sidebar auto-refresh), so this never throws on a
 * server-side failure.
 * @param {string} oldFileName
 * @param {string} newName
 * @returns {Promise<boolean>}
 */
export async function renameCharacterChat(oldFileName: string, newName: string): Promise<boolean> {
    const oldBare = _stripChatExt(oldFileName);
    const next = typeof newName === 'string' ? _stripChatExt(newName).trim() : '';
    if (!oldBare || !next) return false;
    await renameChat(oldBare, next);
    return true;
}

/**
 * Delete a chat of a character (by stable avatar). Uses the importable
 * deleteCharacterChatByName (delChat is private). Pass a bare name — ST appends
 * `.jsonl`. If the deleted chat was the active one, ST repoints the character's
 * chat but does NOT reload the view, so reload it here.
 * @param {string} avatar
 * @param {string} fileName
 * @returns {Promise<boolean>}
 */
export async function deleteCharacterChat(avatar: string, fileName: string): Promise<boolean> {
    const ctx = _getContext();
    const characters = _getCharacters(ctx);
    const index = characters.findIndex(character => character.avatar === avatar);
    const bareName = _stripChatExt(fileName);
    if (index < 0 || !bareName) return false;

    const wasCurrent = !ctx.groupId
        && String(ctx.characterId) === String(index)
        && _stripChatExt(getCurrentChatDetails()?.sessionName) === bareName;
    await deleteCharacterChatByName(index, bareName);

    const remainingChats = await _listChatsForCharacter(index);
    const deleted = !remainingChats.some(chat => chat.fileName === bareName);
    if (!deleted) return false;

    const latest = _getContext();
    if (wasCurrent && typeof latest.reloadCurrentChat === 'function') {
        // ST set the character's chat to the newest remaining (or a fresh) chat
        // without loading it; reload so the main surface leaves the deleted chat.
        await latest.reloadCurrentChat();
    }
    return true;
}
