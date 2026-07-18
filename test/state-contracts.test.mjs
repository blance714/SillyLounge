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
import {
    beginTempChatDraft,
    cancelTempChatDraft,
    cancelTempChatDraftIfMatches,
    clearTempChat,
    clearTempChatIfMatches,
    commitTempChatDraft,
    deactivateTempChatIfMatches,
    getTempChat,
    getTempChats,
    getTempChatDraft,
    getTempChatSnapshot,
    initTempChatStore,
    isTempChatSnapshotCurrent,
    markTempChatActive,
    moveTempChatIfMatches,
    removeTempChat,
    retainTempChatRenameCandidateIfMatches,
    setTempChat,
} from '../dist/runtime/store/temp-chat-store.js';
import {
    finishTempChatDeparture,
    prepareTempChatDeparture,
    shouldAdoptTempChatOnGenerationStart,
} from '../dist/runtime/store/temp-chat-navigation.js';
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

test('temp-chat pointer and optimistic draft reject stale ABA cleanup', () => {
    setTempChat(null);
    cancelTempChatDraft();

    setTempChat({ avatar: 'alice.png', fileName: 'same-name' });
    const stalePointer = getTempChatSnapshot();
    clearTempChat();
    setTempChat({ avatar: 'alice.png', fileName: 'same-name' });

    assert.equal(clearTempChatIfMatches(stalePointer), false);
    assert.deepEqual(getTempChat(), { avatar: 'alice.png', fileName: 'same-name' });

    const renamePointer = getTempChatSnapshot();
    assert.equal(moveTempChatIfMatches(renamePointer, { avatar: 'alice.png', fileName: 'renamed' }), true);
    assert.deepEqual(getTempChat(), { avatar: 'alice.png', fileName: 'renamed' });
    assert.equal(moveTempChatIfMatches(renamePointer, { avatar: 'alice.png', fileName: 'stale' }), false);

    const staleDraft = beginTempChatDraft({ avatar: 'alice.png', knownFileNames: ['old'] });
    const latestDraft = beginTempChatDraft({ avatar: 'bob.png', knownFileNames: ['new'] });

    assert.equal(cancelTempChatDraftIfMatches(staleDraft), false);
    assert.equal(getTempChatDraft()?.avatar, 'bob.png');
    assert.equal(cancelTempChatDraftIfMatches(latestDraft), true);
    assert.equal(getTempChatDraft(), null);

    setTempChat(null);
});

test('stale temp-chat completion records its file without erasing a newer draft intent', () => {
    setTempChat(null);
    cancelTempChatDraft();
    const first = beginTempChatDraft({ avatar: 'alice.png' });
    const latest = beginTempChatDraft({ avatar: 'bob.png' });

    assert.equal(commitTempChatDraft({ avatar: 'alice.png', fileName: 'alice-new' }, first), true);
    assert.deepEqual(getTempChat(), { avatar: 'alice.png', fileName: 'alice-new' });
    assert.equal(getTempChatDraft()?.avatar, 'bob.png');

    assert.equal(commitTempChatDraft({ avatar: 'bob.png', fileName: 'bob-new' }, latest), true);
    assert.deepEqual(getTempChat(), { avatar: 'bob.png', fileName: 'bob-new' });
    assert.deepEqual(getTempChats(), [
        { avatar: 'alice.png', fileName: 'alice-new' },
        { avatar: 'bob.png', fileName: 'bob-new' },
    ]);
    assert.equal(getTempChatDraft(), null);
    setTempChat(null);
});

test('leaving a temp chat deactivates it without publishing or blocking the next draft', () => {
    setTempChat(null);
    const firstIntent = beginTempChatDraft({ avatar: 'alice.png' });
    commitTempChatDraft({ avatar: 'alice.png', fileName: 'alice-draft' }, firstIntent);
    const snapshot = getTempChatSnapshot();
    assert.equal(deactivateTempChatIfMatches(snapshot), true);
    assert.equal(getTempChat(), null);
    assert.deepEqual(getTempChats(), [{ avatar: 'alice.png', fileName: 'alice-draft' }]);

    const secondIntent = beginTempChatDraft({ avatar: 'bob.png' });
    commitTempChatDraft({ avatar: 'bob.png', fileName: 'bob-draft' }, secondIntent);
    assert.deepEqual(getTempChat(), { avatar: 'bob.png', fileName: 'bob-draft' });
    assert.deepEqual(getTempChats(), [
        { avatar: 'alice.png', fileName: 'alice-draft' },
        { avatar: 'bob.png', fileName: 'bob-draft' },
    ]);
    setTempChat(null);
});

