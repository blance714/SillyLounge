/**
 * SillyTavern-ChatUI · chat actions
 *
 * Store-facing action facade. UI modules dispatch user intents here instead of
 * reaching into SillyTavern DOM or adapter fallback details.
 */

import { chatuiAdapter, stEventKeys } from '../adapter/st-adapter.js';
export { stEventKeys as chatuiEventKeys } from '../adapter/st-adapter.js';
import {
    enqueueHostTask,
    HostOperationCancelledError,
} from './host-operation-queue.js';
import { pushToast, dismissToast } from './toast-store.js';

export type ChatuiMessageAction = 'copy' | 'regen' | 'edit' | 'delete' | 'branch' | 'checkpoint' | 'hide';
export type ChatuiSelectorKind = 'preset' | 'model' | 'persona';
export type ChatuiSwipeDirection = 'left' | 'right';
export type ChatuiToastKind = 'info' | 'success' | 'error';

class StaleChatOperationError extends Error {
    constructor() {
        super('[ChatUI] Chat changed before the queued operation could run');
        this.name = 'StaleChatOperationError';
    }
}

function enqueueChatBoundOperation(
    expectedChatKey: string,
    operation: () => Promise<void> | void,
): Promise<void> {
    return enqueueHostTask(async () => {
        if (!expectedChatKey || chatuiAdapter.getCurrentChatKey() !== expectedChatKey) {
            throw new StaleChatOperationError();
        }
        await operation();
    }, { rejectOnCancelled: true }).then(() => undefined);
}

function enqueueGenerationOperation(
    expectedChatKey: string,
    trigger: () => Promise<void> | void,
): Promise<void> {
    return enqueueHostTask(async () => {
        if (!expectedChatKey || chatuiAdapter.getCurrentChatKey() !== expectedChatKey) {
            throw new StaleChatOperationError();
        }
        if (chatuiAdapter.getGenerationState().isGenerating) {
            throw new Error('[ChatUI] Generation is already active');
        }

        let started = false;
        let resolveStarted: () => void = () => undefined;
        let resolveFinished: () => void = () => undefined;
        const startedPromise = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        const finishedPromise = new Promise<void>(resolve => {
            resolveFinished = resolve;
        });
        const unsubscribers: Array<() => void> = [];
        const cleanup = () => {
            for (const unsubscribe of unsubscribers.reverse()) {
                try {
                    unsubscribe();
                } catch (error) {
                    console.error('[ChatUI] generation subscription cleanup failed', error);
                }
            }
        };

        try {
            unsubscribers.push(chatuiAdapter.subscribe(stEventKeys.GENERATION_STARTED, () => {
                if (chatuiAdapter.getCurrentChatKey() !== expectedChatKey) return;
                started = true;
                resolveStarted();
            }));
            const finish = () => {
                if (started) resolveFinished();
            };
            unsubscribers.push(chatuiAdapter.subscribe(stEventKeys.GENERATION_STOPPED, finish));
            unsubscribers.push(chatuiAdapter.subscribe(stEventKeys.GENERATION_ENDED, finish));

            await trigger();
            await startedPromise;
            await finishedPromise;
        } finally {
            cleanup();
        }
    }, { rejectOnCancelled: true }).then(() => undefined);
}

function reportChatBoundFailure(label: string, error: unknown): void {
    if (error instanceof HostOperationCancelledError) return;
    console.error(`[ChatUI] ${label} failed`, error);
    notifyChatui(
        'error',
        error instanceof StaleChatOperationError ? '对话已切换，操作已取消' : '操作失败',
    );
}

export function isChatuiLifecycleCancellation(error: unknown): boolean {
    return error instanceof HostOperationCancelledError;
}

/**
 * @param {number|string} messageId
 * @param {'copy'|'regen'|'edit'|'delete'|'branch'|'checkpoint'|'hide'} action
 * @returns {void}
 */
export function triggerChatuiMessageAction(
    messageId: number | string,
    action: ChatuiMessageAction,
    expectedChatKey: string,
): void {
    const operation = action === 'regen'
        ? enqueueGenerationOperation(
            expectedChatKey,
            () => chatuiAdapter.messageActions.triggerMessageActionById(messageId, action),
        )
        : enqueueChatBoundOperation(
            expectedChatKey,
            () => chatuiAdapter.messageActions.triggerMessageActionById(messageId, action),
        );
    void operation
        .then(() => {
            if (action === 'copy') notifyChatui('success', '已复制');
        })
        .catch((error: unknown) => {
            if (isChatuiLifecycleCancellation(error)) return;
            if (action === 'copy') {
                console.error('[ChatUI] copy message failed', error);
                notifyChatui('error', '复制失败');
            } else {
                reportChatBoundFailure(`message action ${action}`, error);
            }
        });
}

/**
 * @param {number|string} messageId
 * @param {string} text
 * @returns {Promise<void>}
 */
export function saveEditedChatuiMessage(
    messageId: number | string,
    text: string,
    expectedChatKey: string,
): Promise<void> {
    return enqueueChatBoundOperation(
        expectedChatKey,
        () => chatuiAdapter.messageActions.saveMessageEditById(messageId, text),
    );
}

