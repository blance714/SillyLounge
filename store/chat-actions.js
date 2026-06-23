/**
 * SillyTavern-ChatUI · chat actions
 *
 * Store-facing action facade. UI modules dispatch user intents here instead of
 * reaching into SillyTavern DOM or adapter fallback details.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';

/**
 * @param {number|string} messageId
 * @param {'copy'|'regen'|'edit'|'delete'|'branch'|'checkpoint'|'hide'} action
 * @returns {void}
 */
export function triggerChatuiMessageAction(messageId, action) {
    chatuiAdapter.messageActions.triggerMessageActionById(messageId, action);
}

/**
 * @param {number|string} messageId
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function saveEditedChatuiMessage(messageId, text) {
    await chatuiAdapter.messageActions.saveMessageEditById(messageId, text);
}

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function sendChatuiComposerMessage(text) {
    await chatuiAdapter.composerActions.sendComposerMessage(text);
}

/**
 * @returns {void}
 */
export function stopChatuiGeneration() {
    chatuiAdapter.composerActions.stopGeneration();
}

/**
 * @param {'characters'|'characterCreate'|'groupChats'|'aiConfig'|'worldInfo'|'userSettings'|'extensions'|'personas'} action
 * @returns {void}
 */
export function triggerChatuiShellAction(action) {
    chatuiAdapter.shellActions.triggerShellAction(action);
}

/**
 * @param {number|string} messageId
 * @param {number} mediaIndex
 * @returns {void}
 */
export function openChatuiMessageMedia(messageId, mediaIndex) {
    chatuiAdapter.mediaActions.openMessageMedia(messageId, mediaIndex);
}

/**
 * @param {number|string} messageId
 * @param {number} fileIndex
 * @returns {void}
 */
export function openChatuiMessageFile(messageId, fileIndex) {
    chatuiAdapter.mediaActions.openMessageFile(messageId, fileIndex);
}

/**
 * @param {number|string} messageId
 * @param {'left'|'right'} direction
 * @returns {void}
 */
export function swipeChatuiMessage(messageId, direction) {
    chatuiAdapter.messageActions.swipeMessageById(messageId, direction);
}

/**
 * Continue the last message (generate more onto it).
 * @returns {void}
 */
export function continueChatuiGeneration() {
    chatuiAdapter.menuActions.continueMessage();
}

/**
 * Impersonate: have the model write the user's next message.
 * @returns {void}
 */
export function impersonateChatui() {
    chatuiAdapter.menuActions.impersonateMessage();
}

/**
 * Regenerate the last character message (solo or group, via ST's options path).
 * @returns {void}
 */
export function regenerateChatuiLast() {
    chatuiAdapter.menuActions.regenerateFromPlusMenu();
}

/**
 * Open SillyTavern's native file picker, optionally narrowing the accept filter.
 * @param {string|null} accept
 * @returns {void}
 */
export function openChatuiAttachmentPicker(accept = null) {
    chatuiAdapter.menuActions.openAttachmentPicker(accept);
}

/**
 * Subscribe a UI component to a raw ST event through the adapter boundary.
 * @param {string} key
 * @param {(...args: any[]) => void} handler
 * @returns {() => void}
 */
export function subscribeChatuiEvent(key, handler) {
    return chatuiAdapter.subscribe(key, handler);
}

/**
 * @returns {{ id: string, label: string, iconHtml: string }[]}
 */
export function listChatuiWandItems() {
    return chatuiAdapter.menuActions.listWandItems();
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function triggerChatuiWandItem(id) {
    return chatuiAdapter.menuActions.triggerWandItem(id);
}

/**
 * @returns {{ id: string, name: string, type: string, size: number }[]}
 */
export function getChatuiPendingAttachments() {
    return chatuiAdapter.menuActions.getPendingAttachments();
}

/**
 * @param {string} id
 * @returns {void}
 */
export function removeChatuiPendingAttachment(id) {
    chatuiAdapter.menuActions.removePendingAttachment(id);
}

/**
 * @param {() => void} handler
 * @returns {() => void}
 */
export function subscribeChatuiPendingAttachments(handler) {
    return chatuiAdapter.menuActions.subscribePendingChanged(handler);
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @returns {Promise<{ value: string, label: string, selected: boolean }[]>}
 */
export function getChatuiSelectorOptions(kind) {
    return chatuiAdapter.selectorActions.getSelectorOptions(kind);
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @returns {Promise<{ value: string, label: string }|null>}
 */
export function getChatuiSelectedSelector(kind) {
    return chatuiAdapter.selectorActions.getSelectedSelector(kind);
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @param {string} value
 * @returns {Promise<void>}
 */
export function selectChatuiSelector(kind, value) {
    return chatuiAdapter.selectorActions.selectSelector(kind, value);
}

/**
 * Subscribe to every selector-relevant ST event; returns one unsubscribe.
 * @param {() => void} cb
 * @returns {() => void}
 */
export function subscribeChatuiSelectorSync(cb) {
    const keys = ['PRESET_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'CONNECTION_PROFILE_LOADED', 'PERSONA_CHANGED', 'CHAT_CHANGED'];
    const offs = keys.map(key => chatuiAdapter.subscribe(key, cb));
    return () => offs.forEach(off => off());
}
