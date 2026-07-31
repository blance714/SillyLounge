import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeStHost } from './helpers/fake-st-host.mjs';

// dist/runtime/store/chat-actions.js serializes every UI-facing chat intent
// through the shared host-operation queue against SillyTavern's single mutable
// active-chat context. These tests drive it through a fake ST host and assert
// on the public surface only: the promises chat-actions.js hands back, the
// arguments its host calls receive, and the toast store UI components read.
//
// Setting up a chat "identity" for these tests always goes through the real
// chatuiAdapter.getCurrentChatKey() (via host.importModule('adapter/st-adapter.js'))
// rather than hand-encoding the chat-key.ts JSON format, so a key-format change
// can't silently desync the test from the code under test.

/** Configure host.context + getCurrentChatDetails so getCurrentChatKey() resolves to a stable value for "sessionName". */
function setActiveChat(host, sessionName) {
    host.registry.getCurrentChatDetails = () => ({ sessionName });
    host.context.characterId = 0;
    host.context.characters = [{ avatar: 'bob.png' }];
    host.context.groupId = undefined;
}

/** Same as setActiveChat, but for a group chat (getIsGroupChat() reads true). */
function setActiveGroupChat(host, sessionName, groupId) {
    host.registry.getCurrentChatDetails = () => ({ sessionName });
    host.context.characterId = undefined;
    host.context.characters = [];
    host.context.groupId = groupId;
}

function fillerMessage() {
    return { mes: 'filler', swipes: ['filler'], is_user: false, is_system: false, extra: {} };
}

/** Builds a chat array of `chatLength` filler messages with a target message at `targetId` (mirrors test/messages.test.mjs's helper). */
function buildChat(targetId, chatLength, targetOverrides) {
    const chat = Array.from({ length: chatLength }, fillerMessage);
    chat[targetId] = { mes: 'target', swipes: ['s0'], is_user: false, is_system: false, extra: {}, ...targetOverrides };
    return chat;
}

/**
 * Registers no-op stubs for every host call the delete fork's execution
 * (either sub-case) can reach, so a test only has to override the ones it
 * actually cares about observing. Mirrors test/messages.test.mjs's own
 * delete-execution setup, one layer up.
 */
function installDeleteExecutionHost(host) {
    host.registry.deleteItemizedPromptForMessage = () => undefined;
    host.registry.updateEditArrowClasses = () => undefined;
    host.registry.saveChatDebounced = () => undefined;
    host.registry.setEditedMessageId = () => undefined;
    host.registry.refreshSwipeButtons = () => undefined;
    host.registry.syncSwipeToMes = () => undefined;
    host.registry.saveChatConditional = () => undefined;
}

/** Register #send_textarea so composer.ts's getNativeComposerTextarea() finds it via plain #id lookup. */
function installComposerTextarea() {
    const textarea = document.createElement('textarea');
    textarea.id = 'send_textarea';
    return textarea;
}

/**
 * Configure the registry so chatuiAdapter.composerActions.sendComposerMessage(text)
 * can run its full non-command / non-empty-text path without touching any DOM
 * beyond #send_textarea: not-generating, a no-op bias classification, and a
 * sendTextareaMessage() stub that mimics ST's real observable side effect
 * (append a user message, then emit USER_MESSAGE_RENDERED for it) so the
 * adapter's acceptance gate resolves the same way it would against real ST.
 */
function installComposerSendHost(host, { onSend } = {}) {
    host.registry.isGenerating = () => false;
    host.registry.extractMessageBias = () => '';
    host.registry.removeMacros = (text) => text;
    const calls = [];
    host.registry.sendTextareaMessage = () => {
        const sentText = document.getElementById('send_textarea')?.value;
        calls.push(sentText);
        onSend?.(sentText);
        const newIndex = host.context.chat.length;
        host.context.chat.push({ mes: sentText, is_user: true, extra: {} });
        // Synchronous on purpose: the adapter's acceptance-gate listener is
        // already registered by the time sendTextareaMessage() runs (see
        // src/adapter/composer.ts sendComposerMessage), and real ST fires
        // USER_MESSAGE_RENDERED well before generation completion — emitting
        // it inline here reproduces that ordering instead of an artificial one.
        void host.eventSource.emit(host.event_types.USER_MESSAGE_RENDERED, newIndex);
    };
    return calls;
}

