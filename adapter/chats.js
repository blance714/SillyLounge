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
} from '../../../../../script.js';
import { timestampToMoment } from '../../../../utils.js';
import { getContext } from './internals.js';

// ── Sidebar / conversation list (Region 5) ────────────────────────────────────

/**
 * Strip ST's `.jsonl` chat extension. ST's chat-list endpoint returns names
 * WITH the extension, but open/rename/delete all expect the bare name.
 * @param {unknown} fileName
 * @returns {string}
 */
function _stripChatExt(fileName) {
    return typeof fileName === 'string' ? fileName.replace(/\.jsonl$/i, '') : '';
}

/**
 * ChatUI treats a fresh new chat as any loaded chat/file with no user turn yet.
 * This includes zero-message and greeting-only chats.
 * @param {unknown} messages
 * @returns {boolean}
 */
function _hasNoUserTurn(messages) {
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
function _findCharacterIndexByAvatar(avatar) {
    const characters = Array.isArray(getContext().characters) ? getContext().characters : [];
    return characters.findIndex(c => c?.avatar === avatar);
}

/**
 * Read a character chat file without changing the active ST chat.
 * @param {number} characterId
 * @param {string} fileName Bare chat file name.
 * @returns {Promise<{ metadata: Record<string, any>|null, messages: any[] }|null>}
 */
async function _readCharacterChatFile(characterId, fileName) {
    const characters = Array.isArray(getContext().characters) ? getContext().characters : [];
    const character = characters[characterId];
    const chName = typeof character?.name === 'string' ? character.name : '';
    const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
    if (!chName || !avatar || !fileName) return null;

    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
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
function _chatTimestamp(lastMes) {
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
 * @property {ChatListItemDto[]} chats  Up to 5, newest-first
 * @property {boolean} chatsLoaded  Whether chats have been successfully fetched
 */

/**
 * Shared mapping from a raw ST chat summary entry to a ChatListItemDto.
 * @param {Record<string, any>} entry
 * @param {string} currentChatName  Bare session name from _stripChatExt(getCurrentChatDetails()?.sessionName)
 * @param {boolean} ownerMatchesCurrent Whether this chat belongs to the current character
 * @returns {ChatListItemDto}
 */
function _mapChatEntry(entry, currentChatName, ownerMatchesCurrent = true) {
    const fileName = _stripChatExt(entry.file_name);
    const { ts, label } = _chatTimestamp(entry.last_mes);
    // ST fills `mes` with a bracketed placeholder for empty chats/messages;
    // blank it so the row preview stays clean.
    const rawPreview = typeof entry.mes === 'string' ? entry.mes : '';
    const preview = /^\[The (chat|message) is empty\]$/.test(rawPreview) ? '' : rawPreview;
    return {
        fileName,
        displayName: fileName,
        messageCount: typeof entry.chat_items === 'number' ? entry.chat_items : 0,
        preview,
        lastMesTs: ts,
        lastMesLabel: label,
        isCurrent: ownerMatchesCurrent && fileName !== '' && fileName === currentChatName,
    };
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
async function _listChatsForCharacter(charIndex, { limit = null } = {}) {
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
 * List up to 5 most-recent chats for ANY character by index.
 * @param {number} charIndex
 * @returns {Promise<ChatListItemDto[]>}
 */
export async function listChatsForCharacter(charIndex) {
    try {
        return await _listChatsForCharacter(charIndex, { limit: 5 });
    } catch {
        return [];
    }
}

/**
 * Build the character-grouped conversation list for the sidebar.
 * Characters are sorted by date_last_chat (most recently active first), capped at 50.
 * For each, fetches up to 5 chats via listChatsForCharacter (all in parallel).
 * @returns {Promise<CharConversationGroupDto[]>}
 */
export async function listCharacterConversations() {
    const ctx = getContext();
    const rawChars = Array.isArray(ctx.characters) ? ctx.characters : [];

    // Keep only valid single-character entries (no placeholders)
    const indexed = rawChars
        .map((char, index) => ({ char, index }))
        .filter(({ char }) => char && typeof char.name === 'string' && char.name);

    const currentCharId = !ctx.groupId
        ? (ctx.characterId !== undefined && ctx.characterId !== null ? Number(ctx.characterId) : -1)
        : -1;

    // Sort by date_last_chat descending (most recently active first)
    const sorted = indexed
        .slice()
        .sort((a, b) => ((b.char.date_last_chat || 0) - (a.char.date_last_chat || 0)));

    // Cap the recency list at 50, but always include the active character so
    // stale date_last_chat metadata cannot make the current owner disappear.
    const top = sorted.slice(0, 50);
    const currentEntry = currentCharId >= 0 ? indexed.find(({ index }) => index === currentCharId) : null;
    const capped = currentEntry && !top.some(({ index }) => index === currentCharId)
        ? [currentEntry, ...top]
        : top;

    const results = await Promise.allSettled(
        capped.map(({ index }) => listChatsForCharacter(index)),
    );

    return capped.map(({ char, index }, i) => {
        const result = results[i];
        const avatar = typeof char.avatar === 'string' ? char.avatar : '';
        return {
            charId: index,
            avatar,
            name: typeof char.name === 'string' ? char.name : '',
            thumbnailUrl: avatar && avatar !== 'none' ? getThumbnailUrl('avatar', avatar) : '',
            isCurrent: index === currentCharId,
            chats: result.status === 'fulfilled' ? result.value : [],
            chatsLoaded: result.status === 'fulfilled',
        };
    });
}

/**
 * Open a specific past chat, switching to a different character if necessary.
 * @param {string} avatar  Stable character avatar identifier
 * @param {string} fileName  Chat file name (bare or with .jsonl)
 * @returns {Promise<'ok'|'notfound'|'already-open'|'busy'>}
 */
export async function openChatForCharacter(avatar, fileName) {
    const ctx = getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const index = characters.findIndex(c => c?.avatar === avatar);
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
 * @returns {Array<{ avatar: string, name: string, thumbnailUrl: string, fav: boolean, isCurrent: boolean }>}
 */
export function listCharacters() {
    const ctx = getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const currentId = ctx.characterId;
    const hasCurrent = currentId !== undefined && currentId !== null && currentId !== '';

    return characters.map((char, index) => {
        const entry = /** @type {Record<string, any>} */ (char ?? {});
        const avatar = typeof entry.avatar === 'string' ? entry.avatar : '';
        return {
            avatar,
            name: typeof entry.name === 'string' ? entry.name : '',
            thumbnailUrl: avatar && avatar !== 'none' ? getThumbnailUrl('avatar', avatar) : '',
            fav: entry.fav === true || entry.fav === 'true',
            isCurrent: hasCurrent && !ctx.groupId && String(index) === String(currentId),
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
export async function switchCharacter(avatar) {
    if (typeof avatar !== 'string' || !avatar) return 'notfound';
    const ctx = getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const index = characters.findIndex(c => c?.avatar === avatar);
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
export async function openCharacterChatByName(fileName) {
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
export async function deleteChatFileIfSafe(avatar, fileName) {
    const bareName = _stripChatExt(fileName);
    const index = _findCharacterIndexByAvatar(avatar);
    if (index < 0 || !bareName) return false;

    const current = getCurrentChatIdentity();
    if (current?.avatar === avatar && current?.fileName === bareName) return false;

    let snapshot = null;
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
export async function renameCharacterChat(oldFileName, newName) {
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
export async function deleteCharacterChat(avatar, fileName) {
    const ctx = getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const index = characters.findIndex(c => c?.avatar === avatar);
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
