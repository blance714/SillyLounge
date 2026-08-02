import assert from 'node:assert/strict';
import test from 'node:test';
import {
    projectMessageIndexSnapshot,
    projectMessageSnapshot,
} from '../dist/runtime/adapter/schema.js';
import {
    createCharacterChatKey,
    createConversationLocator,
    createGroupChatKey,
    createUnscopedChatKey,
} from '../dist/runtime/adapter/chat-key.js';
import {
    beginComposerSend,
    clearComposerDraftIfMatches,
    deleteComposerDraft,
    finishComposerSend,
    getComposerDraft,
    getComposerDraftStoreSnapshot,
    moveComposerDraft,
    moveComposerDraftCharacterScope,
    resetComposerDraftStore,
    setComposerDraft,
} from '../dist/runtime/store/composer-draft-store.js';
import {
    enqueueHostTask,
    enqueueLatestNavigation,
    HostOperationCancelledError,
    resetHostOperationQueueLifecycle,
    sealHostOperationQueueForReload,
    waitForHostOperationsIdle,
} from '../dist/runtime/store/host-operation-queue.js';
import { createBoundedWorkCoordinator } from '../dist/runtime/store/bounded-work-coordinator.js';

const flushTasks = () => new Promise(resolve => setImmediate(resolve));

test('message index projection ignores expensive content fields', () => {
    const raw = {
        is_user: true,
        is_system: false,
        extra: {
            isSmallSys: false,
            tool_invocations: [],
        },
    };
    for (const field of ['mes', 'swipes', 'name', 'send_date']) {
        Object.defineProperty(raw, field, {
            enumerable: true,
            get() {
                throw new Error(`message index read expensive field: ${field}`);
            },
        });
    }
    Object.defineProperty(raw.extra, 'reasoning', {
        enumerable: true,
        get() {
            throw new Error('message index read expensive field: reasoning');
        },
    });

    const snapshot = projectMessageIndexSnapshot(raw, 12);
    assert.deepEqual(snapshot, {
        id: 12,
        isSystem: false,
        isUser: true,
        isSmallSys: false,
        isToolCall: true,
    });
    assert.equal(Object.isFrozen(snapshot), true);
});

test('raw messages are normalized into an immutable adapter-boundary DTO', () => {
    const snapshot = projectMessageSnapshot({
        name: 'Alice',
        mes: 'raw text',
        is_user: true,
        swipe_id: 1,
        swipes: ['first', 'second'],
        extra: {
            display_text: 'display text',
            uses_system_ui: true,
            token_count: 42,
            reasoning_duration: '1.2s',
        },
    }, 7);

    assert.deepEqual(snapshot, {
        id: 7,
        name: 'Alice',
        text: 'raw text',
        isSystem: false,
        isUser: true,
        sendDate: null,
        forceAvatar: false,
        forceAvatarSrc: '',
        swipeId: 1,
        swipeCount: 2,
        displayText: 'display text',
        usesSystemUi: true,
        type: '',
        isSmallSys: false,
        isToolCall: false,
        bookmarkLink: '',
        tokenCount: 42,
        reasoning: '',
        reasoningDisplayText: '',
        reasoningDuration: '1.2s',
    });
    assert.equal(Object.isFrozen(snapshot), true);
});