test('a composer send queued for a chat that changed before it runs is rejected and never reaches the host', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');

        setActiveChat(host, 'chat-a.jsonl');
        host.context.chat = [];
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        let sendCalls = 0;
        host.registry.sendTextareaMessage = () => { sendCalls += 1; };
        let onAcceptedCalls = 0;

        const pending = actions.sendChatuiComposerMessage('hello', chatKeyA, () => { onAcceptedCalls += 1; });
        // Flip the active chat before the queued task gets a turn to run. This
        // happens synchronously, in the same turn as the call above and before
        // any microtask (including the queue's own first tick) can run, so it
        // is guaranteed to land before enqueueHostTask's callback executes.
        setActiveChat(host, 'chat-b.jsonl');

        await assert.rejects(pending, (error) => {
            assert.equal(error.name, 'StaleChatOperationError');
            return true;
        });
        assert.equal(sendCalls, 0, 'a stale operation must never invoke the host-side send');
        assert.equal(onAcceptedCalls, 0, 'onAccepted must not fire for a rejected send');
    } finally {
        await host.dispose();
    }
});

test('a composer send queued for the still-current chat reaches the host exactly once with the sent text', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');

        setActiveChat(host, 'chat-a.jsonl');
        host.context.chat = [];
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        installComposerTextarea();
        const calls = installComposerSendHost(host);
        let onAcceptedCalls = 0;

        await actions.sendChatuiComposerMessage('hello world', chatKeyA, () => { onAcceptedCalls += 1; });

        assert.deepEqual(calls, ['hello world'], 'the host send must see exactly the text the caller queued');
        assert.equal(onAcceptedCalls, 1);
    } finally {
        await host.dispose();
    }
});

test('generation holds the serialized host lane until it stops, then releases the next queued task', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');

        setActiveChat(host, 'chat-a.jsonl');
        host.context.chat = [];
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        host.registry.isGenerating = () => false;
        installComposerTextarea();

        let regenerateTriggerCount = 0;
        let resolveTriggerFired;
        const triggerFired = new Promise((resolve) => { resolveTriggerFired = resolve; });
        // regenerateFromPlusMenu() takes the jQuery branch of triggerOptionsAction
        // when window.$ is a function, so this stands in for ST's real delegated
        // #option_regenerate click handler without needing DOM class selectors.
        host.window.$ = () => ({
            length: 1,
            trigger: () => {
                regenerateTriggerCount += 1;
                resolveTriggerFired();
            },
        });

        // Task 1: a regenerate-style generation operation. Fire-and-forget, like
        // every real UI call site (chat-actions.ts never returns this promise).
        actions.regenerateChatuiLast(chatKeyA);
        await triggerFired;

        // Solo chat -> ST's own Generate() reports type 'regenerate' for this
        // action (see chat-actions.ts's expectedGenerationTypes()).
        await host.eventSource.emit(host.event_types.GENERATION_STARTED, 'regenerate', {}, false);

        // Task 2: an unrelated host-bound operation queued while generation is
        // still active. It shares the same host-operation queue as task 1.
        const calls = installComposerSendHost(host);
        let onAcceptedCalls = 0;
        const secondTask = actions.sendChatuiComposerMessage('second message', chatKeyA, () => { onAcceptedCalls += 1; });

        assert.equal(calls.length, 0, 'the second task must not run while generation is still active');

        await host.eventSource.emit(host.event_types.GENERATION_STOPPED);

        await secondTask;
        assert.equal(regenerateTriggerCount, 1);
        assert.equal(calls.length, 1, 'the second task must run once the generation lane is released');
        assert.deepEqual(calls, ['second message']);
        assert.equal(onAcceptedCalls, 1);
    } finally {
        await host.dispose();
    }
});

