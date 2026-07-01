/**
 * SillyTavern-ChatUI · chat actions
 *
 * Store-facing action facade. UI modules dispatch user intents here instead of
 * reaching into SillyTavern DOM or adapter fallback details.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';
export { stEventKeys as chatuiEventKeys } from '../adapter/st-adapter.js';
import { pushToast, dismissToast } from './toast-store.js';

export type ChatuiMessageAction = 'copy' | 'regen' | 'edit' | 'delete' | 'branch' | 'checkpoint' | 'hide';
export type ChatuiShellAction = 'characters' | 'characterCreate' | 'groupChats' | 'aiConfig' | 'formatting' | 'worldInfo' | 'background' | 'userSettings' | 'extensions' | 'personas';
export type ChatuiSelectorKind = 'preset' | 'model' | 'persona';
export type ChatuiSwipeDirection = 'left' | 'right';
export type ChatuiToastKind = 'info' | 'success' | 'error';

/**
 * @param {number|string} messageId
 * @param {'copy'|'regen'|'edit'|'delete'|'branch'|'checkpoint'|'hide'} action
 * @returns {void}
 */
export function triggerChatuiMessageAction(messageId: number | string, action: ChatuiMessageAction) {
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
export async function saveEditedChatuiMessage(messageId: number | string, text: string) {
    await chatuiAdapter.messageActions.saveMessageEditById(messageId, text);
}

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function sendChatuiComposerMessage(text: string) {
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
export function triggerChatuiShellAction(action: ChatuiShellAction) {
    chatuiAdapter.shellActions.triggerShellAction(action);
}

/**
 * @param {number|string} messageId
 * @param {number} mediaIndex
 * @returns {void}
 */
export function openChatuiMessageMedia(messageId: number | string, mediaIndex: number) {
    chatuiAdapter.mediaActions.openMessageMedia(messageId, mediaIndex);
}

/**
 * @param {number|string} messageId
 * @param {number} fileIndex
 * @returns {void}
 */
export function openChatuiMessageFile(messageId: number | string, fileIndex: number) {
    chatuiAdapter.mediaActions.openMessageFile(messageId, fileIndex);
}

/**
 * @param {number|string} messageId
 * @param {'left'|'right'} direction
 * @returns {void}
 */
export function swipeChatuiMessage(messageId: number | string, direction: ChatuiSwipeDirection) {
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
export function openChatuiAttachmentPicker(accept: string | null = null) {
    chatuiAdapter.menuActions.openAttachmentPicker(accept);
}

/**
 * Subscribe a UI component to a raw ST event through the adapter boundary.
 * @param {string} key
 * @param {(...args: any[]) => void} handler
 * @returns {() => void}
 */
export function subscribeChatuiEvent(key: string, handler: (...args: any[]) => void) {
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
export function triggerChatuiWandItem(id: string) {
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
export function removeChatuiPendingAttachment(id: string) {
    chatuiAdapter.menuActions.removePendingAttachment(id);
}

/**
 * @param {() => void} handler
 * @returns {() => void}
 */
export function subscribeChatuiPendingAttachments(handler: () => void) {
    return chatuiAdapter.menuActions.subscribePendingChanged(handler);
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @returns {Promise<{ value: string, label: string, selected: boolean }[]>}
 */
export function getChatuiSelectorOptions(kind: ChatuiSelectorKind) {
    return chatuiAdapter.selectorActions.getSelectorOptions(kind);
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @returns {Promise<{ value: string, label: string }|null>}
 */
export function getChatuiSelectedSelector(kind: ChatuiSelectorKind) {
    return chatuiAdapter.selectorActions.getSelectedSelector(kind);
}

/**
 * @param {'preset'|'model'|'persona'} kind
 * @param {string} value
 * @returns {Promise<void>}
 */
export function selectChatuiSelector(kind: ChatuiSelectorKind, value: string) {
    return chatuiAdapter.selectorActions.selectSelector(kind, value);
}

/**
 * Subscribe to every selector-relevant ST event; returns one unsubscribe.
 * @param {() => void} cb
 * @returns {() => void}
 */
export function subscribeChatuiSelectorSync(cb: () => void) {
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
export function triggerChatuiQuickReply(id: string) {
    return chatuiAdapter.qrActions.triggerQuickReply(id);
}

/**
 * Subscribe to #qr--bar DOM changes (ST rebuilds the bar on chat / set changes).
 * The observer is coalesced via requestAnimationFrame; returns an unsubscribe.
 * @param {() => void} cb
 * @returns {() => void}
 */
export function subscribeChatuiQuickReplies(cb: () => void) {
    return chatuiAdapter.qrActions.subscribeQuickReplies(cb);
}

/**
 * Show a ChatUI-owned toast (success / error / info feedback).
 * @param {'info'|'success'|'error'} kind
 * @param {string} text
 * @param {number} [ttl]
 * @returns {string}
 */
export function notifyChatui(kind: ChatuiToastKind, text: string, ttl?: number) {
    return pushToast(kind, text, ttl);
}

/**
 * @param {string} id
 * @returns {void}
 */
export function dismissChatuiToast(id: string) {
    dismissToast(id);
}

// ---------------------------------------------------------------------------
// Embed-engine: relocate / restore live ST drawer-content nodes
// ---------------------------------------------------------------------------

/**
 * Move a live ST .drawer-content node into a ChatUI-owned host element.
 * @param {string} drawerContentId  id of the .drawer-content element
 * @param {Element} hostEl          ChatUI host container
 * @returns {boolean}
 */
export function mountChatuiStDrawer(drawerContentId: string, hostEl: Element) {
    return chatuiAdapter.settingsActions.mountDrawer(drawerContentId, hostEl);
}

/**
 * Restore a previously-mounted ST .drawer-content node to its original position.
 * @param {string} drawerContentId  id of the .drawer-content element
 * @returns {boolean}
 */
export function unmountChatuiStDrawer(drawerContentId: string) {
    return chatuiAdapter.settingsActions.unmountDrawer(drawerContentId);
}

/**
 * Return the full ordered ST settings entry list (static).
 * @returns {import('../adapter/settings.js').ST_SETTINGS_ENTRIES}
 */
export function listChatuiStSettingsEntries() {
    return chatuiAdapter.settingsActions.listEntries();
}
