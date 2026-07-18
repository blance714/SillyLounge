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

/**
 * A fire-and-forget synthetic click into ST's own menu (adapter/menu.ts) has no
 * ST-side acknowledgment. If ST silently drops it, GENERATION_STARTED never
 * fires and the single global host-operation lane would otherwise wedge
 * forever. GENERATION_START_TIMEOUT_MS bounds that wait; see
 * enqueueGenerationOperation.
 */
export const GENERATION_START_TIMEOUT_MS = 10_000;

/** Test-only: shrink the started-timeout so tests don't wait out the real 10s. Pass null to restore the default. */
let _generationStartTimeoutMsOverride: number | null = null;
export function __setGenerationStartTimeoutMsForTesting(ms: number | null): void {
    _generationStartTimeoutMsOverride = ms;
}
function _generationStartTimeoutMs(): number {
    return _generationStartTimeoutMsOverride ?? GENERATION_START_TIMEOUT_MS;
}

class GenerationDidNotStartError extends Error {
    constructor() {
        super('[ChatUI] Generation did not start in time');
        this.name = 'GenerationDidNotStartError';
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

/** #option_regenerate / #option_continue / #option_impersonate — the three ST
 * menu actions enqueueGenerationOperation can wait on. */
type GenerationKind = 'regenerate' | 'continue' | 'impersonate';

const CONTINUE_GENERATION_TYPES: ReadonlySet<string> = new Set(['continue']);
const IMPERSONATE_GENERATION_TYPES: ReadonlySet<string> = new Set(['impersonate']);
const SOLO_REGENERATE_GENERATION_TYPES: ReadonlySet<string> = new Set(['regenerate']);
const GROUP_REGENERATE_GENERATION_TYPES: ReadonlySet<string> = new Set(['normal']);

/**
 * The ST generation `type` string(s) that count as *this* triggered action
 * having actually started, confirmed against the pinned SillyTavern checkout
 * (test/e2e/st-version.json, public/script.js):
 *  - #option_continue / #option_impersonate call Generate('continue'/
 *    'impersonate', ...) directly — solo or group (script.js ~11581-11599).
 *  - #option_regenerate calls Generate('regenerate', ...) directly in a solo
 *    chat, but in a group chat instead runs regenerateGroup(), which routes
 *    through generateGroupWrapper() — that only special-cases 'swipe' /
 *    'impersonate' / 'quiet' / 'continue' and falls through to
 *    Generate('normal', ...) for a plain regenerate (group-chats.js
 *    ~1008-1061). So the type ST actually reports for a group regenerate is
 *    'normal', never 'regenerate'.
 * A background/quiet probe (auto-summarize, WI activation checks, prompt
 * previews, ...) always reports type 'quiet' and must never match here.
 */
function expectedGenerationTypes(kind: GenerationKind): ReadonlySet<string> {
    switch (kind) {
        case 'continue': return CONTINUE_GENERATION_TYPES;
        case 'impersonate': return IMPERSONATE_GENERATION_TYPES;
        case 'regenerate':
            return chatuiAdapter.getIsGroupChat()
                ? GROUP_REGENERATE_GENERATION_TYPES
                : SOLO_REGENERATE_GENERATION_TYPES;
    }
}

function enqueueGenerationOperation(
    expectedChatKey: string,
    kind: GenerationKind,
    trigger: () => Promise<void> | void,
): Promise<void> {
    return enqueueHostTask(async () => {
        if (!expectedChatKey || chatuiAdapter.getCurrentChatKey() !== expectedChatKey) {
            throw new StaleChatOperationError();
        }
        if (chatuiAdapter.getGenerationState().isGenerating) {
            throw new Error('[ChatUI] Generation is already active');
        }

        const acceptedTypes = expectedGenerationTypes(kind);
        let started = false;
        let resolveStarted: () => void = () => undefined;
        let rejectStarted: (error: unknown) => void = () => undefined;
        let resolveFinished: () => void = () => undefined;
        const startedPromise = new Promise<void>((resolve, reject) => {
            resolveStarted = resolve;
            rejectStarted = reject;
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
        let startTimer: ReturnType<typeof setTimeout> | null = null;
        const clearStartTimer = () => {
            if (startTimer !== null) {
                clearTimeout(startTimer);
                startTimer = null;
            }
        };

        try {
            // ST emits GENERATION_STARTED for *every* Generate() call, including
            // 'quiet' background prompts (e.g. an auto-summarize extension firing
            // mid-stream) and dry runs (prompt previews / token-count probes).
            // Only the type(s) this action's own trigger produces, for a
            // non-dry-run, in the still-current chat, counts as "started".
            unsubscribers.push(chatuiAdapter.subscribe(stEventKeys.GENERATION_STARTED, (
                type: unknown,
                _params: unknown,
                isDryRun: unknown,
            ) => {
                if (started) return;
                if (isDryRun === true) return;
                if (!acceptedTypes.has(String(type))) return;
                if (chatuiAdapter.getCurrentChatKey() !== expectedChatKey) return;
                started = true;
                clearStartTimer();
                resolveStarted();
            }));
            // GENERATION_STOPPED carries no arguments and GENERATION_ENDED only a
            // message count — neither identifies which generation ended. A quiet
            // probe's own start/end pair must not be mistaken for this trigger's
            // completion, so require isGenerating() to have actually gone false
            // (cross-checked live through the adapter, not from event args).
            const finish = () => {
                if (!started) return;
                if (chatuiAdapter.getCurrentChatKey() !== expectedChatKey) return;
                if (chatuiAdapter.getGenerationState().isGenerating) return;
                resolveFinished();
            };
            unsubscribers.push(chatuiAdapter.subscribe(stEventKeys.GENERATION_STOPPED, finish));
            unsubscribers.push(chatuiAdapter.subscribe(stEventKeys.GENERATION_ENDED, finish));
            if (kind === 'regenerate') {
                // Group-only completion signal: generateGroupWrapper() keeps
                // isGenerating() true across every activated member's own
                // GENERATION_ENDED, only clearing it in its `finally` — right
                // before emitting this event. In a solo chat it never fires, so
                // subscribing unconditionally is harmless.
                unsubscribers.push(chatuiAdapter.subscribe(stEventKeys.GROUP_WRAPPER_FINISHED, finish));
            }

            startTimer = setTimeout(() => {
                startTimer = null;
                rejectStarted(new GenerationDidNotStartError());
            }, _generationStartTimeoutMs());

            await trigger();
            await startedPromise;
            await finishedPromise;
        } finally {
            clearStartTimer();
            cleanup();
        }
    }, { rejectOnCancelled: true }).then(() => undefined);
}

function reportChatBoundFailure(label: string, error: unknown): void {
    if (error instanceof HostOperationCancelledError) return;
    console.error(`[ChatUI] ${label} failed`, error);
    let toastText = '操作失败';
    if (error instanceof StaleChatOperationError) toastText = '对话已切换，操作已取消';
    else if (error instanceof GenerationDidNotStartError) toastText = '生成未能开始，请重试';
    notifyChatui('error', toastText);
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
            'regenerate',
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
        'continue',
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
        'impersonate',
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
        'regenerate',
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
