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
