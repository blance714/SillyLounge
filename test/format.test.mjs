// test/format.test.mjs
//
// dist/runtime/ui/format.js — pure formatting, no host/DOM needed.
// Source: src/ui/format.ts. Pins formatTimestamp against the shapes ST really
// writes into `send_date`:
//
//   - ISO 8601, what getMessageTimeStamp() has produced for every message
//     written by a current SillyTavern (public/scripts/RossAscends-mods.js).
//   - humanizedDateTime()'s `YYYY-M-D@HHhMMmSSsMSms`, carried by older chats
//     and not parseable by `Date` at all.
//   - epoch milliseconds, as a number and as a numeric string.
//
// The header renders this string as the design's 「第 N 楼 · 时间」 stamp, and
// the corridor-theater pass turns that header on by default in solo chats — so
// a shape that falls through unformatted is now a visible defect rather than a
// dormant one. That is exactly what happened: the old implementation returned
// every non-numeric string verbatim, printing `2026-01-04T00:00:02.000Z` into
// the header of every modern chat.
//
// Assertions here are deliberately locale- and timezone-independent: the exact
// rendered text depends on the reader's own locale, so what is pinned instead
// is that the recognized shapes resolve to *the same instant* as the epoch
// number for that instant (which cannot be true by accident if a shape is
// being dropped or misread), and that nothing invents a time for input it does
// not understand.

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBytes, formatDuration, formatTimestamp } from '../dist/runtime/ui/format.js';

/** 2026-01-04T00:00:02.000Z, expressed every way ST has ever stored it. */
const INSTANT_MS = Date.UTC(2026, 0, 4, 0, 0, 2, 0);

test('formatTimestamp renders every send_date shape SillyTavern writes as a clock time, and never invents one it cannot read', () => {
    const expected = formatTimestamp(INSTANT_MS);
    // A clock time, not a date stamp: no ISO punctuation survives, and the
    // result is short enough to sit in a message header.
    assert.match(expected, /\d/);
    assert.ok(!expected.includes('T') && !expected.includes('Z'), `unexpected ISO residue: ${expected}`);
    assert.ok(expected.length <= 11, `timestamp too long for the header stamp: ${expected}`);

    // ISO 8601 — the shape every current ST message carries. This is the
    // regression: it used to come back verbatim.
    assert.equal(formatTimestamp('2026-01-04T00:00:02.000Z'), expected);
    assert.notEqual(formatTimestamp('2026-01-04T00:00:02.000Z'), '2026-01-04T00:00:02.000Z');

    // Epoch milliseconds handed over as text must read as an offset, not as a
    // year: `new Date('1767484802000')` is an Invalid Date.
    assert.equal(formatTimestamp(String(INSTANT_MS)), expected);

    // humanizedDateTime()'s legacy shape, written from local-time getters, so
    // the local rendering of that wall-clock time is what it must round-trip
    // to. Built here from the local calendar rather than from INSTANT_MS so
    // the assertion holds in any timezone.
    const local = new Date(INSTANT_MS);
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const humanized = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
        + `@${pad(local.getHours())}h${pad(local.getMinutes())}m${pad(local.getSeconds())}s${pad(local.getMilliseconds(), 3)}ms`;
    assert.equal(formatTimestamp(humanized), expected);

    // Nothing to show is not the same as something unreadable: an empty stamp
    // yields an empty string (the header drops the segment), while a stamp no
    // known ST format explains is surfaced as-is rather than guessed at or
    // silently swallowed.
    assert.equal(formatTimestamp(null), '');
    assert.equal(formatTimestamp(''), '');
    assert.equal(formatTimestamp('   '), '   ');
    assert.equal(formatTimestamp('sometime last winter'), 'sometime last winter');
    assert.equal(formatTimestamp(Number.NaN), 'NaN');
});

test('formatDuration and formatBytes stay in the language the rest of the UI speaks and refuse to round a non-quantity into one', () => {
    // The reasoning block's 「思考了 N 秒」 trigger reads this straight.
    assert.equal(formatDuration(12_000), '12 秒');
    assert.equal(formatDuration('12000'), '12 秒');
    // Sub-second work is still work: it floors at one second rather than
    // rendering 「思考了 0 秒」.
    assert.equal(formatDuration(200), '1 秒');
    // No duration reported is not zero duration — the caller shows a label
    // without a number instead, so this must stay empty rather than become '0 秒'.
    assert.equal(formatDuration(0), '');
    assert.equal(formatDuration(-5), '');
    assert.equal(formatDuration(null), '');
    assert.equal(formatDuration('not a number'), '');

    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(10 * 1024), '10 KB');
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
    assert.equal(formatBytes(null), '');
    assert.equal(formatBytes(-1), '');
});