test('composer drafts remain chat-scoped and stale sends cannot erase newer text', () => {
    resetComposerDraftStore();
    setComposerDraft('alice\u0000chat-a', 'first');
    setComposerDraft('bob\u0000chat-b', 'other chat');

    const send = beginComposerSend('alice\u0000chat-a', 'first');
    assert.ok(send);
    assert.equal(beginComposerSend('bob\u0000chat-b', 'other chat'), null);

    setComposerDraft('alice\u0000chat-a', 'newer edit');
    assert.equal(clearComposerDraftIfMatches(send), false);
    assert.equal(finishComposerSend(send), true);
    assert.equal(getComposerDraft('alice\u0000chat-a'), 'newer edit');
    assert.equal(getComposerDraft('bob\u0000chat-b'), 'other chat');
    assert.equal(moveComposerDraft('alice\u0000chat-a', 'alice\u0000renamed'), true);
    assert.equal(getComposerDraft('alice\u0000chat-a'), '');
    assert.equal(getComposerDraft('alice\u0000renamed'), 'newer edit');

    const avatarOldKey = createCharacterChatKey('alice.png', 'chat-c');
    const avatarNewKey = createCharacterChatKey('alice-renamed.png', 'chat-c');
    setComposerDraft(avatarOldKey, 'avatar rename');
    moveComposerDraftCharacterScope('alice.png', 'alice-renamed.png');
    assert.equal(getComposerDraft(avatarOldKey), '');
    assert.equal(getComposerDraft(avatarNewKey), 'avatar rename');

    resetComposerDraftStore();
    const commandOldKey = createCharacterChatKey('alice.png', 'command-old');
    const commandNewKey = createCharacterChatKey('alice.png', 'command-new');
    setComposerDraft(commandOldKey, '/renamechat command-new');
    const commandSend = beginComposerSend(commandOldKey, '/renamechat command-new');
    assert.ok(commandSend);
    moveComposerDraft(commandOldKey, commandNewKey);
    assert.equal(clearComposerDraftIfMatches(commandSend), true);
    assert.equal(getComposerDraft(commandNewKey), '');
    assert.equal(finishComposerSend(commandSend), true);

    setComposerDraft(commandNewKey, 'discard me');
    deleteComposerDraft(commandNewKey);
    assert.equal(getComposerDraft(commandNewKey), '');

    resetComposerDraftStore();
});

test('composer revision and lifecycle epochs prevent text ABA and premature gate reset', () => {
    resetComposerDraftStore();
    const key = createCharacterChatKey('alice.png', 'chat-a');
    setComposerDraft(key, 'same text');
    const send = beginComposerSend(key, 'same text');
    assert.ok(send);

    setComposerDraft(key, 'changed');
    setComposerDraft(key, 'same text');
    const renamedKey = createCharacterChatKey('alice.png', 'chat-renamed');
    moveComposerDraft(key, renamedKey);
    assert.equal(clearComposerDraftIfMatches(send), false);

    resetComposerDraftStore();
    assert.equal(getComposerDraftStoreSnapshot().pendingSend?.id, send.id);
    assert.equal(beginComposerSend(key, 'second send'), null);
    assert.equal(finishComposerSend(send), true);
    assert.equal(getComposerDraftStoreSnapshot().pendingSend, null);
    assert.deepEqual(getComposerDraftStoreSnapshot().drafts, {});
});

test('chat keys separate character/group domains and delimiter-like names', () => {
    assert.notEqual(
        createCharacterChatKey('7', 'same'),
        createGroupChatKey('7', 'same'),
    );
    assert.notEqual(
        createCharacterChatKey('a::b', 'c'),
        createCharacterChatKey('a', 'b::c'),
    );
    assert.notEqual(
        createUnscopedChatKey('same'),
        createCharacterChatKey('', 'same'),
    );
});

test('filename identity distinguishes metadata-copy branches and is stable for legacy reloads', () => {
    assert.notEqual(
        createConversationLocator('original'),
        createConversationLocator('original - Branch #1'),
    );
    assert.equal(createConversationLocator('legacy-chat'), createConversationLocator('legacy-chat'));
});

test('lifecycle reset rejects opted-in queued mutations without overlapping the active task', async () => {
    let release;
    let started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const blocker = enqueueHostTask(async () => {
        started();
        await gate;
    });
    await startedPromise;

    const stale = enqueueHostTask(async () => {
        assert.fail('stale task must not enter the host');
    }, { rejectOnCancelled: true });
    resetHostOperationQueueLifecycle();
    release();
    await blocker;
    await assert.rejects(stale, HostOperationCancelledError);
});

test('host operations serialize and queued navigation uses last-intent-wins', async () => {
    const events = [];
    let releaseBlocker;
    let announceStarted;
    const blockerStarted = new Promise(resolve => {
        announceStarted = resolve;
    });
    const blockerGate = new Promise(resolve => {
        releaseBlocker = resolve;
    });

    const blocker = enqueueHostTask(async () => {
        events.push('blocker:start');
        announceStarted();
        await blockerGate;
        events.push('blocker:end');
    });
    await blockerStarted;

    const first = enqueueLatestNavigation(
        async () => {
            events.push('navigation:first');
        },
        () => events.push('navigation:first:superseded'),
    );
    const latest = enqueueLatestNavigation(async operation => {
        assert.equal(operation.isLatest(), true);
        events.push('navigation:latest');
    });

    releaseBlocker();
    await Promise.all([blocker, first, latest]);
    await waitForHostOperationsIdle();

    assert.deepEqual(events, [
        'blocker:start',
        'blocker:end',
        'navigation:first:superseded',
        'navigation:latest',
    ]);
});