test('a queued operation that throws does not poison the lane for the next queued operation', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');

        setActiveChat(host, 'chat-a.jsonl');
        host.context.chat = [];
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        installComposerTextarea();
        const calls = installComposerSendHost(host);
        let onAcceptedCalls = 0;

        // Task 1: saveEditedChatuiMessage for a message id with no corresponding
        // chat[] entry at all (host.context.chat is empty above) — the
        // DOM-free Tier 3 edit fork (src/adapter/messages.ts's
        // saveMessageEditById) throws "Message record not found for edit: 0"
        // — a genuine failure from the real adapter code, not a contrived one.
        const failingTask = actions.saveEditedChatuiMessage(0, 'edited text', chatKeyA);

        // Task 2: queued right behind it, on the very same host-operation lane.
        const okTask = actions.sendChatuiComposerMessage('still works', chatKeyA, () => { onAcceptedCalls += 1; });

        await assert.rejects(failingTask, /Message record not found for edit: 0/);
        await okTask;

        assert.deepEqual(calls, ['still works'], 'a later queued operation must still run after an earlier one throws');
        assert.equal(onAcceptedCalls, 1);
    } finally {
        await host.dispose();
    }
});

test('a stale generation operation surfaces an error toast the UI can observe', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');
        const toastStore = await host.importModule('store/toast-store.js');

        setActiveChat(host, 'chat-a.jsonl');
        host.context.chat = [];
        const chatKeyA = chatuiAdapter.getCurrentChatKey();
        // Flip the active chat before even queuing the operation, so the guard
        // rejects the very first time the queued task gets a turn to run.
        setActiveChat(host, 'chat-b.jsonl');

        assert.deepEqual(toastStore.getToasts(), []);

        const toastSeen = new Promise((resolve) => {
            const unsubscribe = toastStore.subscribeToasts((toasts) => {
                if (toasts.length > 0) {
                    unsubscribe();
                    resolve(toasts);
                }
            });
        });

        actions.regenerateChatuiLast(chatKeyA);

        const toasts = await toastSeen;
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].kind, 'error');
        assert.equal(toasts[0].text, '对话已切换，操作已取消');

        // Avoid leaving a real 4s auto-dismiss setTimeout running past this test.
        toastStore.dismissToast(toasts[0].id);
    } finally {
        await host.dispose();
    }
});

test('a quiet-typed or dry-run GENERATION_STARTED during the wait neither satisfies the start nor releases the lane', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');

        setActiveChat(host, 'chat-a.jsonl');
        host.context.chat = [];
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        // Real ST: Generate() sets is_send_press (=> isGenerating()) true for
        // every non-dry-run call, including quiet background probes.
        let generating = false;
        host.registry.isGenerating = () => generating;
        installComposerTextarea();

        let regenerateTriggerCount = 0;
        let resolveTriggerFired;
        const triggerFired = new Promise((resolve) => { resolveTriggerFired = resolve; });
        host.window.$ = () => ({
            length: 1,
            trigger: () => {
                regenerateTriggerCount += 1;
                resolveTriggerFired();
            },
        });

        actions.regenerateChatuiLast(chatKeyA);
        await triggerFired;

        const calls = installComposerSendHost(host);
        let onAcceptedCalls = 0;
        const secondTask = actions.sendChatuiComposerMessage('second message', chatKeyA, () => { onAcceptedCalls += 1; });

        // A background quiet probe (e.g. an auto-summarize extension) reports
        // type 'quiet' and must never be mistaken for the regenerate triggered
        // above — its own start/end pair must not release the lane.
        generating = true;
        await host.eventSource.emit(host.event_types.GENERATION_STARTED, 'quiet', {}, false);
        await host.eventSource.emit(host.event_types.GENERATION_ENDED, 0);
        generating = false;
        assert.equal(calls.length, 0, 'a quiet-typed GENERATION_STARTED/ENDED pair must not satisfy the wait');

        // A dry-run probe of the *right* type (prompt previews / token-count
        // probes reuse the real generation type but pass dryRun=true) must also
        // be ignored.
        await host.eventSource.emit(host.event_types.GENERATION_STARTED, 'regenerate', {}, true);
        assert.equal(calls.length, 0, 'a dryRun===true GENERATION_STARTED must not satisfy the wait');

        // The real regenerate actually starting and finishing still works.
        generating = true;
        await host.eventSource.emit(host.event_types.GENERATION_STARTED, 'regenerate', {}, false);
        generating = false;
        await host.eventSource.emit(host.event_types.GENERATION_STOPPED);

        await secondTask;
        assert.equal(regenerateTriggerCount, 1);
        assert.deepEqual(calls, ['second message']);
        assert.equal(onAcceptedCalls, 1);
    } finally {
        await host.dispose();
    }
});

