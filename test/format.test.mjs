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

import {
    formatBytes,
    formatConversationMeta,
    formatDuration,
    formatTimestamp,
    resolveConversationTitle,
    stripChatNameCharacterPrefix,
    toPlainConversationPreview,
} from '../dist/runtime/ui/format.js';

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

test('the playbill card meta line counts messages under the name 「条」, never under 「楼」, and drops an absent half with its separator', () => {
    // 楼 has exactly one meaning in this app — a user turn, the number the
    // floor rail and the message header both count. A chat listing only
    // carries ST's `chat_items` (total .jsonl messages), so labelling that as
    // 楼 would put a number on the card that contradicts the rail one click
    // away. This test is the guard on that: if anyone "restores the design
    // copy" by swapping the unit, it fails here rather than in a screenshot.
    assert.equal(formatConversationMeta(42, '昨天'), '42 条 · 昨天');
    assert.ok(!formatConversationMeta(42, '昨天').includes('楼'));

    // Either half may be genuinely missing: a chat with no readable last_mes,
    // or a leased draft whose listing row has not arrived. Neither placeholder
    // is invented, and the separator leaves with the half it separated.
    assert.equal(formatConversationMeta(42, ''), '42 条');
    assert.equal(formatConversationMeta(0, '昨天'), '昨天');
    assert.equal(formatConversationMeta(0, ''), '');
    assert.equal(formatConversationMeta(Number.NaN, '  '), '');
    // An empty chat is not a chat with zero messages worth announcing.
    assert.equal(formatConversationMeta(-3, '10:24'), '10:24');
});

// ── 会话题名 ────────────────────────────────────────────────────────────────
//
// The topbar's fallback chain was `sessionName || characterName || 'ChatUI'`
// and it was never wrong about anything it was asked. It was asked the wrong
// question: ST's sessionName is never empty, so the guard never fired, and a
// brand-new chat printed its host filename — 「角色名 - 时间戳」 — directly under
// an eyebrow already showing 「角色名」. DESIGN §4.1 rules the repeat out with no
// escape clause. The question these two functions answer instead is「这名字是
// 宿主起的还是读者起的」.

const CHARACTER = 'Lounge Test Character';
/** Exactly what `humanizedDateTime()` emits (RossAscends-mods.js). */
const STAMP = '2026-08-01@01h25m42s735ms';

test('stripChatNameCharacterPrefix drops the host-repeated cast name and nothing that merely resembles it', () => {
    assert.equal(
        stripChatNameCharacterPrefix({ chatName: `${CHARACTER} - ${STAMP}`, characterName: CHARACTER }),
        STAMP,
    );

    // Only the exact 「名字 + 空格 + 短横 + 空格」 ST writes. A name that starts
    // with the character's name but does not carry that separator is a name
    // someone chose, and choosing it is the whole point.
    assert.equal(
        stripChatNameCharacterPrefix({ chatName: `${CHARACTER}的第二夜`, characterName: CHARACTER }),
        `${CHARACTER}的第二夜`,
    );
    assert.equal(
        stripChatNameCharacterPrefix({ chatName: `${CHARACTER}-${STAMP}`, characterName: CHARACTER }),
        `${CHARACTER}-${STAMP}`,
    );
    // Mid-string occurrences are not prefixes.
    assert.equal(
        stripChatNameCharacterPrefix({ chatName: `重逢 · ${CHARACTER} - 尾声`, characterName: CHARACTER }),
        `重逢 · ${CHARACTER} - 尾声`,
    );

    // With no character name to match, 「 - 」 is just punctuation: an empty
    // prefix must never turn 「 - 开场」 into 「开场」.
    assert.equal(
        stripChatNameCharacterPrefix({ chatName: ' - 开场', characterName: '' }),
        ' - 开场',
    );

    // The strip is exact, so it survives a chat the reader deliberately named
    // with the same shape — only the repeated half goes.
    assert.equal(
        stripChatNameCharacterPrefix({ chatName: `${CHARACTER} - 走廊尽头`, characterName: CHARACTER }),
        '走廊尽头',
    );
});

test('resolveConversationTitle treats a name ST generated as no name at all, and never repeats the eyebrow', () => {
    // The defect itself: ST's own name for a new character chat.
    assert.equal(
        resolveConversationTitle({ sessionName: `${CHARACTER} - ${STAMP}`, characterName: CHARACTER }),
        CHARACTER,
    );
    // …and for a new group chat, where ST writes the bare stamp with no prefix
    // (group-chats.js) and `characterName` carries the group's name.
    assert.equal(
        resolveConversationTitle({ sessionName: STAMP, characterName: '同台三人' }),
        '同台三人',
    );

    // A name the reader chose is shown as chosen, prefix stripped or not.
    assert.equal(
        resolveConversationTitle({ sessionName: 'act-two', characterName: CHARACTER }),
        'act-two',
    );
    assert.equal(
        resolveConversationTitle({ sessionName: `${CHARACTER} - 走廊尽头`, characterName: CHARACTER }),
        '走廊尽头',
    );
    // A checkpoint of an auto-named chat still carries something that tells it
    // apart, so it is a name: the stamp test is anchored and does not match a
    // stamp with anything appended.
    assert.equal(
        resolveConversationTitle({ sessionName: `${CHARACTER} - ${STAMP} - Checkpoint #1`, characterName: CHARACTER }),
        `${STAMP} - Checkpoint #1`,
    );

    // The tail of the chain, unchanged: no session name, then no cast name.
    assert.equal(resolveConversationTitle({ sessionName: '', characterName: CHARACTER }), CHARACTER);
    assert.equal(resolveConversationTitle({ sessionName: '   ', characterName: CHARACTER }), CHARACTER);
    assert.equal(resolveConversationTitle({ sessionName: `${CHARACTER} - `, characterName: CHARACTER }), CHARACTER);
    assert.equal(resolveConversationTitle({ sessionName: '', characterName: '' }), 'ChatUI');
    assert.equal(resolveConversationTitle({ sessionName: STAMP, characterName: '' }), 'ChatUI');

    // The whole reason the guard exists: whatever this returns for a chat ST
    // named, it must not be the string the eyebrow is already printing —
    // either the eyebrow's own name (in which case app.tsx's
    // 「characterName !== title」 test hands the eyebrow over to 「对话手记」) or
    // that name repeated inside a longer one.
    const generated = resolveConversationTitle({ sessionName: `${CHARACTER} - ${STAMP}`, characterName: CHARACTER });
    assert.ok(!generated.includes(STAMP), 'a host-generated stamp must never reach the title page');
    assert.ok(generated === CHARACTER, 'and the fallback is the cast name itself, which the eyebrow then yields to');
});

