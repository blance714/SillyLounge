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
// checks the structural properties whose violation is both invisible and
// destructive:
//
//  1. every comment terminator in the file actually closes a comment that was
//     open (the pr4 topbar regression above);
//  2. every `var(--cui-…)` with no fallback names a token the file declares.
//
// The second has the same signature as the first — silence. A `var()` naming a
// property nobody declared is *valid syntax*, so nothing is dropped at parse
// time; it fails later, at computed-value time, where the declaration is thrown
// away and the property falls back to inherit-or-initial. A border painted that
// way comes out `currentColor`, i.e. a plausible wrong colour, and this
// palette has shipped that exact mistake twice (see the notes at the
// `--cui-color-border-*` and `--cui-*-hover` blocks). A browser gate can only
// catch it one token at a time, and only for tokens somebody thought to
// assert.

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

/** The file with every comment replaced by blanks, so offsets and lines hold. */
function stripComments(source) {
    const OPEN = '/' + '*';
    const CLOSE = '*' + '/';
    let out = '';
    let cursor = 0;
    while (cursor < source.length) {
        const open = source.indexOf(OPEN, cursor);
        if (open === -1) { out += source.slice(cursor); break; }
        out += source.slice(cursor, open);
        const close = source.indexOf(CLOSE, open + OPEN.length);
        const end = close === -1 ? source.length : close + CLOSE.length;
        // Keep the newlines so reported line numbers stay the file's own.
        out += source.slice(open, end).replace(/[^\n]/g, ' ');
        cursor = end;
    }
    return out;
}

/**
 * Every `--cui-*` token this file reads with no fallback but never declares.
 *
 * A reference written `var(--cui-x, …)` is deliberately not reported: the
 * fallback is the author saying what happens when the token is absent, which
 * is the whole failure mode this check exists to find.
 */
function findUndeclaredTokenReferences(source) {
    const code = stripComments(source);
    const declared = new Set(
        [...code.matchAll(/(--cui-[A-Za-z0-9_-]+)\s*:/g)].map(match => match[1]),
    );
    const missing = [];
    for (const match of code.matchAll(/var\(\s*(--cui-[A-Za-z0-9_-]+)\s*\)/g)) {
        if (declared.has(match[1])) continue;
        missing.push({
            token: match[1],
            line: code.slice(0, match.index).split('\n').length,
        });
    }
    return missing;
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

test('every --cui token style.css reads without a fallback is a token style.css declares', () => {
    const source = fs.readFileSync(STYLESHEET, 'utf8');
    const missing = findUndeclaredTokenReferences(source);
    assert.deepEqual(
        missing,
        [],
        'these var() references name a token nothing declares, so every declaration '
        + 'using them is discarded at computed-value time and the property silently '
        + 'falls back to inherit-or-initial:\n'
        + missing.map(entry => `  style.css:${entry.line}  ${entry.token}`).join('\n'),
    );
});

test('the undeclared-token scan catches a renamed token and ignores the two cases that are not bugs', () => {
    const declaresAndUses = [
        ':root {',
        '    --cui-color-edge: #3f372c;',
        '}',
        '.card { border-color: var(--cui-color-edge); }',
    ].join('\n');
    assert.deepEqual(findUndeclaredTokenReferences(declaresAndUses), []);

    // The regression: the declaration is renamed, the reader is not. Valid
    // syntax, no parse error, and the border comes out currentColor.
    const renamed = declaresAndUses.replace('--cui-color-edge: ', '--cui-color-border-strong: ');
    assert.deepEqual(
        findUndeclaredTokenReferences(renamed),
        [{ token: '--cui-color-edge', line: 4 }],
    );

    // Not a bug 1: a reference that carries its own fallback has already said
    // what absence means.
    const withFallback = renamed.replace(
        'var(--cui-color-edge)',
        'var(--cui-color-edge, #3f372c)',
    );
    assert.deepEqual(findUndeclaredTokenReferences(withFallback), []);

    // Not a bug 2: a token named only inside a comment declares nothing and
    // reads nothing — prose about the palette must not be able to fail this.
    const inProse = [
        '/' + '* --cui-color-edge was folded into var(--cui-color-ghost) in pr9. *' + '/',
        ':root { --cui-color-ink: #e8e0d0; }',
    ].join('\n');
    assert.deepEqual(findUndeclaredTokenReferences(inProse), []);
});