test('a GENERATION_ENDED that fires while isGenerating() still reports true does not release the lane', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');

        setActiveChat(host, 'chat-a.jsonl');
        host.context.chat = [];
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        let generating = false;
        host.registry.isGenerating = () => generating;
        installComposerTextarea();

        let resolveTriggerFired;
        const triggerFired = new Promise((resolve) => { resolveTriggerFired = resolve; });
        host.window.$ = () => ({
            length: 1,
            trigger: () => resolveTriggerFired(),
        });

        actions.regenerateChatuiLast(chatKeyA);
        await triggerFired;

        generating = true;
        await host.eventSource.emit(host.event_types.GENERATION_STARTED, 'regenerate', {}, false);

        const calls = installComposerSendHost(host);
        let onAcceptedCalls = 0;
        const secondTask = actions.sendChatuiComposerMessage('second message', chatKeyA, () => { onAcceptedCalls += 1; });

        // A background quiet generation can legitimately end mid-stream (firing
        // its own GENERATION_ENDED) while the triggered regenerate is still
        // actually running — isGenerating() is the ground truth, not the event.
        await host.eventSource.emit(host.event_types.GENERATION_ENDED, 0);
        assert.equal(calls.length, 0, 'GENERATION_ENDED while isGenerating() still reports true must not release the lane');

        generating = false;
        await host.eventSource.emit(host.event_types.GENERATION_ENDED, 0);

        await secondTask;
        assert.deepEqual(calls, ['second message']);
        assert.equal(onAcceptedCalls, 1);
    } finally {
        await host.dispose();
    }
});

test('a group regenerate reports type "normal" and only releases the lane once GROUP_WRAPPER_FINISHED fires, even though isGenerating() reads true through every member turn', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');

        setActiveGroupChat(host, 'group-a.jsonl', 'group-1');
        host.context.chat = [];
        const chatKeyA = chatuiAdapter.getCurrentChatKey();
        assert.equal(chatuiAdapter.getIsGroupChat(), true);

        let generating = false;
        host.registry.isGenerating = () => generating;
        installComposerTextarea();

        let regenerateTriggerCount = 0;
        let resolveTriggerFired;
        const triggerFired = new Promise((resolve) => { resolveTriggerFired = resolve; });
        host.window.$ = () => ({
            length: 1,
            trigger: () => {
                regenerateTriggerCount += 1;
                resolveTriggerFired();
            },
        });

        actions.regenerateChatuiLast(chatKeyA);
        await triggerFired;

        // regenerateGroup() -> generateGroupWrapper(false, 'normal', ...) means
        // ST's own Generate() reports type 'normal' for a group regenerate,
        // never 'regenerate' (group-chats.js ~1008-1061).
        generating = true;
        await host.eventSource.emit(host.event_types.GENERATION_STARTED, 'normal', {}, false);

        const calls = installComposerSendHost(host);
        const secondTask = actions.sendChatuiComposerMessage('second message', chatKeyA, () => {});

        // Each activated member's own GENERATION_ENDED fires while
        // is_group_generating (=> isGenerating()) is still true — must not release.
        await host.eventSource.emit(host.event_types.GENERATION_ENDED, 0);
        assert.equal(calls.length, 0, 'a member turn ending mid-group-generation must not release the lane');

        // generateGroupWrapper()'s `finally` clears is_group_generating *before*
        // emitting GROUP_WRAPPER_FINISHED — that event is the real completion
        // signal for a group regenerate.
        generating = false;
        await host.eventSource.emit(host.event_types.GROUP_WRAPPER_FINISHED, { selected_group: 'group-1', type: 'normal' });

        await secondTask;
        assert.equal(regenerateTriggerCount, 1);
        assert.deepEqual(calls, ['second message']);
    } finally {
        await host.dispose();
    }
});