test('a failed host task does not poison the serialized lane', async () => {
    const events = [];
    await assert.rejects(
        enqueueHostTask(async () => {
            events.push('failed');
            throw new Error('expected');
        }),
        /expected/,
    );
    await enqueueHostTask(async () => {
        events.push('recovered');
    });
    assert.deepEqual(events, ['failed', 'recovered']);
});

test('a new lifecycle waits for the old active task while cancelling old queued work', async () => {
    const events = [];
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const activeStarted = new Promise(resolve => { started = resolve; });
    const active = enqueueHostTask(async () => {
        events.push('old:start');
        started();
        await gate;
        events.push('old:end');
    });
    await activeStarted;

    const stale = enqueueHostTask(async () => {
        assert.fail('old queued work must be cancelled');
    }, { rejectOnCancelled: true });
    resetHostOperationQueueLifecycle();
    const current = enqueueHostTask(async () => {
        events.push('new:start');
    });

    release();
    await active;
    await assert.rejects(stale, HostOperationCancelledError);
    await current;
    assert.deepEqual(events, ['old:start', 'old:end', 'new:start']);
});

test('bounded work coordinator caps concurrency and runs one dirty follow-up', async () => {
    const releases = new Map();
    const starts = [];
    let active = 0;
    let maxActive = 0;
    const coordinator = createBoundedWorkCoordinator(2);
    const work = key => ({
        key,
        run: async () => {
            starts.push(key);
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => releases.set(key, resolve));
            active -= 1;
        },
    });

    coordinator.enqueue(work('a'));
    coordinator.enqueue(work('b'));
    coordinator.enqueue(work('c'));
    await flushTasks();
    assert.deepEqual(starts, ['a', 'b']);
    assert.equal(maxActive, 2);

    releases.get('a')();
    await flushTasks();
    assert.deepEqual(starts, ['a', 'b', 'c']);
    releases.get('b')();
    releases.get('c')();
    await coordinator.waitForIdle();

    let dirtyRuns = 0;
    let releaseDirty;
    coordinator.enqueue({
        key: 'dirty',
        run: async () => {
            dirtyRuns += 1;
            if (dirtyRuns === 1) await new Promise(resolve => { releaseDirty = resolve; });
        },
    });
    await flushTasks();
    assert.equal(coordinator.enqueue({ key: 'dirty', run: async () => undefined }), false);
    assert.equal(coordinator.enqueue({ key: 'dirty', run: async () => undefined }), false);
    releaseDirty();
    await coordinator.waitForIdle();
    assert.equal(dirtyRuns, 2);
});

test('disposing bounded work drops queued and follow-up work', async () => {
    let release;
    let queuedRan = false;
    const coordinator = createBoundedWorkCoordinator(1);
    coordinator.enqueue({
        key: 'active',
        run: () => new Promise(resolve => { release = resolve; }),
    });
    coordinator.enqueue({
        key: 'queued',
        run: async () => { queuedRan = true; },
    });
    await flushTasks();
    coordinator.dispose();
    assert.equal(coordinator.enqueue({ key: 'late', run: async () => undefined }), false);
    release();
    await coordinator.waitForIdle();
    assert.equal(queuedRan, false);
});

// Keep this last: terminal reload is intentionally irreversible for the module
// instance, matching a page that is about to unload.
test('terminal reload seal rejects both queued and newly-enqueued mutations', async () => {
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const activeStarted = new Promise(resolve => { started = resolve; });
    const active = enqueueHostTask(async () => {
        started();
        await gate;
    });
    await activeStarted;

    const queued = enqueueHostTask(async () => {
        assert.fail('queued task must not enter after reload seal');
    }, { rejectOnCancelled: true });
    sealHostOperationQueueForReload();
    const late = enqueueHostTask(async () => {
        assert.fail('late task must not enter after reload seal');
    }, { rejectOnCancelled: true });

    release();
    await active;
    await assert.rejects(queued, HostOperationCancelledError);
    await assert.rejects(late, HostOperationCancelledError);
});
