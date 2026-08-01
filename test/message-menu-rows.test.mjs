// test/message-menu-rows.test.mjs
//
// dist/runtime/ui/message-menu-rows.js — pure data, no DOM.
// Source: src/ui/message-menu-rows.ts.
//
// These rows are now read by two components that must never disagree: the row
// draws the ⋯ trigger only if this list is non-empty, and a host at the app
// root draws the menu itself. The order is design §45's and is also asserted in
// the browser by scripts/e2e/measure-chat-switch.mjs; pinning it here as well
// is what makes a reordering fail in the cheap gate rather than the expensive
// one.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildMessageMenuRows,
    countMessageMenuSeparators,
} from '../dist/runtime/ui/message-menu-rows.js';
import { estimateMenuHeight } from '../dist/runtime/ui/menu-placement.js';

test('buildMessageMenuRows: an ordinary turn carries design §45\'s five rows, in order, with the rule drawn above the destructive one', () => {
    const rows = buildMessageMenuRows(false);

    assert.deepEqual(
        rows.map(row => row.label),
        ['复制', '复制原文', '从此楼开分支', '在此楼设检查点', '隐藏此楼'],
    );
    assert.deepEqual(
        rows.map(row => row.action),
        ['copy', 'copySource', 'branch', 'checkpoint', 'hide'],
        'each row names an action id, not a closure — that is what lets the host dispatch without the row still being mounted',
    );
    assert.deepEqual(
        rows.filter(row => row.separatorBefore).map(row => row.label),
        ['隐藏此楼'],
        '隐藏此楼 is ruled off because it is the only row that changes what the model is told',
    );
    assert.deepEqual(
        rows.filter(row => row.danger).map(row => row.label),
        ['隐藏此楼'],
    );
    assert.equal(
        rows.some(row => row.label === '编辑'),
        false,
        '编辑 is a tiled button since the §42 regroup, never a menu row',
    );
});

test('buildMessageMenuRows: a system row is not a turn anyone speaks, so it offers only the two copies', () => {
    const rows = buildMessageMenuRows(true);

    assert.deepEqual(rows.map(row => row.label), ['复制', '复制原文']);
    assert.equal(countMessageMenuSeparators(rows), 0, 'nothing to rule off when nothing is destructive');
    assert.notEqual(rows.length, 0, 'the ⋯ trigger renders on the strength of this list being non-empty');
});

test('the row lists feed the flip decision the sizes actually measured in Chromium', () => {
    const turn = buildMessageMenuRows(false);
    const system = buildMessageMenuRows(true);

    assert.equal(countMessageMenuSeparators(turn), 1);
    assert.equal(
        estimateMenuHeight(turn.length, countMessageMenuSeparators(turn)),
        184,
        'the 5-row + 1-separator menu measured at 184px (test/menu-placement.test.mjs)',
    );
    assert.equal(
        estimateMenuHeight(system.length, countMessageMenuSeparators(system)),
        76,
        'the 2-row system menu measured at 76px',
    );
});
