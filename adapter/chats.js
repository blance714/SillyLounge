/**
 * SillyTavern-ChatUI · chat-file adapter
 */

import { deleteCharacterChatByName, doNewChat, getCurrentChatDetails, getPastCharacterChats, getThumbnailUrl, openCharacterChat, renameChat, selectCharacterById } from '../../../../../script.js';
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
 * List the current character's past chats as plain DTOs, newest-first.
 * ST's getPastCharacterChats sorts ALPHABETICALLY by file_name, so we re-sort by
 * last activity here. Returns [] in a group chat or when no character is
 * selected (Mode A is single-character).
 * @returns {Promise<Array<{ fileName: string, displayName: string, messageCount: number, preview: string, lastMesTs: number, lastMesLabel: string, isCurrent: boolean }>>}
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
            isCurrent: fileName !== '' && fileName === currentName,
        };
    });

    items.sort((a, b) => b.lastMesTs - a.lastMesTs);
    return items;
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

    const wasCurrent = _stripChatExt(getCurrentChatDetails()?.sessionName) === bareName;
    await deleteCharacterChatByName(index, bareName);

    if (wasCurrent) {
        // ST set the character's chat to the newest remaining (or a fresh) chat
        // without loading it; reload so the main surface leaves the deleted chat.
        await ctx.reloadCurrentChat();
    }
    return true;
}
