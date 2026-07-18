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
        // live DOM element. This harness intentionally has no full DOM (see
        // test/helpers/fake-st-host.mjs's module doc comment), so
        // getMessageElementById() always returns null here and the adapter
        // throws "Message element not found for edit: 0" — a genuine failure
        // from the real adapter code, not a contrived one.
        const failingTask = actions.saveEditedChatuiMessage(0, 'edited text', chatKeyA);

        // Task 2: queued right behind it, on the very same host-operation lane.
        const okTask = actions.sendChatuiComposerMessage('still works', chatKeyA, () => { onAcceptedCalls += 1; });

        await assert.rejects(failingTask, /Message element not found for edit: 0/);
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
