/**
 * SillyTavern-ChatUI · chat actions
 *
 * Store-facing action facade. UI modules dispatch user intents here instead of
 * reaching into SillyTavern DOM or adapter fallback details.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';
import { pushToast, dismissToast } from './toast-store.js';

/**
 * @param {number|string} messageId
 * @param {'copy'|'regen'|'edit'|'delete'|'branch'|'checkpoint'|'hide'} action
 * @returns {void}
 */
export function triggerChatuiMessageAction(messageId, action) {
    const result = chatuiAdapter.messageActions.triggerMessageActionById(messageId, action);
    if (action === 'copy') {
        Promise.resolve(result)
            .then(() => notifyChatui('success', '已复制'))
            .catch(() => notifyChatui('error', '复制失败'));
    }
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
    const stopped = chatuiAdapter.composerActions.stopGeneration();
    if (!stopped) notifyChatui('info', '没有正在生成的内容');
}

/**
 * @param {'characters'|'characterCreate'|'groupChats'|'aiConfig'|'formatting'|'worldInfo'|'background'|'userSettings'|'extensions'|'personas'} action
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

/**
 * Enumerate visible quick-reply buttons from ST's #qr--bar.
 * Rebuilds the id→element map on each call (ST rebuilds the bar on changes).
 * @returns {{ id: string, label: string, title: string, iconHtml: string }[]}
 */
export function listChatuiQuickReplies() {
    return chatuiAdapter.qrActions.listQuickReplies();
}

/**
 * Proxy a click onto the live QR button identified by `id`.
 * Only fires the primary click; context-menu actions are out of scope.
 * @param {string} id opaque id from listChatuiQuickReplies()
 * @returns {boolean}
 */
export function triggerChatuiQuickReply(id) {
    return chatuiAdapter.qrActions.triggerQuickReply(id);
}

/**
 * Subscribe to #qr--bar DOM changes (ST rebuilds the bar on chat / set changes).
 * The observer is coalesced via requestAnimationFrame; returns an unsubscribe.
 * @param {() => void} cb
 * @returns {() => void}
 */
export function subscribeChatuiQuickReplies(cb) {
    return chatuiAdapter.qrActions.subscribeQuickReplies(cb);
}

/**
 * Show a ChatUI-owned toast (success / error / info feedback).
 * @param {'info'|'success'|'error'} kind
 * @param {string} text
 * @param {number} [ttl]
 * @returns {string}
 */
export function notifyChatui(kind, text, ttl) {
    return pushToast(kind, text, ttl);
}

/**
 * @param {string} id
 * @returns {void}
 */
export function dismissChatuiToast(id) {
    dismissToast(id);
}

// ---------------------------------------------------------------------------
// Embed-engine: relocate / restore live ST drawer-content nodes   /* TEMP M-G S0 POC */
// ---------------------------------------------------------------------------

/**
 * Move a live ST .drawer-content node into a ChatUI-owned host element.
 * @param {string} drawerContentId  id of the .drawer-content element
 * @param {Element} hostEl          ChatUI host container
 * @returns {boolean}
 */
export function mountChatuiStDrawer(drawerContentId, hostEl) { /* TEMP M-G S0 POC */
    return chatuiAdapter.settingsActions.mountDrawer(drawerContentId, hostEl);
}

/**
 * Restore a previously-mounted ST .drawer-content node to its original position.
 * @param {string} drawerContentId  id of the .drawer-content element
 * @returns {boolean}
 */
export function unmountChatuiStDrawer(drawerContentId) { /* TEMP M-G S0 POC */
    return chatuiAdapter.settingsActions.unmountDrawer(drawerContentId);
}