test('adopting the active temp preserves other quarantined drafts', () => {
    setTempChat(null);
    const first = beginTempChatDraft({ avatar: 'alice.png' });
    commitTempChatDraft({ avatar: 'alice.png', fileName: 'older' }, first);
    deactivateTempChatIfMatches(getTempChatSnapshot());
    const second = beginTempChatDraft({ avatar: 'alice.png' });
    commitTempChatDraft({ avatar: 'alice.png', fileName: 'active' }, second);

    clearTempChat();
    assert.equal(getTempChat(), null);
    assert.deepEqual(getTempChats(), [{ avatar: 'alice.png', fileName: 'older' }]);
    setTempChat(null);
});

test('restoring and renaming a quarantined draft keeps it tracked', () => {
    setTempChat({ avatar: 'alice.png', fileName: 'before' });
    const active = getTempChatSnapshot();
    deactivateTempChatIfMatches(active);
    assert.equal(markTempChatActive('alice.png', 'before'), true);
    const restored = getTempChatSnapshot();
    assert.equal(moveTempChatIfMatches(restored, { avatar: 'alice.png', fileName: 'after' }), true);
    assert.deepEqual(getTempChats(), [{ avatar: 'alice.png', fileName: 'after' }]);
    assert.equal(removeTempChat('alice.png', 'after'), true);
    assert.deepEqual(getTempChats(), []);
});

test('an uncertain rename quarantines both possible file identities', () => {
    setTempChat({ avatar: 'alice.png', fileName: 'before' });
    const active = getTempChatSnapshot();

    assert.equal(retainTempChatRenameCandidateIfMatches(active, {
        avatar: 'alice.png',
        fileName: 'after',
    }), true);
    assert.deepEqual(getTempChats(), [
        { avatar: 'alice.png', fileName: 'before' },
        { avatar: 'alice.png', fileName: 'after' },
    ]);
    assert.deepEqual(getTempChat(), { avatar: 'alice.png', fileName: 'before' });

    assert.equal(markTempChatActive('alice.png', 'after'), true);
    assert.deepEqual(getTempChats(), [
        { avatar: 'alice.png', fileName: 'before' },
        { avatar: 'alice.png', fileName: 'after' },
    ]);
    assert.deepEqual(getTempChat(), { avatar: 'alice.png', fileName: 'after' });
    setTempChat(null);
});

test('one corrupt persisted lease cannot publish other quarantined drafts', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const records = new Map([
        [
            `chatui:tempChat:${encodeURIComponent(JSON.stringify(['alice.png', 'safe-draft']))}`,
            JSON.stringify({ avatar: 'alice.png', fileName: 'safe-draft' }),
        ],
        ['chatui:tempChat:corrupt', '{not-json'],
        [
            `chatui:tempChat:${encodeURIComponent(JSON.stringify(['wrong.png', 'wrong-draft']))}`,
            JSON.stringify({ avatar: 'alice.png', fileName: 'safe-draft' }),
        ],
        ['chatui:tempChat', '{also-not-json'],
    ]);
    const storage = {
        get length() { return records.size; },
        key(index) { return Array.from(records.keys())[index] ?? null; },
        getItem(key) { return records.get(key) ?? null; },
        setItem(key, value) { records.set(String(key), String(value)); },
        removeItem(key) { records.delete(String(key)); },
    };

    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: storage,
    });
    try {
        initTempChatStore();
        assert.deepEqual(getTempChats(), [{ avatar: 'alice.png', fileName: 'safe-draft' }]);
        setTempChat(null);
    } finally {
        if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
        else delete globalThis.localStorage;
    }
});

