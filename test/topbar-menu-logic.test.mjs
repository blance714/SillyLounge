// test/topbar-menu-logic.test.mjs
//
// dist/runtime/ui/topbar-menu-logic.js — pure gates, no host/DOM needed.
// Source: src/ui/topbar-menu-logic.ts.
//
// Two decisions the topbar's title and its ⋯ menu both need to make without
// ever touching the host:
//
//   - resolveTopbarRenameCommit: what an Enter/blur on the in-place rename
//     input should do — commit a trimmed name, or refuse as a no-op.
//   - resolveBranchFromLastFloor: whether「从末楼开新分支」may fire, and
//     which message id it targets.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveBranchFromLastFloor,
    resolveTopbarRenameCommit,
} from '../dist/runtime/ui/topbar-menu-logic.js';

const TARGET = Object.freeze({ avatar: 'ann.png', fileName: 'chat-1', displayName: 'chat-1' });
const LIVE = Object.freeze({ avatar: TARGET.avatar, fileName: TARGET.fileName });

test('resolveTopbarRenameCommit: a whitespace-only draft is refused as a no-op', () => {
    assert.equal(resolveTopbarRenameCommit(TARGET, '   ', LIVE), null);
    assert.equal(resolveTopbarRenameCommit(TARGET, '', LIVE), null);
});

test('resolveTopbarRenameCommit: a draft identical to the name on record (after trim) is refused', () => {
    assert.equal(resolveTopbarRenameCommit(TARGET, 'chat-1', LIVE), null);
    assert.equal(resolveTopbarRenameCommit(TARGET, '  chat-1  ', LIVE), null);
});

test('resolveTopbarRenameCommit: a live identity that no longer matches the chat rename was started against is refused', () => {
    assert.equal(
        resolveTopbarRenameCommit(TARGET, 'new name', { avatar: 'other.png', fileName: TARGET.fileName }),
        null,
        'a different avatar (character switched underneath the open input) refuses the commit',
    );
    assert.equal(
        resolveTopbarRenameCommit(TARGET, 'new name', { avatar: TARGET.avatar, fileName: 'other-chat' }),
        null,
        'a different fileName (same character, different chat now open) refuses the commit',
    );
    assert.equal(
        resolveTopbarRenameCommit(TARGET, 'new name', null),
        null,
        'no live identity at all (nothing open) refuses the commit',
    );
});

test('resolveTopbarRenameCommit: a genuine, trimmed rename against the still-live target commits', () => {
    assert.deepEqual(
        resolveTopbarRenameCommit(TARGET, '  new name  ', LIVE),
        { avatar: TARGET.avatar, fileName: TARGET.fileName, nextName: 'new name' },
    );
});

test('resolveBranchFromLastFloor: no messages yields disabled with no target id', () => {
    assert.deepEqual(resolveBranchFromLastFloor([], false), { enabled: false, messageId: null });
});

test('resolveBranchFromLastFloor: messages present and idle targets the last message id', () => {
    assert.deepEqual(resolveBranchFromLastFloor([3, 7, 12], false), { enabled: true, messageId: 12 });
});

test('resolveBranchFromLastFloor: generation in flight disables the row even with messages present', () => {
    assert.deepEqual(resolveBranchFromLastFloor([3, 7, 12], true), { enabled: false, messageId: null });
});