test('a started-timeout rejects the stuck operation with a distinct toast, keeps serving the queue, and removes its listeners', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');
        const toastStore = await host.importModule('store/toast-store.js');

        setActiveChat(host, 'chat-a.jsonl');
        host.context.chat = [];
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        host.registry.isGenerating = () => false;
        installComposerTextarea();
        actions.__setGenerationStartTimeoutMsForTesting(20);

        let regenerateTriggerCount = 0;
        // The synthetic click actually fires (a real fire-and-forget dispatch),
        // but ST never acknowledges it with GENERATION_STARTED — the exact
        // "silently ignored click" scenario menu.ts's fire-and-forget trigger
        // can hit in the real host.
        host.window.$ = () => ({
            length: 1,
            trigger: () => { regenerateTriggerCount += 1; },
        });

        const startedListenersBefore = host.eventSource.listenerCount(host.event_types.GENERATION_STARTED);
        const stoppedListenersBefore = host.eventSource.listenerCount(host.event_types.GENERATION_STOPPED);
        const endedListenersBefore = host.eventSource.listenerCount(host.event_types.GENERATION_ENDED);

        const toastSeen = new Promise((resolve) => {
            const unsubscribe = toastStore.subscribeToasts((toasts) => {
                if (toasts.length > 0) {
                    unsubscribe();
                    resolve(toasts);
                }
            });
        });

        actions.regenerateChatuiLast(chatKeyA);

        const toasts = await toastSeen;
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].kind, 'error');
        assert.equal(toasts[0].text, '生成未能开始，请重试');
        toastStore.dismissToast(toasts[0].id);

        assert.equal(regenerateTriggerCount, 1, 'the synthetic click must still have fired');
        assert.equal(
            host.eventSource.listenerCount(host.event_types.GENERATION_STARTED),
            startedListenersBefore,
            'the timed-out task must remove its GENERATION_STARTED listener',
        );
        assert.equal(host.eventSource.listenerCount(host.event_types.GENERATION_STOPPED), stoppedListenersBefore);
        assert.equal(host.eventSource.listenerCount(host.event_types.GENERATION_ENDED), endedListenersBefore);

        // The lane must still serve the next queued task after the timeout.
        const calls = installComposerSendHost(host);
        let onAcceptedCalls = 0;
        await actions.sendChatuiComposerMessage('after timeout', chatKeyA, () => { onAcceptedCalls += 1; });
        assert.deepEqual(calls, ['after timeout']);
        assert.equal(onAcceptedCalls, 1);

        actions.__setGenerationStartTimeoutMsForTesting(null);
    } finally {
        await host.dispose();
    }
});

// ---------------------------------------------------------------------------
// DOM-DECOUPLING.md Tier 2: message-delete orchestration
//
// triggerChatuiMessageAction(id, 'delete', chatKey) is the one action this
// module dispatches specially (see deleteChatuiMessage in
// src/store/chat-actions.ts): it reads confirm_message_delete +
// getDeleteEligibility() from the adapter, awaits a ChatUI-owned confirm
// dialog through store/confirm-store.js when required, and only then enqueues
// the actual mutation. These tests drive that whole path through a fake host,
// standing in for the (not-yet-built) dialog component by calling
// confirm-store's resolveChatuiConfirm() directly with each of the three
// possible outcomes.
// ---------------------------------------------------------------------------

test('triggerChatuiMessageAction("delete"): confirm_message_delete === false skips the confirm dialog entirely and runs a full-message delete immediately', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');
        const confirmStore = await host.importModule('store/confirm-store.js');
        const hostQueue = await host.importModule('store/host-operation-queue.js');

        setActiveChat(host, 'chat-a.jsonl');
        const TARGET_ID = 2;
        // is_user: true would force the full-message branch anyway even with
        // confirm on — proving this test's "no dialog at all" behavior really
        // comes from confirm_message_delete, not incidentally from ineligibility.
        host.context.chat = buildChat(TARGET_ID, 5, { is_user: true });
        host.context.powerUserSettings = { confirm_message_delete: false };
        host.context.chatMetadata = {};
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        installDeleteExecutionHost(host);

        let requestSeen = false;
        confirmStore.subscribeChatuiConfirm((request) => { if (request) requestSeen = true; });

        actions.triggerChatuiMessageAction(TARGET_ID, 'delete', chatKeyA);
        await hostQueue.waitForHostOperationsIdle();

        assert.equal(requestSeen, false, 'no confirm dialog request may be created when the setting is off');
        assert.equal(host.context.chat.length, 4, 'the message must actually be deleted');
    } finally {
        await host.dispose();
    }
});

