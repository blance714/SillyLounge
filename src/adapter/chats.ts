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

// ── Sidebar / conversation list (Region 5) ────────────────────────────────────

/**
 * Strip ST's `.jsonl` chat extension. ST's chat-list endpoint returns names
 * WITH the extension, but open/rename/delete all expect the bare name.
 * @param {unknown} fileName
 * @returns {string}
 */
function _stripChatExt(fileName: any) {
    return typeof fileName === 'string' ? fileName.replace(/\.jsonl$/i, '') : '';
}

/**
 * ChatUI treats a fresh new chat as any loaded chat/file with no user turn yet.
 * This includes zero-message and greeting-only chats.
 * @param {unknown} messages
 * @returns {boolean}
 */
function _hasNoUserTurn(messages: any) {
    return !Array.isArray(messages) || !messages.some(message => message?.is_user === true);
}

/**
 * @param {ReturnType<typeof getContext>} [ctx]
 * @returns {number|null}
 */
function _getCurrentCharacterId(ctx = getContext()) {
    const windowChid = typeof window !== 'undefined'
        ? /** @type {Window & { this_chid?: unknown }} */ (window).this_chid
        : undefined;
    const raw = ctx.characterId ?? windowChid;
    if (raw === undefined || raw === null || raw === '') return null;

    const id = Number(raw);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * @param {string} avatar
 * @returns {number}
 */
function _findCharacterIndexByAvatar(avatar: any) {
    const characters = Array.isArray(getContext().characters) ? getContext().characters : [];
    return characters.findIndex((c: any) => c?.avatar === avatar);
}

/**
 * Read a character chat file without changing the active ST chat.
 * @param {number} characterId
 * @param {string} fileName Bare chat file name.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ metadata: Record<string, any>|null, messages: any[] }|null>}
 */
type ReadChatFileOptions = { signal?: AbortSignal };
type CharacterChatSnapshot = { metadata: Record<string, any> | null; messages: any[] };

async function _readCharacterChatFile(
    characterId: number,
    fileName: string,
    { signal }: ReadChatFileOptions = {},
): Promise<CharacterChatSnapshot | null> {
    const characters = Array.isArray(getContext().characters) ? getContext().characters : [];
    const character = characters[characterId];
    const chName = typeof character?.name === 'string' ? character.name : '';
    const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
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

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const [header, ...messages] = data;
    const metadata = header && typeof header === 'object' ? (header.chat_metadata ?? null) : null;
    return { metadata, messages };
}

/**
 * Normalize a chat's `last_mes` (epoch-ms number for empty chats, or an ST date
 * string for non-empty ones) into a sort key + a compact display label, using
 * ST's own timestampToMoment so parsing matches native behaviour.
 * @param {number|string} lastMes
 * @returns {{ ts: number, label: string }}
 */
function _chatTimestamp(lastMes: any) {
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
 * @typedef {object} ChatListItemDto
 * @property {string} fileName
 * @property {string} displayName
 * @property {number} messageCount
 * @property {string} preview
 * @property {string} fileSize
 * @property {number} lastMesTs
 * @property {string} lastMesLabel
 * @property {boolean} isCurrent
 */

/**
 * @typedef {object} CharConversationGroupDto
 * @property {number} charId        Numeric index in characters[] (session-scoped, not stable across reload)
 * @property {string} avatar        Stable character identifier (file name, e.g. "Alice.png")
 * @property {string} name          Display name
 * @property {string} thumbnailUrl  From getThumbnailUrl('avatar', avatar) or '' for avatar==='none'
 * @property {boolean} isCurrent    Whether this is the currently-active character
 * @property {number} dateLastChatTs
 * @property {number} chatSize
 * @property {ChatListItemDto[]} chats
 * @property {number} visibleCount
 * @property {boolean} chatsLoaded
 * @property {boolean} fullyLoaded
 * @property {null|'backfill'|'more'|'refresh'|'error'} pending
 */

/**
 * @typedef {object} CharacterSummaryDto
 * @property {string} avatar
 * @property {string} name
 * @property {string} thumbnailUrl
 * @property {boolean} fav
 * @property {boolean} isCurrent
 * @property {number} charId
 * @property {number} dateLastChatTs
 * @property {number} chatSize
 */

/**
 * Shared mapping from a raw ST chat summary entry to a ChatListItemDto.
 * Handles both recent rows (`chat_items`/`mes`) and search rows
 * (`message_count`/`preview_message`).
 * @param {Record<string, any>} entry
 * @param {string} currentChatName  Bare session name from _stripChatExt(getCurrentChatDetails()?.sessionName)
 * @param {boolean} ownerMatchesCurrent Whether this chat belongs to the current character
 * @returns {ChatListItemDto}
 */
function _mapChatEntry(entry: any, currentChatName: any, ownerMatchesCurrent = true) {
    const fileName = _stripChatExt(entry.file_name ?? entry.file_id);
    const { ts, label } = _chatTimestamp(entry.last_mes);
    // ST fills `mes` with a bracketed placeholder for empty chats/messages;
    // blank it so the row preview stays clean.
    const rawPreview = typeof entry.preview_message === 'string'
        ? entry.preview_message
        : (typeof entry.mes === 'string' ? entry.mes : '');
    const preview = /^\[The (chat|message) is empty\]$/.test(rawPreview) ? '' : rawPreview;
    const messageCount = typeof entry.message_count === 'number'
        ? entry.message_count
        : (typeof entry.chat_items === 'number' ? entry.chat_items : 0);
    return {
        fileName,
        displayName: fileName,
        messageCount,
        preview,
        fileSize: typeof entry.file_size === 'string' ? entry.file_size : '',
        lastMesTs: ts,
        lastMesLabel: label,
        isCurrent: ownerMatchesCurrent && fileName !== '' && fileName === currentChatName,
    };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function _finiteNumber(value: any) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

/**
 * @param {ReturnType<typeof getContext>} [ctx]
 * @returns {{ currentChatName: string, currentAvatar: string }}
 */
function _getCurrentChatMatch(ctx = getContext()) {
    const currentChatName = _stripChatExt(getCurrentChatDetails()?.sessionName);
    const currentCharId = !ctx.groupId
        ? _getCurrentCharacterId(ctx)
        : null;
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const currentAvatar = currentCharId !== null && typeof characters[currentCharId]?.avatar === 'string'
        ? characters[currentCharId].avatar
        : '';
    return { currentChatName, currentAvatar };
}

/**
 * List the current character's past chats as plain DTOs, newest-first.
 * ST's getPastCharacterChats sorts ALPHABETICALLY by file_name, so we re-sort by
 * last activity here. Returns [] in a group chat or when no character is
 * selected (Mode A is single-character).
 * @returns {Promise<ChatListItemDto[]>}
 */
export async function listCharacterChats() {
    const ctx = getContext();
    if (ctx.groupId) return [];
    const characterId = ctx.characterId;
    if (characterId === undefined || characterId === null || characterId === '') return [];

    const raw = await getPastCharacterChats(Number(characterId));
    const currentName = _stripChatExt(getCurrentChatDetails()?.sessionName);

    const items = (Array.isArray(raw) ? raw : []).map(chat => {
        const entry = /** @type {Record<string, any>} */ (chat ?? {});
        return _mapChatEntry(entry, currentName, true);
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
async function _listChatsForCharacter(charIndex: any, { limit = null } = {}) {
    const raw = await getPastCharacterChats(charIndex);
    const ctx = getContext();
    const currentName = _stripChatExt(getCurrentChatDetails()?.sessionName);
    const currentCharId = !ctx.groupId && ctx.characterId !== undefined && ctx.characterId !== null
        ? Number(ctx.characterId)
        : -1;
    const ownerMatchesCurrent = Number(charIndex) === currentCharId;
    const items = (Array.isArray(raw) ? raw : []).map(chat => {
        const entry = /** @type {Record<string, any>} */ (chat ?? {});
        return _mapChatEntry(entry, currentName, ownerMatchesCurrent);
    });
    items.sort((a, b) => b.lastMesTs - a.lastMesTs);
    return typeof limit === 'number' ? items.slice(0, limit) : items;
}

/**
 * Header-only character groups from ST's in-memory character list.
 * No network calls.
 * @returns {CharConversationGroupDto[]}
 */
export function listCharacterConversationHeaders() {
    const ctx = getContext();
    const rawChars = Array.isArray(ctx.characters) ? ctx.characters : [];
    const currentCharId = !ctx.groupId ? _getCurrentCharacterId(ctx) : null;

    return rawChars
        .map((char: any, index: any) => {
            const entry = /** @type {Record<string, any>} */ (char ?? {});
            const avatar = typeof entry.avatar === 'string' ? entry.avatar : '';
            const name = typeof entry.name === 'string' ? entry.name : '';
            const chatSize = _finiteNumber(entry.chat_size);
            const dateLastChatTs = _finiteNumber(entry.date_last_chat);
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
        .filter((group: any) => group.name && group.avatar && group.chatSize > 0)
        .sort((a: any, b: any) => b.dateLastChatTs - a.dateLastChatTs);
}

/**
 * Recent chat rows across all entities. Only single-character rows are returned.
 * @param {{ max?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{ avatar: string, chat: ChatListItemDto }>>}
 */
export async function listRecentCharacterChatRows({ max = 100, signal }: { max?: number; signal?: AbortSignal } = {}) {
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        signal,
        body: JSON.stringify({ max, metadata: false }),
    });
    if (!response.ok) throw new Error('recent-chats-failed');

    const data = await response.json();
    const rows = Array.isArray(data) ? data : [];
    const { currentChatName, currentAvatar } = _getCurrentChatMatch();
    return rows
        .map(row => /** @type {Record<string, any>} */ (row ?? {}))
        .filter(row => typeof row.avatar === 'string' && row.avatar && !row.group)
        .map(row => ({
            avatar: row.avatar,
            chat: _mapChatEntry(row, currentChatName, row.avatar === currentAvatar),
        }))
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
    { limit = null, signal }: { limit?: number | null; signal?: AbortSignal } = {},
) {
    if (typeof avatar !== 'string' || !avatar) return { chats: [], totalCount: 0 };
    const response = await fetch('/api/chats/search', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        signal,
        body: JSON.stringify({ query: '', avatar_url: avatar }),
    });
    if (!response.ok) throw new Error('character-chat-search-failed');

    const data = await response.json();
    const rows = Array.isArray(data) ? data : [];
    const { currentChatName, currentAvatar } = _getCurrentChatMatch();
    const chats = rows
        .map(row => _mapChatEntry(/** @type {Record<string, any>} */ (row ?? {}), currentChatName, avatar === currentAvatar))
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
export async function openChatForCharacter(avatar: any, fileName: any) {
    const ctx = getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const index = characters.findIndex((c: any) => c?.avatar === avatar);
    if (index < 0) return 'notfound';
    const character = characters[index];

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
        const previousChat = typeof character?.chat === 'string' ? character.chat : '';
        try {
            // Pre-set the desired chat file so selectCharacterById's getChat()
            // call loads it directly. On success, persist with the same exported
            // save path openCharacterChat uses; if the switch/load fails, rollback
            // this in-memory hint so another character is not left polluted.
            character.chat = bareName;
            await selectCharacterById(index);

            const latest = getContext();
            const selectedTarget = !latest.groupId && String(latest.characterId) === String(index);
            const openedTargetChat = _stripChatExt(getCurrentChatDetails()?.sessionName) === bareName;
            if (!selectedTarget || !openedTargetChat) {
                const latestCharacters = Array.isArray(latest.characters) ? latest.characters : [];
                if (latestCharacters[index]) latestCharacters[index].chat = previousChat;
                return 'busy';
            }

            await createOrEditCharacter(new CustomEvent('newChat'));
            return 'ok';
        } catch (error) {
            const latestCharacters = Array.isArray(getContext().characters) ? getContext().characters : [];
            if (latestCharacters[index]) latestCharacters[index].chat = previousChat;
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
export function listCharacters() {
    const ctx = getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const currentId = ctx.characterId;
    const hasCurrent = currentId !== undefined && currentId !== null && currentId !== '';

    return characters.map((char: any, index: any) => {
        const entry = /** @type {Record<string, any>} */ (char ?? {});
        const avatar = typeof entry.avatar === 'string' ? entry.avatar : '';
        return {
            charId: index,
            avatar,
            name: typeof entry.name === 'string' ? entry.name : '',
            thumbnailUrl: avatar && avatar !== 'none' ? getThumbnailUrl('avatar', avatar) : '',
            fav: entry.fav === true || entry.fav === 'true',
            isCurrent: hasCurrent && !ctx.groupId && String(index) === String(currentId),
            dateLastChatTs: _finiteNumber(entry.date_last_chat),
            chatSize: _finiteNumber(entry.chat_size),
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
export async function switchCharacter(avatar: any) {
    if (typeof avatar !== 'string' || !avatar) return 'notfound';
    const ctx = getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const index = characters.findIndex((c: any) => c?.avatar === avatar);
    if (index < 0) return 'notfound';
    if (!ctx.groupId && String(ctx.characterId) === String(index)) return 'ok';

    await selectCharacterById(index);
    return String(getContext().characterId) === String(index) ? 'ok' : 'busy';
}

/**
 * Active character + chat header for the conversation list. Strips ST's group
 * object down to a boolean so no live ST object escapes the adapter.
 * @returns {{ sessionName: string, characterName: string, avatarImgURL: string, isGroup: boolean }}
 */
export function getCurrentChatHeader() {
    const details = /** @type {Record<string, any>} */ (getCurrentChatDetails() ?? {});
    return {
        sessionName: _stripChatExt(details.sessionName),
        characterName: typeof details.characterName === 'string' ? details.characterName : '',
        avatarImgURL: typeof details.avatarImgURL === 'string' ? details.avatarImgURL : '',
        isGroup: !!getContext().groupId,
    };
}

/**
 * Current single-character chat identity. Returns null for groups, no selected
 * character, or a missing session name.
 * @returns {{ avatar: string, fileName: string }|null}
 */
export function getCurrentChatIdentity() {
    const ctx = getContext();
    if (ctx.groupId) return null;

    const characterId = _getCurrentCharacterId(ctx);
    if (characterId === null) return null;

    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const avatar = typeof characters[characterId]?.avatar === 'string' ? characters[characterId].avatar : '';
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
export async function openCharacterChatByName(fileName: any) {
    const name = _stripChatExt(fileName);
    if (!name) return;
    await openCharacterChat(name);
}

/**
 * Create a new chat for the currently-selected character.
 * @returns {Promise<void>}
 */
export async function newCharacterChat() {
    await doNewChat({ deleteCurrentChat: false });
}

/**
 * Re-read a temp chat immediately before deleting it. Missing files are treated
 * as already gone; files containing any user turn are kept.
 * @param {string} avatar
 * @param {string} fileName Bare chat file name.
 * @returns {Promise<boolean>}
 */
export async function deleteChatFileIfSafe(avatar: any, fileName: any) {
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
export async function renameCharacterChat(oldFileName: any, newName: any) {
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
export async function deleteCharacterChat(avatar: any, fileName: any) {
    const ctx = getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const index = characters.findIndex((c: any) => c?.avatar === avatar);
    const bareName = _stripChatExt(fileName);
    if (index < 0 || !bareName) return false;

    const wasCurrent = !ctx.groupId
        && String(ctx.characterId) === String(index)
        && _stripChatExt(getCurrentChatDetails()?.sessionName) === bareName;
    await deleteCharacterChatByName(index, bareName);

    const remainingChats = await _listChatsForCharacter(index);
    const deleted = !remainingChats.some(chat => chat.fileName === bareName);
    if (!deleted) return false;

    if (wasCurrent && typeof getContext().reloadCurrentChat === 'function') {
        // ST set the character's chat to the newest remaining (or a fresh) chat
        // without loading it; reload so the main surface leaves the deleted chat.
        await getContext().reloadCurrentChat();
    }
    return true;
}