test('unrelated quarantine churn does not invalidate a serialized new-chat slot', () => {
    setTempChat({ avatar: 'other.png', fileName: 'other-draft' });
    deactivateTempChatIfMatches(getTempChatSnapshot());
    const emptySlot = getTempChatSnapshot();
    removeTempChat('other.png', 'other-draft');

    assert.equal(getTempChatSnapshot().version, emptySlot.version);
    assert.equal(isTempChatSnapshotCurrent(emptySlot), true);
    assert.deepEqual(getTempChats(), []);

    setTempChat({ avatar: 'other.png', fileName: 'other-draft' });
    assert.equal(isTempChatSnapshotCurrent(emptySlot), false);
    setTempChat(null);
});

test('stale departure cannot deactivate a newer active temp', () => {
    setTempChat({ avatar: 'alice.png', fileName: 'old-temp' });
    const stale = getTempChatSnapshot();
    const latest = beginTempChatDraft({ avatar: 'bob.png' });
    commitTempChatDraft({ avatar: 'bob.png', fileName: 'new-temp' }, latest);

    assert.equal(deactivateTempChatIfMatches(stale), false);
    assert.deepEqual(getTempChat(), { avatar: 'bob.png', fileName: 'new-temp' });
    assert.deepEqual(getTempChats(), [
        { avatar: 'alice.png', fileName: 'old-temp' },
        { avatar: 'bob.png', fileName: 'new-temp' },
    ]);
    setTempChat(null);
});

test('queued navigation captures a concrete temp created after the user clicked away', async () => {
    setTempChat(null);
    cancelTempChatDraft();
    let releaseCreation;
    const creationGate = new Promise(resolve => { releaseCreation = resolve; });
    let markCreationStarted;
    const creationStarted = new Promise(resolve => { markCreationStarted = resolve; });
    const order = [];

    const creation = enqueueLatestNavigation(async () => {
        order.push('create-start');
        markCreationStarted();
        await creationGate;
        const intent = beginTempChatDraft({ avatar: 'alice.png' });
        commitTempChatDraft({ avatar: 'alice.png', fileName: 'new-temp' }, intent);
        order.push('create-commit');
    });
    await creationStarted;

    const navigation = enqueueLatestNavigation(async () => {
        const departing = prepareTempChatDeparture(
            { avatar: 'alice.png', fileName: 'new-temp' },
            () => false,
        );
        order.push(`capture:${departing.pointer?.fileName}`);
        order.push('open-old');
        finishTempChatDeparture(
            departing,
            { avatar: 'alice.png', fileName: 'old-chat' },
        );
    });

    releaseCreation();
    await Promise.all([creation, navigation]);
    assert.deepEqual(order, ['create-start', 'create-commit', 'capture:new-temp', 'open-old']);
    assert.equal(getTempChat(), null);
    assert.deepEqual(getTempChats(), [{ avatar: 'alice.png', fileName: 'new-temp' }]);
    setTempChat(null);
});

test('local work adopts a temp before navigation can reset pending UI state', () => {
    setTempChat({ avatar: 'alice.png', fileName: 'draft-with-attachment' });
    const departing = prepareTempChatDeparture(
        { avatar: 'alice.png', fileName: 'draft-with-attachment' },
        () => true,
    );

    assert.equal(departing.pointer, null);
    assert.deepEqual(getTempChats(), []);
    setTempChat(null);
});

test('a no-op navigation keeps the current temp active for later adoption', () => {
    setTempChat({ avatar: 'alice.png', fileName: 'same-temp' });
    const departing = prepareTempChatDeparture(
        { avatar: 'alice.png', fileName: 'same-temp' },
        () => false,
    );

    assert.equal(finishTempChatDeparture(
        departing,
        { avatar: 'alice.png', fileName: 'same-temp' },
    ), false);
    assert.deepEqual(getTempChat(), { avatar: 'alice.png', fileName: 'same-temp' });

    assert.equal(finishTempChatDeparture(
        departing,
        { avatar: 'alice.png', fileName: 'other-chat' },
    ), true);
    assert.equal(getTempChat(), null);
    setTempChat(null);
});

test('dry-run and quiet generation probes do not adopt an untouched temp chat', () => {
    assert.equal(shouldAdoptTempChatOnGenerationStart('normal', true), false);
    assert.equal(shouldAdoptTempChatOnGenerationStart('quiet', false), false);
    assert.equal(shouldAdoptTempChatOnGenerationStart('normal', false), true);
    assert.equal(shouldAdoptTempChatOnGenerationStart('regenerate', undefined), true);
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