test('triggerChatuiMessageAction("delete"): swipe-eligible + confirm on requests a three-way dialog with the design\'s own wording; choosing "confirm" runs the swipe-only mini-fork with the message\'s selected swipe id', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');
        const confirmStore = await host.importModule('store/confirm-store.js');
        const hostQueue = await host.importModule('store/host-operation-queue.js');

        setActiveChat(host, 'chat-a.jsonl');
        const TARGET_ID = 1;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['a', 'b'], swipe_id: 1, is_user: false });
        host.context.powerUserSettings = { confirm_message_delete: true };
        host.context.chatMetadata = {};
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        installDeleteExecutionHost(host);
        host.registry.saveChatDebounced = () => {
            throw new Error('the full-message fork must not run when the user confirms the default (swipe) choice');
        };

        actions.triggerChatuiMessageAction(TARGET_ID, 'delete', chatKeyA);
        await Promise.resolve();

        const request = confirmStore.getChatuiConfirmRequest();
        assert.ok(request, 'a confirm request must be created');
        assert.equal(request.variant, 'three-way');
        assert.equal(request.title, '删除这一楼？');
        assert.equal(request.confirmLabel, '仅删除此条');
        assert.equal(request.escalateLabel, '删除整楼');
        assert.equal(request.cancelLabel, '取消');
        assert.equal(request.danger, true);

        confirmStore.resolveChatuiConfirm(request.id, 'confirm');
        // Resolving the confirm-store promise only *schedules* deleteChatuiMessage's
        // continuation (the enqueue) as a microtask -- waitForHostOperationsIdle()
        // reads the current queue tail synchronously, so it must be called after
        // that continuation has actually run and appended the task, not before.
        await Promise.resolve();
        await hostQueue.waitForHostOperationsIdle();

        assert.deepEqual(host.context.chat[TARGET_ID].swipes, ['a'], 'the message\'s selected swipe (index 1) must be the one deleted');
        assert.equal(host.context.chat.length, TARGET_ID + 1, 'the message itself must survive a swipe-only delete');
    } finally {
        await host.dispose();
    }
});

test('triggerChatuiMessageAction("delete"): swipe-eligible + confirm on — choosing "escalate" in the three-way dialog runs the full-message fork instead, with no second dialog', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');
        const confirmStore = await host.importModule('store/confirm-store.js');
        const hostQueue = await host.importModule('store/host-operation-queue.js');

        setActiveChat(host, 'chat-a.jsonl');
        const TARGET_ID = 1;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['a', 'b'], swipe_id: 1, is_user: false });
        host.context.powerUserSettings = { confirm_message_delete: true };
        host.context.chatMetadata = {};
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        installDeleteExecutionHost(host);
        host.registry.saveChatConditional = () => {
            throw new Error('the swipe-only mini-fork must not run once the user escalates to a full delete');
        };

        actions.triggerChatuiMessageAction(TARGET_ID, 'delete', chatKeyA);
        await Promise.resolve();

        const request = confirmStore.getChatuiConfirmRequest();
        let dialogRequestsAfterEscalate = 0;
        confirmStore.subscribeChatuiConfirm((next) => { if (next) dialogRequestsAfterEscalate += 1; });

        confirmStore.resolveChatuiConfirm(request.id, 'escalate');
        await Promise.resolve(); // see the 'confirm' test above for why this flush is required
        await hostQueue.waitForHostOperationsIdle();

        assert.equal(host.context.chat.length, TARGET_ID, 'the whole message must be gone');
        assert.equal(dialogRequestsAfterEscalate, 0, 'escalating must not reopen a second dialog');
    } finally {
        await host.dispose();
    }
});

