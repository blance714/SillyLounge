import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeStHost } from './helpers/fake-st-host.mjs';

test('the three modules author agents rely on import cleanly from the scratch tree', async () => {
    const host = await createFakeStHost();
    try {
        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        const actions = await host.importModule('store/chat-actions.js');
        const store = await host.importModule('store/chat-store.js');

        assert.equal(typeof rename.renameCharacterChat, 'function');
        assert.equal(typeof actions.selectChatuiSelector, 'function');
        assert.equal(typeof store.initChatuiStore, 'function');
    } finally {
        await host.dispose();
    }
});

test('a stubbed host function receives the arguments the compiled code passed', async () => {
    const host = await createFakeStHost();
    try {
        const actions = await host.importModule('store/chat-actions.js');

        let received;
        host.registry.setUserAvatar = (...args) => {
            received = args;
        };

        // selectChatuiSelector('persona', ...) -> adapter/selectors.js
        // selectSelector() -> setUserAvatar(value), unconditionally on this
        // branch. Proves both that our stub function is reachable through
        // the real (compiled) call chain and that it sees the exact
        // argument the compiled code passed, not some harness-invented one.
        await actions.selectChatuiSelector('persona', 'avatar-42.png');

        assert.deepEqual(received, ['avatar-42.png']);
    } finally {
        await host.dispose();
    }
});

test('two hosts have independent module state — nothing leaks across scratch trees', async () => {
    const hostA = await createFakeStHost();
    const hostB = await createFakeStHost();
    try {
        assert.notEqual(hostA.dir, hostB.dir);

        const storeB = await hostB.importModule('store/chat-store.js');
        let firedOnB = false;
        hostB.eventSource.on(hostB.event_types.CHAT_CHANGED, () => {
            firedOnB = true;
        });

        // Each host copied its own dist/runtime into its own directory, so
        // adapter/internals.js (and therefore its `eventSource` binding) is
        // a *different* module instance per host. Emitting on A's bus must
        // not reach a listener registered through B's bus/module graph.
        await hostA.eventSource.emit(hostA.event_types.CHAT_CHANGED);
        assert.equal(firedOnB, false, 'hostA emit must not reach a hostB listener');

        await hostB.eventSource.emit(hostB.event_types.CHAT_CHANGED);
        assert.equal(firedOnB, true, 'hostB emit must reach its own listener');

        // getChatuiState is a pure read of chat-store.js's own module-scoped
        // singleton store; touching it on B must not have required (or
        // touched) anything about hostA's module graph.
        assert.equal(typeof storeB.getChatuiState(), 'object');
    } finally {
        await hostA.dispose();
        await hostB.dispose();
    }
});

// adapter/config.js write() used to assume getContext().extensionSettings
// was already an object and threw a bare TypeError the instant it wasn't —
// while read() (src/adapter/config.ts:23) already tolerates that same field
// being absent via `?.`. Source: src/adapter/config.ts:34-41.
test('config.write() initializes a missing extensionSettings namespace instead of throwing, mirroring read()\'s null-tolerance', async () => {
    const host = await createFakeStHost();
    try {
        const config = await host.importModule('adapter/config.js');

        // Nothing has created host.context.extensionSettings yet — read()
        // already handles this case; write() must too.
        host.context.extensionSettings = undefined;
        assert.deepEqual(config.read(), {}, 'read() with no extensionSettings at all returns {}');

        let saveCalls = 0;
        host.registry.saveSettingsDebounced = () => { saveCalls += 1; };

        assert.doesNotThrow(() => config.write({ theme: 'dark' }));

        assert.deepEqual(host.context.extensionSettings, { chatui_composer: { config: { theme: 'dark' } } });
        assert.deepEqual(config.read(), { theme: 'dark' });
        assert.equal(saveCalls, 1);
    } finally {
        await host.dispose();
    }
});
