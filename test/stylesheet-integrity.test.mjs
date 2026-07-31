// test/stylesheet-integrity.test.mjs
//
// style.css is the one build input nothing else in `verify` can read: it is
// copied to the runtime tree verbatim, never parsed, never typechecked. A CSS
// parser's response to a malformed rule is to drop it silently — no error, no
// console warning, nothing a behaviour-level e2e assertion would notice — so a
// stylesheet can lose a whole block and stay green through typecheck, the unit
// suites, the runtime contract and the browser gate alike.
//
// That is not hypothetical. From the pr4 reskin until pr9, a comment above
// `.cui-root-topbar` contained a star immediately followed by a slash inside a
// sentence about token names. CSS comments do not nest and do not care about
// prose: the comment ended there, the rest of the sentence became an invalid
// selector, and the parser skipped forward to the end of the next block —
// which was the topbar's own. For two release batons the topbar therefore had
// no display:flex, no reading width, no dashed rule and no padding, and every
// gate reported success.
//
// This suite is the missing reader. It does not attempt to validate CSS; it
// checks the one structural property whose violation is both invisible and
// destructive — that every comment terminator in the file actually closes a
// comment that was open.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLESHEET = path.join(PROJECT_ROOT, 'style.css');

/**
 * Walk the file the way a CSS tokenizer does — open at the first `/*`, close
 * at the first terminator after it — and report any terminator found in the
 * stretches between comments, i.e. in what the parser reads as code.
 */
function findStrayCommentTerminators(source) {
    const OPEN = '/' + '*';
    const CLOSE = '*' + '/';
    const stray = [];
    let cursor = 0;
    while (cursor < source.length) {
        const open = source.indexOf(OPEN, cursor);
        const codeEnd = open === -1 ? source.length : open;
        const strayOffset = source.slice(cursor, codeEnd).indexOf(CLOSE);
        if (strayOffset !== -1) {
            const at = cursor + strayOffset;
            stray.push({
                line: source.slice(0, at).split('\n').length,
                context: source.slice(Math.max(0, at - 80), at + 20).replace(/\n/g, ' ⏎ '),
            });
        }
        if (open === -1) break;
        const close = source.indexOf(CLOSE, open + OPEN.length);
        if (close === -1) break;
        cursor = close + CLOSE.length;
    }
    return stray;
}

test('style.css has no comment terminator that lands in code, so no rule block is silently dropped', () => {
    const source = fs.readFileSync(STYLESHEET, 'utf8');
    const stray = findStrayCommentTerminators(source);
    assert.deepEqual(
        stray,
        [],
        'a comment ended early and the text after it is being parsed as CSS; '
        + 'the rule block that follows is being discarded:\n'
        + stray.map(entry => `  style.css:${entry.line}  …${entry.context}…`).join('\n'),
    );
});

test('the stray-terminator scan actually detects the pr4 topbar regression it exists to prevent', () => {
    // The exact shape that dropped the topbar block: a glob list written with
    // slashes inside a comment, followed by the rule it silently ate.
    const regressed = [
        '/' + '* every length below (not a --cui-font-*' + '/--cui-tracking-* token) is px. *' + '/',
        'body.chatui-active .cui-root-topbar {',
        '    display: flex;',
        '}',
    ].join('\n');
    const stray = findStrayCommentTerminators(regressed);
    assert.equal(stray.length, 1, 'the scan must flag a comment that closes inside a token glob');
    assert.equal(stray[0].line, 1);

    // …and stays quiet on the same sentence written without the hazard.
    const repaired = regressed.replace(
        '--cui-font-*' + '/--cui-tracking-*',
        '--cui-font-… or --cui-tracking-…',
    );
    assert.deepEqual(findStrayCommentTerminators(repaired), []);
});