// ---------------------------------------------------------------------
// toPlainConversationPreview — the card's preview line as prose (ROADMAP B2)
//
// The input is ST's stored message text, tail-truncated to the last 400
// characters by getPreviewMessage() (src/endpoints/chats.js). So the cases
// below are written around three properties of that string rather than around
// a markdown grammar: it starts mid-syntax, it renders on one line, and not
// every delimiter in it is markup.
// ---------------------------------------------------------------------

test('the preview line prints prose, not the markdown the model wrote', () => {
    assert.equal(
        toPlainConversationPreview('她**没有**回头，只说了一句 *再见*。'),
        '她没有回头，只说了一句 再见。',
    );
    assert.equal(toPlainConversationPreview('~~算了~~ 走吧'), '算了 走吧');
    assert.equal(toPlainConversationPreview('用 `git rebase` 就行'), '用 git rebase 就行');
    assert.equal(toPlainConversationPreview('# 第三章\n雨停了。'), '第三章 雨停了。');
    assert.equal(toPlainConversationPreview('> 他说：别走。'), '他说：别走。');
    assert.equal(toPlainConversationPreview('- 一杯咖啡\n- 一把伞'), '一杯咖啡 一把伞');
    assert.equal(toPlainConversationPreview('1. 先开门\n2. 再关灯'), '先开门 再关灯');
});

test('a link keeps the words the reader would have read, and drops the address', () => {
    assert.equal(toPlainConversationPreview('见 [长廊剧场](https://example.com/a?b=c) 一章'), '见 长廊剧场 一章');
    assert.equal(toPlainConversationPreview('![一张旧照片](img/photo.png)'), '一张旧照片');
});

test('HTML is removed as markup and its entities are read as text', () => {
    assert.equal(toPlainConversationPreview('<div class="x">她笑了</div>'), '她笑了');
    assert.equal(toPlainConversationPreview('a &amp; b &lt;c&gt;'), 'a & b <c>');
    // Entities are decoded *after* tags, so a decoded `&lt;` can never be
    // mistaken for a tag and eat the rest of the line.
    assert.equal(toPlainConversationPreview('&lt;div&gt; 只是字面量'), '<div> 只是字面量');
});

test('a preview cut mid-syntax leaves no debris, because the input is a tail and not a head', () => {
    // getPreviewMessage() keeps the last 400 characters, so the string
    // routinely begins inside something. These are the shapes that produced
    // visible junk on the card.
    assert.equal(toPlainConversationPreview('...里说的那句 **话'), '...里说的那句 话');
    assert.equal(toPlainConversationPreview('class="mes">她转过身'), '她转过身');
    assert.equal(toPlainConversationPreview('她转过身 <spa'), '她转过身');
    assert.equal(toPlainConversationPreview('```js\nconst a = 1;\n```'), 'const a = 1;');
});

test('the line is one line: every newline becomes a space rather than vanishing', () => {
    // Fusing two sentences into one word is worse than the markup was.
    assert.equal(toPlainConversationPreview('第一句。\n第二句。'), '第一句。 第二句。');
    assert.equal(toPlainConversationPreview('  留白  \n\n  很多  '), '留白 很多');
});

test('a delimiter that is not markup is left where it is', () => {
    // The one direction that would be a regression rather than a leftover:
    // eating a character the writer meant.
    assert.equal(toPlainConversationPreview('2 * 3 = 6'), '2 * 3 = 6');
    assert.equal(toPlainConversationPreview('文件叫 snake_case_name'), '文件叫 snake_case_name');
    assert.equal(toPlainConversationPreview('_强调_ 与 a_b_c'), '强调 与 a_b_c');
    assert.equal(toPlainConversationPreview('5 < 7 且 9 > 2'), '5 < 7 且 9 > 2');
    // Each comparison on its own, which is what breaks a severed-tag rule
    // written as 「strip to the first `>`」 or 「strip from the last `<`」: with
    // no second angle bracket to stop it, such a rule eats the sentence.
    assert.equal(toPlainConversationPreview('他说 5 > 3'), '他说 5 > 3');
    assert.equal(toPlainConversationPreview('他说 5 < 7'), '他说 5 < 7');
});

test('an unusable preview reduces to the empty string rather than to a placeholder', () => {
    for (const value of ['', '   ', undefined, null, 42]) {
        assert.equal(toPlainConversationPreview(value), '', String(value));
    }
});