test('triggerChatuiMessageAction("delete"): choosing "cancel" (either dialog variant) leaves the chat untouched and never calls any delete-execution host function', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');
        const confirmStore = await host.importModule('store/confirm-store.js');

        setActiveChat(host, 'chat-a.jsonl');
        const TARGET_ID = 1;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['a', 'b'], swipe_id: 1, is_user: false });
        host.context.powerUserSettings = { confirm_message_delete: true };
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        for (const fn of [
            'deleteItemizedPromptForMessage', 'updateEditArrowClasses',
            'saveChatDebounced', 'setEditedMessageId', 'refreshSwipeButtons',
            'syncSwipeToMes', 'saveChatConditional',
        ]) {
            host.registry[fn] = () => { throw new Error(`${fn} must not be called when the user cancels`); };
        }

        actions.triggerChatuiMessageAction(TARGET_ID, 'delete', chatKeyA);
        await Promise.resolve();

        const request = confirmStore.getChatuiConfirmRequest();
        confirmStore.resolveChatuiConfirm(request.id, 'cancel');
        await Promise.resolve(); // let the cancel branch's early `return` run

        assert.equal(confirmStore.getChatuiConfirmRequest(), null, 'the request must be cleared once answered');
        assert.equal(host.context.chat.length, TARGET_ID + 1);
        assert.deepEqual(host.context.chat[TARGET_ID].swipes, ['a', 'b']);
    } finally {
        await host.dispose();
    }
});

test('triggerChatuiMessageAction("delete"): not swipe-eligible + confirm on requests a plain two-way dialog; confirming deletes the whole message', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');
        const confirmStore = await host.importModule('store/confirm-store.js');
        const hostQueue = await host.importModule('store/host-operation-queue.js');

        setActiveChat(host, 'chat-a.jsonl');
        const TARGET_ID = 1;
        // is_user: true is structurally ineligible for a swipe-only delete
        // regardless of swipe count/isLast.
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['a', 'b'], swipe_id: 1, is_user: true });
        host.context.powerUserSettings = { confirm_message_delete: true };
        host.context.chatMetadata = {};
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        installDeleteExecutionHost(host);

        actions.triggerChatuiMessageAction(TARGET_ID, 'delete', chatKeyA);
        await Promise.resolve();

        const request = confirmStore.getChatuiConfirmRequest();
        assert.ok(request);
        assert.equal(request.variant, 'two-way');
        assert.equal(request.confirmLabel, '删除');
        assert.equal(request.escalateLabel, undefined, 'a two-way dialog must carry no escalate button at all');
        assert.equal(request.cancelLabel, '取消');

        confirmStore.resolveChatuiConfirm(request.id, 'confirm');
        await Promise.resolve(); // see the three-way 'confirm' test above for why this flush is required
        await hostQueue.waitForHostOperationsIdle();

        assert.equal(host.context.chat.length, TARGET_ID, 'the whole message must be gone');
    } finally {
        await host.dispose();
    }
});

test('triggerChatuiMessageAction("delete"): a chat switch while the confirm dialog is still open aborts the eventual execution instead of mutating the now-different chat, and surfaces the same stale-operation toast as every other action', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');
        const { chatuiAdapter } = await host.importModule('adapter/st-adapter.js');
        const confirmStore = await host.importModule('store/confirm-store.js');
        const hostQueue = await host.importModule('store/host-operation-queue.js');
        const toastStore = await host.importModule('store/toast-store.js');

        setActiveChat(host, 'chat-a.jsonl');
        const TARGET_ID = 1;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['a'], is_user: true });
        host.context.powerUserSettings = { confirm_message_delete: true };
        const chatKeyA = chatuiAdapter.getCurrentChatKey();

        installDeleteExecutionHost(host);
        host.registry.saveChatDebounced = () => {
            throw new Error('a stale operation must never reach the delete-execution host calls');
        };

        actions.triggerChatuiMessageAction(TARGET_ID, 'delete', chatKeyA);
        await Promise.resolve();
        const request = confirmStore.getChatuiConfirmRequest();

        // The user is still looking at the dialog when the active chat changes
        // out from under them (e.g. a sidebar navigation).
        setActiveChat(host, 'chat-b.jsonl');

        const toastSeen = new Promise((resolve) => {
            const unsubscribe = toastStore.subscribeToasts((toasts) => {
                if (toasts.length > 0) { unsubscribe(); resolve(toasts); }
            });
        });

        confirmStore.resolveChatuiConfirm(request.id, 'confirm');
        await Promise.resolve(); // see the three-way 'confirm' test above for why this flush is required
        await hostQueue.waitForHostOperationsIdle();

        const toasts = await toastSeen;
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].kind, 'error');
        assert.equal(toasts[0].text, '对话已切换，操作已取消');
        toastStore.dismissToast(toasts[0].id);

        assert.equal(host.context.chat.length, TARGET_ID + 1, 'the stale chat must be left completely untouched');
    } finally {
        await host.dispose();
    }
});