/**
 * Queue sends against navigation and reject a stale composer intent before it
 * can land in a different mutable ST chat context.
 */
export function sendChatuiComposerMessage(
    text: string,
    expectedChatKey: string,
    onAccepted: () => void,
): Promise<void> {
    return enqueueHostTask(async () => {
        if (!expectedChatKey || chatuiAdapter.getCurrentChatKey() !== expectedChatKey) {
            throw new StaleChatOperationError();
        }
        const operation = chatuiAdapter.composerActions.sendComposerMessage(text);
        let acceptanceError: unknown = null;
        try {
            await operation;
            onAccepted();
        } catch (error) {
            acceptanceError = error;
        }
        // Keep the shared host lane and global send gate owned until ST's full
        // generation lifecycle settles. Acceptance already committed the draft;
        // a later model error must not make the user message look unsent.
        let completionError: unknown = null;
        try {
            await operation.completion;
        } catch (error) {
            completionError = error;
        }
        if (acceptanceError) throw acceptanceError;
        if (completionError) throw completionError;
    }, { rejectOnCancelled: true }).then(() => undefined);
}

/**
 * @returns {void}
 */
export function stopChatuiGeneration() {
    const stopped = chatuiAdapter.composerActions.stopGeneration();
    if (!stopped) notifyChatui('info', '没有正在生成的内容');
}

/** Window event index.ts listens for to disable ChatUI from inside its own UI. */
export const CHATUI_DISABLE_EVENT = 'chatui:disable';

/**
 * Ask index.ts's bootstrap to disable ChatUI (persist the master toggle off,
 * then unmount the shield/store/Preact root). Decoupled via a plain window
 * event rather than an import: index.ts sits above the UI/store/adapter
 * layers and orchestrates all of them, so importing it back from here would
 * invert that layering.
 * @returns {void}
 */
export function disableChatui() {
    window.dispatchEvent(new CustomEvent(CHATUI_DISABLE_EVENT));
}

/**
 * @param {number|string} messageId
 * @param {number} mediaIndex
 * @returns {void}
 */
export function openChatuiMessageMedia(
    messageId: number | string,
    mediaIndex: number,
    expectedChatKey: string,
): void {
    void enqueueChatBoundOperation(expectedChatKey, () => {
        chatuiAdapter.mediaActions.openMessageMedia(messageId, mediaIndex);
    }).catch((error: unknown) => reportChatBoundFailure('open media', error));
}

/**
 * @param {number|string} messageId
 * @param {number} fileIndex
 * @returns {void}
 */
export function openChatuiMessageFile(
    messageId: number | string,
    fileIndex: number,
    expectedChatKey: string,
): void {
    void enqueueChatBoundOperation(expectedChatKey, () => {
        chatuiAdapter.mediaActions.openMessageFile(messageId, fileIndex);
    }).catch((error: unknown) => reportChatBoundFailure('open file', error));
}

/**
 * @param {number|string} messageId
 * @param {'left'|'right'} direction
 * @returns {void}
 */
export function swipeChatuiMessage(
    messageId: number | string,
    direction: ChatuiSwipeDirection,
    expectedChatKey: string,
): void {
    void enqueueChatBoundOperation(
        expectedChatKey,
        () => chatuiAdapter.messageActions.swipeMessageById(messageId, direction),
    ).catch((error: unknown) => reportChatBoundFailure('swipe message', error));
}

/**
 * Continue the last message (generate more onto it).
 * @returns {void}
 */
export function continueChatuiGeneration(expectedChatKey: string): void {
    void enqueueGenerationOperation(
        expectedChatKey,
        () => chatuiAdapter.menuActions.continueMessage(),
    ).catch((error: unknown) => reportChatBoundFailure('continue generation', error));
}

/**
 * Impersonate: have the model write the user's next message.
 * @returns {void}
 */
export function impersonateChatui(expectedChatKey: string): void {
    void enqueueGenerationOperation(
        expectedChatKey,
        () => chatuiAdapter.menuActions.impersonateMessage(),
    ).catch((error: unknown) => reportChatBoundFailure('impersonate', error));
}

/**
 * Regenerate the last character message (solo or group, via ST's options path).
 * @returns {void}
 */
export function regenerateChatuiLast(expectedChatKey: string): void {
    void enqueueGenerationOperation(
        expectedChatKey,
        () => chatuiAdapter.menuActions.regenerateFromPlusMenu(),
    ).catch((error: unknown) => reportChatBoundFailure('regenerate', error));
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
export function triggerChatuiWandItem(id: string, expectedChatKey: string): void {
    void enqueueChatBoundOperation(expectedChatKey, () => {
        if (!chatuiAdapter.menuActions.triggerWandItem(id)) {
            throw new Error(`[ChatUI] Wand item no longer exists: ${id}`);
        }
    }).catch((error: unknown) => reportChatBoundFailure('wand action', error));
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
export function triggerChatuiQuickReply(id: string, expectedChatKey: string): void {
    void enqueueChatBoundOperation(expectedChatKey, () => {
        if (!chatuiAdapter.qrActions.triggerQuickReply(id)) {
            throw new Error(`[ChatUI] Quick reply no longer exists: ${id}`);
        }
    }).catch((error: unknown) => reportChatBoundFailure('quick reply', error));
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
