/**
 * SillyTavern-ChatUI · message adapter
 */

import {
    ensureSwipes,
    eventSource,
    event_types,
    extractMessageBias,
    isGenerating,
    refreshSwipeButtons,
    removeMacros,
    saveChatConditional,
    saveChatDebounced,
    substituteParams,
    swipe as stSwipe,
    syncSwipeToMes,
    system_message_types,
    updateEditArrowClasses,
} from '@st/script';
import { getRegexedString, regex_placement } from '@st/regex-engine';
import { copyText } from '@st/utils';
import { branchChat, createNewBookmark } from '@st/bookmarks';
import { hideChatMessage, unhideChatMessage } from '@st/chats';
import { deleteItemizedPromptForMessage } from '@st/itemized-prompts';
import {
    _dispatchClick,
    _getMessageId,
    getContext,
    getCurrentChat,
    getMessageByElement,
    getMessageById,
    getMessageElementById,
} from './internals.js';
import { parseMessageRecord } from './schema.js';

type MessageId = number | string;
export type MessageAction = 'copySource' | 'regen' | 'branch' | 'checkpoint' | 'hide';
export type SwipeDirection = 'left' | 'right';
export type DeleteIntent = 'swipe' | 'message';

type DeleteSettingsContext = {
    powerUserSettings?: {
        confirm_message_delete?: unknown;
    };
};

function arrayLength(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

export function getSwipeLabel(mesEl: Element): string {
    const msg = parseMessageRecord(getMessageByElement(mesEl));
    if (!msg || msg.swipes.length <= 1) return '';
    const idx = msg.swipe_id ?? 0;
    return `${idx + 1}​/​${msg.swipes.length}`;
}

/**
 * @param {HTMLElement} item
 * @param {{ isSystem?: boolean, mediaDisplay?: string }} messageMeta
 * @returns {boolean}
 */
export function isOverflowActionVisible(
    item: HTMLElement,
    messageMeta: { isSystem?: boolean; mediaDisplay?: string } = {},
) {
    const { isSystem = false, mediaDisplay = '' } = messageMeta;

    if (item.classList.contains('displayNone')) return false;
    if (item.style.display === 'none') return false;
    if (item.classList.contains('mes_copy')) return false;

    const explicitlyShown = item.style.display && item.style.display !== 'none';
    if (explicitlyShown) return true;

    if (item.matches('.mes_translate, .sd_message_gen, .mes_narrate')) return false;
    if (item.classList.contains('mes_prompt')) return false;
    if (item.classList.contains('mes_swipe_picker')) return false;
    if (item.classList.contains('mes_hide') && isSystem) return false;
    if (item.classList.contains('mes_unhide') && !isSystem) return false;
    if (item.classList.contains('mes_media_gallery') && mediaDisplay !== 'gallery') return false;
    if (item.classList.contains('mes_media_list') && mediaDisplay !== 'list') return false;

    return true;
}

export function triggerOverflowAction(original: Element): void {
    _dispatchClick(original);
}

/**
 * 「复制原文（含标记）」 (design §45): the message exactly as SillyTavern
 * stored it — every asterisk, tag and macro remnant included. This is also
 * byte-for-byte what native's own `.mes_copy` handler puts on the clipboard
 * (script.js:11752-11763), so the escape hatch keeps host parity while the
 * plain 「复制」 below answers the other, more common need.
 */
export async function copyMessageSource(mesId: MessageId): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for copy: ${mesId}`);
    }
    // getMessageById + copyText is a DOM-free read (utils.js:546's clipboard API
    // main path never touches `.mes`) — Tier 1 of DOM-DECOUPLING.md.
    const rawMessage = getMessageById(normalizedId);
    if (
        !rawMessage
        || typeof rawMessage !== 'object'
        || Array.isArray(rawMessage)
        || typeof (rawMessage as Record<string, unknown>).mes !== 'string'
    ) {
        throw new Error(`[ChatUI/adapter] Message record not found for copy: ${normalizedId}`);
    }
    await copyText((rawMessage as Record<string, string>).mes);
}

/**
 * Structural view of a parsed node, not the DOM's own `Node`. The reduction
 * below needs exactly four fields, and naming them is what lets the walk be
 * unit-tested against hand-built trees: the fake host's DOM (see
 * test/helpers/fake-st-host.mjs) parses no HTML at all, so the `DOMParser`
 * step in `plainTextFromMessageHtml` is a real-browser-only seam — the same
 * standing `_deleteFullMessageById`'s own `mesEl?.remove()` already has.
 */
type PlainTextNode = {
    nodeType?: number;
    nodeName?: string;
    nodeValue?: string | null;
    childNodes?: ArrayLike<PlainTextNode> | null;
};

const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 3;

/**
 * Tags a reader sees as a line of their own. This is the flow-content list
 * from HTML's own block/inline split — the same rule `innerText` applies, which
 * is the behaviour we want but cannot use: `innerText` is layout-dependent and
 * a detached (or `DOMParser`-produced, inert) node degrades it back to
 * `textContent`, collapsing every paragraph into one run-on line.
 */
const PLAIN_TEXT_BREAK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL',
    'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
    'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
    'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TR', 'UL',
]);

/** Cells separate along the row, rows separate down the table. */
const PLAIN_TEXT_CELL_TAGS = new Set(['TD', 'TH']);

function _collectPlainText(node: PlainTextNode, out: string[]): void {
    if (node.nodeType === NODE_TYPE_TEXT) {
        out.push(node.nodeValue ?? '');
        return;
    }
    if (node.nodeType !== NODE_TYPE_ELEMENT) return;

    const tag = String(node.nodeName ?? '').toUpperCase();
    if (tag === 'BR') {
        out.push('\n');
        return;
    }

    const breaks = PLAIN_TEXT_BREAK_TAGS.has(tag);
    if (breaks) out.push('\n');
    const children = node.childNodes;
    const count = children?.length ?? 0;
    for (let index = 0; index < count; index += 1) {
        const child = children?.[index];
        if (child) _collectPlainText(child, out);
    }
    if (breaks) out.push('\n');
    else if (PLAIN_TEXT_CELL_TAGS.has(tag)) out.push('\t');
}

function _normalizePlainText(raw: string): string {
    return raw
        .replace(/\r\n?/g, '\n')
        // Whitespace that only ever existed to pad a break is not content.
        .replace(/[^\S\n]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Test seam for the reduction itself: everything except the `DOMParser` call.
 * Exported the way `_deleteSwipeById` is — an adapter internal the unit suite
 * pins directly, never part of the frozen facade.
 */
export function _plainTextFromNode(node: PlainTextNode): string {
    const parts: string[] = [];
    _collectPlainText(node, parts);
    return _normalizePlainText(parts.join(''));
}

/**
 * Reduce one already-rendered message body to the prose a reader sees.
 * `DOMParser` rather than `div.innerHTML`: the parsed document is inert, so a
 * message body carrying `<img src>` cannot turn a clipboard action into a
 * network fetch.
 */
export function plainTextFromMessageHtml(html: string): string {
    if (!html) return '';
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return _plainTextFromNode(parsed.body as unknown as PlainTextNode);
}

/**
 * 「复制」 (design §45): the message with its markers taken off.
 *
 * Takes the already-formatted HTML rather than a message id on purpose. ST's
 * formatter re-resolves non-deterministic macros ({{random::a,b}}) on every
 * call, so formatting again here would hand the user a version of the message
 * that was never on screen. The store already holds the exact string the row
 * rendered from (chat-store's formatted-HTML cache); this side owns the
 * clipboard and the HTML -> text reduction, and nothing else.
 */
export async function copyMessageAsPlainText(html: string): Promise<void> {
    await copyText(plainTextFromMessageHtml(html));
}

/**
 * @returns {void}
 */
export function regenerateMessage() {
    if (isGenerating()) throw new Error('[ChatUI/adapter] Generation is already active');
    const button = document.getElementById('option_regenerate');
    if (!button) throw new Error('[ChatUI/adapter] Regenerate action not found');
    button.click();
}

/**
 * @returns {void}
 */
export function regenerateLast() {
    regenerateMessage();
}

// editMessage()/this_edit_mes_id-shadow used to live here. DOM-DECOUPLING.md
// Tier 3 (2026-07-19) removed both:
//
// - editMessage() dispatched a click on native `.mes_edit` to *open* ST's
//   editor. Nothing in this repo ever called it through a real user action:
//   ChatUI's own "enter edit mode" is purely local Preact state
//   (app.tsx's `editingMessage`, wired via MessageActions.tsx's `onEdit`
//   prop, never `triggerChatuiMessageAction(id, 'edit', ...)`) — grepped,
//   zero callers of the `'edit'` action string anywhere in src/ui or
//   src/store. Its only reachable caller was triggerMessageActionById's own
//   now-removed `'edit'` case below.
// - `_shadowEditedMessageId` mirrored ST's module-private `this_edit_mes_id`
//   (script.js:610, setter-only export, no getter — script.js:7101) so the
//   delete fork could reproduce native deleteMessage()'s conditional reset
//   without read access to the real variable. Its entire justification was
//   "saveMessageEditById() is the only ChatUI path that ever sets the real
//   this_edit_mes_id" (via the old synthetic click into native messageEdit()
//   below) — Tier 3's saveMessageEditById never opens a native edit session
//   at all anymore, so that write site is gone, and with it the one case the
//   shadow ever tracked correctly. Keeping a permanently-`undefined` shadow
//   variable and its now-always-false delete-fork guard around would be
//   exactly the "two contradictory mechanisms" this tier was asked to
//   reconcile, not simplify — removed instead. See _deleteFullMessageById's
//   doc comment for what replaces step 8 there, and DOM-DECOUPLING.md/
//   INVARIANTS.md §16 for the one residual gap this can no longer even
//   partially cover (a user bypassing ChatUI's shield to open a *native*
//   edit session directly, then deleting that same message through ChatUI —
//   already out of scope pre-Tier-3 too, since the shadow could never
//   observe a shield-bypass write in the first place).

/** Loosely-typed live `chat[]` entry shape this fork reads/writes directly —
 * mirrors exactly the fields ST's own updateMessage() (script.js:8080-8134)
 * touches, no more. */
type EditableMessageRecord = {
    mes?: string;
    name?: string;
    is_user?: boolean;
    is_system?: boolean;
    swipe_id?: number;
    swipes?: unknown[];
    extra?: { type?: string; bias?: unknown; [key: string]: unknown } | null;
};

/**
 * Find message `id`'s currently-rendered `.mes` row, if any, by walking
 * `#chat`'s direct `.children` — the same approach
 * `_renumberRenderedRowsAfterDelete` below already uses (see its doc comment
 * for the full rationale), reused here instead of the compound CSS selector
 * `getMessageElementById` uses elsewhere in this file. Two reasons: (1) the
 * unit-test fake DOM (test/helpers/fake-st-host.mjs) can build a real `#chat`
 * tree via document.createElement but cannot resolve compound selectors, so
 * this is the only way _healRenderedMessageRow's "was this row actually
 * rendered" branch is unit-testable at all, matching the precedent already
 * set for the delete fork's renumber step; (2) `.mes` rows are always direct
 * children of `#chat` in real ST too (native only ever `.append()`/
 * `.prepend()`s them straight onto `chatElement = $('#chat')` —
 * script.js:1457/1481/1520/2530), so this is not a weaker check against a
 * real browser DOM either.
 */
function _findRenderedMessageRow(id: number): HTMLElement | null {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return null;
    for (const child of Array.from(chatContainer.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (!child.classList.contains('mes')) continue;
        if (Number(child.getAttribute('mesid')) === id) return child;
    }
    return null;
}

/**
 * Heals a currently-rendered native `.mes` row after saveMessageEditById
 * below mutates `chat[]` directly, without ever going through native's own
 * messageEditDone() DOM update. The shield only CSS-hides the native
 * window — its `.mes` rows stay mounted — so for any message inside the
 * native truncation window this healing branch is the COMMON live path
 * (empirically confirmed: the CI smoke edit round-trip invokes it and the
 * row's `.mes_text` reads back the edited text on every run), and it is
 * what keeps a flag-off in-place teardown from ever revealing stale
 * pre-edit text.
 *
 * Uses ST's own exported `updateMessageBlock(messageId, message)`
 * (script.js:1974, reachable through `getContext()` — re-exported by
 * st-context.js, no new `@st/*` mapping needed) instead of reimplementing
 * its DOM bundle: it re-renders `.mes_text` from the message's *current*
 * `mes`/`extra.display_text`, refreshes reasoning UI, re-adds
 * copy-to-codeblock buttons, and re-appends media in one call — exactly the
 * "write back to the masked native window to keep host consistency" idiom
 * DOM-DECOUPLING.md already establishes for other actions.
 *
 * updateMessageBlock is deliberately called *guarded*, never relied on for
 * its own DOM tolerance the way delete's helpers are: verified against the
 * pinned checkout, `updateMessageBlock` hands its *jQuery selection*
 * (`chatElement.find(...)`, possibly empty) straight to
 * `updateReasoningUI(messageElement)` (script.js:1981), which forwards
 * into `ReasoningHandler#initHandleMessage` (reasoning.js:236,319). That
 * function only special-cases a raw `number` or `HTMLElement` input
 * (reasoning.js:321-325) — a jQuery object (even an empty one) falls through
 * to `$(messageIdOrElement)[0]`, and wrapping an already-empty selection in
 * `$()` again is still empty, so `[0]` is `undefined`. The very next line
 * unconditionally calls `messageElement.getAttribute(...)`
 * (reasoning.js:326) on that `undefined` — a TypeError, not a silent no-op.
 * So unlike `deleteItemizedPromptForMessage`/`refreshSwipeButtons`/
 * `updateEditArrowClasses` elsewhere in this file, `updateMessageBlock` is
 * NOT safe to call unconditionally on an unrendered message — this function
 * exists specifically to gate it.
 *
 * characterOverride/display-name derivation: saveMessageEditById's own
 * mutation step below reads `mes.name` directly (matching native
 * updateMessage()'s own `characterOverride: ... mes.name`, script.js:8104 —
 * *not* the module-private `this_edit_mes_chname`, which updateMessage()
 * never references at all), and updateMessageBlock's own rendering also
 * reads `message.name` directly (script.js:1978) — so there is no
 * `this_edit_mes_chname` staleness to reconcile here, in solo or group chats
 * alike; that variable only ever mattered to messageEditDone/
 * messageEditCancel/messageEditAuto's own DOM rendering, none of which this
 * fork calls. One narrow, pre-existing divergence for the *rendered label
 * only* (never the persisted `chat[]` data): native's messageEditDone()
 * rendering uses `this_edit_mes_chname`, computed with a `name1`/`name2`
 * fallback for a falsy `.name` (script.js:8194,
 * `editMessage.name || (editMessage.is_user ? name1 : name2)`);
 * updateMessageBlock, like updateMessage() itself, does not apply that
 * fallback. Every ChatUI-reachable message record already has `.name`
 * populated at creation time, and native's own *mutation* path already
 * carries this same un-fallbacked read — this fork inherits an existing
 * native quirk rather than introducing a new one.
 */
function _healRenderedMessageRow(id: number, mes: EditableMessageRecord): void {
    if (!_findRenderedMessageRow(id)) return;
    const ctx = getContext() as { updateMessageBlock?: (messageId: number, message: unknown) => void };
    ctx.updateMessageBlock?.(id, mes);
}

/**
 * Full DOM-free fork of ST's `updateMessage()` + `messageEditDone()`
 * (script.js:8080-8134 and script.js:8337-8375, the latter minus its own DOM
 * gate at the very top and every DOM-rendering step) — reimplemented
 * directly against the live `chat[]` entry instead of ever driving native's
 * `.mes_edit`/`.mes_edit_done` buttons or opening a native edit session at
 * all. DOM-DECOUPLING.md Tier 3 (2026-07-19). This is the change that
 * finally unblocks the native-truncation-window flag: unlike Tier 2's
 * delete fork (already DOM-tolerant), edit-save through Tier 1/2 still
 * required a live `#chat .mes[mesid=X]` node end to end (see the old
 * synthetic-click implementation this replaced), which chat_truncation=1
 * would break for every non-last message.
 *
 * Reproduces every observable data effect of native's `updateMessage()` body,
 * in the exact same order (native line numbers from the pinned checkout):
 *
 *  1. Look up `chat[id]` (native's `mes = chat[mesElement.attr('mesid')]`,
 *     script.js:8085) — missing/non-object throws here (unlike native, which
 *     assumes its own DOM-gated caller already validated this).
 *  2. `mes.extra ??= {}` (script.js:8088).
 *  3. regexPlacement selection — the exact 3-branch `is_user` /
 *     `extra.type === 'narrator'` / else `AI_OUTPUT` switch (script.js:8091-
 *     8097), copied branch-for-branch.
 *  4. `getRegexedString(text, regexPlacement, { characterOverride, isEdit:
 *     true })` (script.js:8100-8107, imported from the regex engine module
 *     directly — `@st/regex-engine`, a new mapping alongside the existing
 *     `@st/*` set; script.js itself imports but never re-exports
 *     `getRegexedString`/`regex_placement`, so `getContext()` and the
 *     existing `@st/script` mapping both dead-end here — verified by
 *     grepping the pinned checkout's `export { ... }` compat block at the
 *     bottom of script.js, which does not list either name).
 *     `characterOverride` is `mes.name` (undefined when narrator), never
 *     `this_edit_mes_chname` — see _healRenderedMessageRow's doc comment for
 *     why that has no bearing on group-chat correctness.
 *  5. `if (power_user.trim_spaces) text = text.trim()` (script.js:8110-8112)
 *     — read via `getContext().powerUserSettings` (the same live reference
 *     `getConfirmMessageDeleteSetting()` below already reads from), not a
 *     new mapping.
 *  6. `bias = substituteParams(extractMessageBias(text))` — bias extracted
 *     from the *pre-substitution* text, matching native's exact order
 *     (script.js:8114); `text = substituteParams(text)` (script.js:8115);
 *     `if (bias) text = removeMacros(text)` (script.js:8116-8118).
 *  7. `mes.mes = text` (script.js:8119). `if (mes.swipe_id !== undefined) {
 *     ensureSwipes(mes); mes.swipes[mes.swipe_id] = text; }`
 *     (script.js:8120-8123) — `ensureSwipes` strictly before the write,
 *     matching native exactly, including native's own footgun this fork
 *     deliberately does not paper over: `ensureSwipes` is a no-op for
 *     `is_user`/`isSmallSys` messages (script.js:6787), so a malformed
 *     record with `swipe_id` set on a message `ensureSwipes` refuses to
 *     touch would throw on the write in native too — byte-identical
 *     behavior, not a bug this fork introduces.
 *  8. `mes.extra.bias = bias ?? null` when `is_system || is_user ||
 *     extra.type === system_message_types.NARRATOR`, else `mes.extra.bias =
 *     null` (script.js:8125-8129).
 *  9. `chat_metadata.tainted = true` (script.js:8131), via
 *     `getContext().chatMetadata` — the same live-reference pattern
 *     `_deleteSwipeById`/`_deleteFullMessageById` already use.
 *
 * Then reproduces messageEditDone()'s post-`updateMessage()` orchestration,
 * again in the exact same order:
 *
 * 10. `await eventSource.emit(MESSAGE_EDITED, id)` (script.js:8345) — strictly
 *     before MESSAGE_UPDATED below, matching native exactly.
 * 11. `_healRenderedMessageRow(id, mes)` in place of native's own inline DOM
 *     rebuild (script.js:8346-8369 — mesBlock swap, `messageFormatting`,
 *     bias re-render, `appendMediaToMessage`, `addCopyToCodeBlocks`, the
 *     conditional `.mes_reasoning_edit_done` click). Passing the *same* live
 *     `mes` reference this function already mutated reproduces native's own
 *     `text = chat[this_edit_mes_id]?.mes ?? text` re-read
 *     (script.js:8346) for free — there is no separate local `text` copy to
 *     go stale, because updateMessageBlock reads `message.mes` fresh off the
 *     object we hand it, same as native re-reading `chat[id].mes` after the
 *     event. The reasoning-edit-done click has no ChatUI equivalent: this
 *     fork never opens a native reasoning-edit UI session, so there is
 *     nothing to close (see the reasoning-auto-commit-cascade note below).
 * 12. `await eventSource.emit(MESSAGE_UPDATED, id)` (script.js:8371).
 * 13. `this_edit_mes_id = undefined` (script.js:8372) — intentionally
 *     **not** reproduced. This fork never opens a native edit session, so it
 *     never sets the real `this_edit_mes_id` to begin with (see the removed
 *     `_shadowEditedMessageId` comment above `_findRenderedMessageRow`); an
 *     unconditional reset here would be *more* than native does (native only
 *     resets when the variable already equals this id) and, without a
 *     getter, there is no way to check that condition safely — an
 *     unconditional call could stomp an unrelated, legitimately in-progress
 *     native edit session opened by directly bypassing ChatUI's shield. That
 *     shield-bypass scenario was already the shadow's one documented,
 *     unfixable gap (it could never observe a shield-bypass write either);
 *     Tier 3 does not make it worse, it just stops half-pretending to guard
 *     against it.
 * 14. `await saveChatConditional()` (script.js:8373).
 * 15. `showSwipeButtons()` (script.js:8374) — reproduced as a direct
 *     `refreshSwipeButtons()` call instead, matching the precedent already
 *     set by `_deleteFullMessageById` below. `showSwipeButtons()`'s only
 *     substantive job beyond that is resetting the module-private
 *     `swipesHidden = false` (script.js:9254) — a flag this fork's own
 *     call graph never sets `true` in the first place (no ChatUI path calls
 *     native `hideSwipeButtons()`), so the reset would be a no-op even under
 *     native itself here.
 *
 * Known accepted no-op, not attempted: the reasoning auto-commit cascade
 * (script.js:8366 <-> reasoning.js:1271, triggered by the
 * `.mes_reasoning_edit_done:visible` click in step 11 above) has no non-DOM
 * entry point and nothing in ChatUI today opens a native reasoning-edit UI
 * session for it to ever fire against — already documented in
 * DOM-DECOUPLING.md's "附带发现与残留风险" as out of scope until a future
 * native-reasoning-edit UI is built.
 */
export async function saveMessageEditById(mesId: MessageId, text: string): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isFinite(normalizedId)) {
        throw new Error(`[ChatUI/adapter] Invalid message id for edit: ${mesId}`);
    }

    const mes = getMessageById(normalizedId) as EditableMessageRecord | null;
    if (!mes || typeof mes !== 'object') {
        throw new Error(`[ChatUI/adapter] Message record not found for edit: ${normalizedId}`);
    }

    mes.extra ??= {};

    let placement: number;
    if (mes.is_user) {
        placement = regex_placement.USER_INPUT;
    } else if (mes.extra?.type === 'narrator') {
        placement = regex_placement.SLASH_COMMAND;
    } else {
        placement = regex_placement.AI_OUTPUT;
    }

    let nextText = getRegexedString(text, placement, {
        characterOverride: mes.extra?.type === 'narrator' ? undefined : mes.name,
        isEdit: true,
    });

    const powerUserCtx = getContext() as { powerUserSettings?: { trim_spaces?: unknown } };
    if (powerUserCtx.powerUserSettings?.trim_spaces) {
        nextText = nextText.trim();
    }

    const bias = substituteParams(extractMessageBias(nextText));
    nextText = substituteParams(nextText);
    if (bias) {
        nextText = removeMacros(nextText);
    }

    mes.mes = nextText;
    if (mes.swipe_id !== undefined) {
        ensureSwipes(mes);
        (mes.swipes as unknown[])[mes.swipe_id] = nextText;
    }

    if (mes.is_system || mes.is_user || mes.extra?.type === system_message_types.NARRATOR) {
        mes.extra.bias = bias ?? null;
    } else {
        mes.extra.bias = null;
    }

    const chatMetaCtx = getContext() as { chatMetadata?: { tainted?: boolean } };
    if (chatMetaCtx.chatMetadata) chatMetaCtx.chatMetadata.tainted = true;

    await eventSource.emit(event_types.MESSAGE_EDITED, normalizedId);

    _healRenderedMessageRow(normalizedId, mes);

    await eventSource.emit(event_types.MESSAGE_UPDATED, normalizedId);

    await saveChatConditional();
    refreshSwipeButtons();
}

export async function createBranch(mesId: MessageId): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for branch: ${mesId}`);
    }
    // branchChat() never queries `.mes` (bookmarks.js:449) — Tier 1 direct id
    // call; the chat-switch navigation side effect is intentional.
    await branchChat(normalizedId);
}

export async function createCheckpoint(mesId: MessageId): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for checkpoint: ${mesId}`);
    }
    // createNewBookmark()'s only DOM touch is a decorative ribbon-tag update
    // guarded by an empty jQuery selection when unrendered — safe no-op
    // (bookmarks.js:292-310). Tier 1 direct id call.
    await createNewBookmark(normalizedId);
}

export async function toggleHideMessage(mesId: MessageId): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for hide: ${mesId}`);
    }
    const msg = parseMessageRecord(getMessageById(normalizedId));
    if (!msg) {
        throw new Error(`[ChatUI/adapter] Message record not found for hide: ${normalizedId}`);
    }
    // Source of truth is the message flag (is_system), not native button
    // visibility — reading the DOM could pick the wrong direction.
    const action = msg.is_system === true ? unhideChatMessage(normalizedId) : hideChatMessage(normalizedId);
    await action;
}

type SwipeArrayMessage = {
    swipes?: unknown;
    swipe_info?: unknown;
    swipe_id?: unknown;
};

/**
 * Deletes exactly one swipe candidate as a self-contained mini-fork of ST's
 * exported deleteSwipe() (script.js:9279-9346) — reimplemented directly
 * against the live `chat[]` entry instead of calling ST's own function at
 * all. This mirrors how DOM-DECOUPLING.md already plans Tier 2's delete
 * (整条) fork; this graduates delete(仅 swipe) from a direct call into a
 * mini-fork with the same contract-test obligation (see the dedicated
 * `_deleteSwipeById` tests in test/messages.test.mjs).
 *
 * Why a mini-fork instead of calling ST's deleteSwipe(): when the deleted
 * swipe is the message's *active* swipe, ST's own deleteSwipe() tries to
 * resync `mes` by calling its exported swipe() internally (script.js:9333,
 * `source: SWIPE_SOURCE.DELETE`). swipe() sets the module-global
 * `swipeState = SWIPE_STATE.SWIPING` (script.js:9935) *before* its own DOM
 * gate (`![thisMesDiv.length, thisMesText.length].every(...)`,
 * script.js:9942) bails out on an unrendered message — and that gate
 * `return`s before ever reaching the `swipeState = SWIPE_STATE.NONE` reset
 * inside endSwipe() (script.js:10039). `swipeState` is a bare `export let`
 * (script.js:415) with no exported setter anywhere in script.js (verified by
 * grepping every `SWIPE_STATE` assignment in the pinned checkout) — once
 * stuck at SWIPING there is no way to reset it from outside short of a page
 * reload, and a stuck SWIPING state silently disables every future swipe
 * (isSwipingAllowed(), script.js:9111) *and* every future send
 * (sendTextareaMessage(), script.js:1711) app-wide. Since deleteMessage()
 * below always selects the message's *current* swipe_id for deletion, this
 * is always the active-swipe branch on every real call — routing through
 * deleteSwipe() at all would make the corruption reachable on every single
 * swipe-only delete of an unrendered message, not just an edge case. So this
 * function never calls ST's deleteSwipe() or swipe(): it reimplements
 * deleteSwipe()'s pure body directly (splice swipes/swipe_info, reassign
 * swipe_id, mark chat_metadata.tainted, emit MESSAGE_SWIPE_DELETED with the
 * exact payload shape ST uses, then syncSwipeToMes()/saveChatConditional() —
 * both verified DOM-free, script.js:6895 and script.js:9352).
 *
 * Exercised under truncation=0 and truncation=1 alike: this eligibility
 * policy only ever fires on the chat's last message (isLast required, see
 * deleteMessage() below), and native truncation=1 keeps exactly that message
 * rendered — so in practice this corruption path was already unreachable
 * under truncation=1 even before this fix (the DOM gate ST's swipe() checks
 * would have passed). It is truncation=0 (today's default; no code path in
 * this repo implements chat_truncation yet — see DOM-DECOUPLING.md "停用恢复
 * 机制") and any future state where the last message hasn't mounted yet
 * (e.g. a fresh chat load, a virtualization edge) that this fix actually
 * protects against. Bypassing deleteSwipe() entirely removes the dependency
 * on that DOM timing altogether, rather than relying on truncation mode to
 * keep it out of reach.
 */
export async function _deleteSwipeById(mesId: number, swipeId: number): Promise<void> {
    const rawMessage = getMessageById(mesId) as SwipeArrayMessage | null;
    const swipes = rawMessage && Array.isArray(rawMessage.swipes) ? (rawMessage.swipes as unknown[]) : null;
    if (!rawMessage || !swipes || swipes.length === 0) {
        throw new Error(`[ChatUI/adapter] No swipes to delete for message: ${mesId}`);
    }
    if (swipes.length <= 1) {
        throw new Error(`[ChatUI/adapter] Cannot delete the last swipe for message: ${mesId}`);
    }

    const normalizedSwipeId = Number(swipeId);
    if (!Number.isInteger(normalizedSwipeId) || normalizedSwipeId < 0 || normalizedSwipeId >= swipes.length) {
        throw new Error(`[ChatUI/adapter] Invalid swipe id ${swipeId} for message: ${mesId}`);
    }

    const currentSwipeId = Math.min(Math.max(Number(rawMessage.swipe_id ?? 0), 0), swipes.length - 1);

    swipes.splice(normalizedSwipeId, 1);
    const swipeInfo = rawMessage.swipe_info;
    if (Array.isArray(swipeInfo) && swipeInfo.length) {
        (swipeInfo as unknown[]).splice(normalizedSwipeId, 1);
    }

    let newSwipeId: number;
    if (normalizedSwipeId < currentSwipeId) {
        newSwipeId = currentSwipeId - 1;
    } else if (normalizedSwipeId > currentSwipeId) {
        newSwipeId = currentSwipeId;
    } else {
        // Select the next swipe, or the one before it if it was the last one.
        newSwipeId = Math.min(normalizedSwipeId, swipes.length - 1);
    }

    const ctx = getContext() as { chatMetadata?: { tainted?: boolean } };
    if (ctx.chatMetadata) ctx.chatMetadata.tainted = true;

    rawMessage.swipe_id = newSwipeId;

    await eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, {
        messageId: mesId,
        swipeId: normalizedSwipeId,
        newSwipeId,
    });

    if (normalizedSwipeId === currentSwipeId) {
        // The active swipe was removed — resync `mes` to the newly active
        // swipe's text ourselves. This is the exact job ST's own swipe()
        // would do via its own internal syncSwipeToMes() call, reached here
        // without ever entering swipe(): no DOM gate to bail on, no
        // swipeState to touch, let alone leave stuck.
        syncSwipeToMes(mesId);
    }

    await saveChatConditional();
}

/**
 * Depth-first search for the first descendant carrying `className`, walking
 * `.children` only (never a CSS selector engine). Used instead of
 * `element.querySelector('.mesIDDisplay')` because ST's `.mesIDDisplay` node
 * is nested two levels below `.mes` (`.mes > .mesAvatarWrapper >
 * .mesIDDisplay`, public/index.html's `#message_template`) and the unit-test
 * fake DOM (test/helpers/fake-st-host.mjs) only resolves `#id` through
 * `querySelector`/`querySelectorAll` — a plain tree walk works identically
 * against a real browser DOM and the fake one, so the renumber rule below can
 * be pinned by a real unit test instead of only by a browser repro.
 */
function _findDescendantByClass(root: Element, className: string): HTMLElement | null {
    for (const child of Array.from(root.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.classList.contains(className)) return child;
        const nested = _findDescendantByClass(child, className);
        if (nested) return nested;
    }
    return null;
}

/**
 * Owns the post-delete renumber outright instead of delegating to native
 * `updateViewMessageIds` (script.js:9407-9419). That function's `null`
 * startIndex branch falls back to `minId = getFirstDisplayedMessageId()`,
 * which re-scans the *current* DOM for its own minimum rendered `mesid`. Its
 * correctness silently assumes native `deleteMessage()`'s own precondition:
 * the deleted row's own `.mes` element was in the DOM and has *just* been
 * physically `.remove()`d (script.js:1633-1636 gates on exactly that before
 * ever reaching this code). Tier 2 deliberately breaks that precondition —
 * chat_truncation=1 means most deletions target a message whose row was
 * never rendered in the first place — so when `deletedId` itself was never
 * rendered while later rows are, nothing was removed from the DOM, the
 * re-scanned minimum is bytewise identical to before, and native's
 * recomputation becomes a silent no-op: every still-rendered row keeps the
 * `mesid` it already had, even though `chat.splice(deletedId, 1)` just
 * shifted every later index down by one. Empirically proved (real jQuery +
 * DOM, verbatim native `updateViewMessageIds`/`getFirstDisplayedMessageId`
 * bodies) by this fork's own review round in a scratch repro (not checked
 * into this repo — see the review notes for that round): deleted-unrendered
 * + later-rendered ("edit message 7" after deleting id 5 silently mutates
 * chat[7], which now holds former message 8's content), and
 * chat_truncation=1 (deleting an earlier unrendered id leaves the sole
 * rendered row's `mesid` pointing at an out-of-bounds `chat[]` slot). A
 * follow-up repro extended both cases with a side-by-side comparison against
 * *this* function's own rule for every configuration in this fork's test
 * matrix below.
 *
 * The correct rule is old-`mesid`-based, not DOM-position-based, and is
 * correct by construction for every rendered/unrendered combination because
 * it never re-derives a baseline from the DOM at all — it only compares each
 * currently-rendered row's own (still-stale) `mesid` attribute against the id
 * that was just spliced out of `chat[]`:
 *
 *   - a row whose `mesid` === `deletedId` no longer exists by the time this
 *     runs — its element was already `.remove()`d by the caller (mirroring
 *     native's `messageElement.remove()`, script.js:1654) if it was rendered
 *     at all;
 *   - a row with `mesid` > `deletedId` gets its `mesid` decremented by
 *     exactly one, because `chat.splice(deletedId, 1)` shifted that row's
 *     underlying chat[] entry down one slot too;
 *   - a row with `mesid` < `deletedId` is left untouched — its chat[] index
 *     never moved.
 *
 * Also reproduces every other per-row observable effect native
 * `updateViewMessageIds` produces on the same row set, in the same order:
 * the `.mesIDDisplay` text mirror, the `last_mes` class handoff to whichever
 * row is now last in DOM order, and a call to native `updateEditArrowClasses`
 * (script.js:9427) — delegated to native unmodified. That delegation is
 * provably safe, unlike `updateViewMessageIds`'s: `updateEditArrowClasses`
 * never re-derives an offset baseline from the DOM, it only compares
 * whatever the *real* native `this_edit_mes_id` happens to be (Tier 3:
 * ChatUI itself never writes that module-private variable at all anymore —
 * see `_deleteFullMessageById`'s doc comment for why — so in every
 * ChatUI-only session it stays permanently `undefined`) against whatever
 * `mesid` attributes are on the row set *right now* — which, by the time
 * this call happens, this function has already made correct. Safe either
 * way, because the safety property was never "the variable is kept in
 * sync", it was "this function never derives its own baseline from the DOM".
 *
 * `.mes` rows are always direct children of `#chat` (native only ever
 * `.append()`/`.prepend()`s them straight onto `chatElement = $('#chat')` —
 * script.js:1457/1481/1520/2530), so this walks `#chat`'s `.children`
 * directly rather than the compound CSS selector `getMessageElementById`
 * uses elsewhere in this file — the fake DOM used by this repo's unit-test
 * harness doesn't resolve compound selectors, but does support
 * getElementById/children/classList/attribute reads and writes, which is
 * exactly what this needs.
 */
function _renumberRenderedRowsAfterDelete(deletedId: number): void {
    const chatContainer = document.getElementById('chat');
    const rows = chatContainer
        ? Array.from(chatContainer.children).filter(
            (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('mes'),
        )
        : [];

    for (const row of rows) {
        const oldMesid = Number(row.getAttribute('mesid'));
        if (!Number.isFinite(oldMesid) || oldMesid <= deletedId) continue;
        const newMesid = oldMesid - 1;
        row.setAttribute('mesid', String(newMesid));
        const display = _findDescendantByClass(row, 'mesIDDisplay');
        if (display) display.textContent = `#${newMesid}`;
    }

    for (const row of rows) row.classList.remove('last_mes');
    rows[rows.length - 1]?.classList.add('last_mes');

    // Native always calls this at the end of updateViewMessageIds, even over
    // zero `.mes` rows (its own jQuery selections just degrade to no-ops) —
    // matched here unconditionally for the same reason.
    updateEditArrowClasses();
}

/**
 * Full-message delete thin fork of ST's own deleteMessage() (script.js:1618-
 * 1673, the body *after* its own DOM gate) — reimplemented directly against
 * the live host state instead of ever calling ST's exported deleteMessage()
 * at all. DOM-DECOUPLING.md Tier 2. Deliberately DOM-*tolerant*, not
 * DOM-gated like Tier 1's interim version: chat_truncation=1 only keeps the
 * chat's last message rendered, so an unrendered target (any non-last
 * message once that truncation is active, or any message before the native
 * window has ever mounted) must still delete correctly, not throw.
 *
 * Reproduces every observable side effect of the native post-gate body, in
 * the exact same order:
 *
 *  1. Look up `#chat .mes[mesid=id]`, if any (native's `messageElement`,
 *     captured before its own DOM gate, script.js:1632) — zero matches is
 *     fine here (unlike native, which gates on it); one match gets removed
 *     below.
 *  2. `chat.splice(id, 1)` against the live getContext().chat reference
 *     (script.js:1653) — same live-reference assumption Tier 1's
 *     _deleteSwipeById already relies on for its own splice.
 *  3. Remove the captured element, if it existed (script.js:1654).
 *  4. `chat_metadata.tainted = true` (script.js:1656).
 *  5. `deleteItemizedPromptForMessage(id)` (script.js:1659) — new @st/*
 *     mapping (public/scripts/itemized-prompts.js, the same up-3 pattern as
 *     @st/utils; see scripts/build.mjs/check-runtime.mjs/st-externals.d.ts/
 *     test/helpers/fake-st-host.mjs). DOM-free pure array filter+reindex,
 *     verified against the pinned checkout — not reachable via getContext()
 *     or any already-mapped @st/* module.
 *  6. `_renumberRenderedRowsAfterDelete(id)` in place of native
 *     `updateViewMessageIds(startIndex)` (script.js:1660-1661) — see that
 *     function's own doc comment for why this fork owns the renumber outright
 *     instead of delegating to native's DOM-self-recomputing version.
 *  7. `saveChatDebounced()` (script.js:1661) — note this is the *debounced*
 *     save, not saveChatConditional(): native's own deleteMessage() uses this
 *     one specifically. (_deleteSwipeById's mini-fork above correctly uses
 *     the *conditional* save instead, matching deleteSwipe()'s own choice —
 *     these are deliberately different saves for deliberately different ST
 *     functions.)
 *  8. this_edit_mes_id reset (script.js:1663-1665) — **not reproduced as of
 *     Tier 3** (2026-07-19). Through Tier 2, this called the exported
 *     `setEditedMessageId(undefined)` (script.js:7101) whenever a module-
 *     private `_shadowEditedMessageId` mirror equalled the deleted id, since
 *     saveMessageEditById() back then drove native's real editor and was the
 *     only ChatUI path that ever set the real (getter-less)
 *     `this_edit_mes_id`. Tier 3 forked saveMessageEditById into a DOM-free
 *     reimplementation that never opens a native edit session at all (see
 *     its own doc comment) — so there is no longer any ChatUI-reachable path
 *     that sets the real `this_edit_mes_id` to begin with, and the shadow
 *     variable (along with this reset) was removed rather than kept around
 *     as a permanently-false, misleading guard. The residual gap this
 *     leaves is a user bypassing ChatUI's shield to open a *native* edit
 *     session directly, then deleting that same message through ChatUI:
 *     native's real `this_edit_mes_id` would dangle at the deleted id.
 *     Already out of scope pre-Tier-3 too — the shadow could never observe a
 *     shield-bypass write in the first place, so this was never actually
 *     covered; Tier 3 removes a mechanism that only pretended to, it does
 *     not newly break anything that worked. An unconditional
 *     `setEditedMessageId(undefined)` call here would be *unsafe*, not just
 *     redundant: without a getter there is no way to check whether the real
 *     variable currently points at *this* id or an unrelated one, and
 *     resetting unconditionally could stomp a legitimate, unrelated
 *     shield-bypass edit session on a different, still-existing message.
 *  9. `refreshSwipeButtons()` (script.js:1667) — DOM-tolerant (bails out on
 *     an empty chat; its own internal jQuery selection degrades to zero
 *     iterations when nothing is rendered, verified against the pinned
 *     checkout).
 * 10. `eventSource.emit(MESSAGE_DELETED, chat.length)` (script.js:1669) —
 *     `chat.length` read *after* the splice, matching native exactly.
 */
async function _deleteFullMessageById(id: number): Promise<void> {
    const mesEl = getMessageElementById(id);

    const chat = getCurrentChat();
    chat.splice(id, 1);
    mesEl?.remove();

    const ctx = getContext() as { chatMetadata?: { tainted?: boolean } };
    if (ctx.chatMetadata) ctx.chatMetadata.tainted = true;

    deleteItemizedPromptForMessage(id);
    _renumberRenderedRowsAfterDelete(id);
    saveChatDebounced();

    refreshSwipeButtons();

    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
}

export type DeleteEligibility = Readonly<{
    /** True exactly when ST's own `.mes_edit_delete` handler's structural
     * eligibility check would allow a swipe-only delete (script.js:11922-
     * 11928) — everything *except* the confirm_message_delete gate, which is
     * the caller's job to combine with the user's actual dialog choice (see
     * getConfirmMessageDeleteSetting below and store/chat-actions.ts). */
    canDeleteSwipe: boolean;
    /** The message's currently-selected swipe id, present only when
     * canDeleteSwipe is true. */
    swipeId: number | undefined;
}>;

/**
 * Structural delete eligibility for one message: is it a non-user message
 * with more than one swipe, is it the chat's last message, and does it have
 * a selected swipe. Mirrors ST's own `.mes_edit_delete` handler
 * (script.js:11922-11928) minus the confirm_message_delete gate — the
 * adapter must never assume whether the user wants to be asked; that is
 * store/chat-actions.ts's job, reading getConfirmMessageDeleteSetting()
 * separately and deciding the three-way-vs-two-way confirm UI from both
 * pieces together.
 */
export function getDeleteEligibility(mesId: MessageId): DeleteEligibility {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for delete: ${mesId}`);
    }
    const message = parseMessageRecord(getMessageById(normalizedId));
    if (!message) {
        throw new Error(`[ChatUI/adapter] Message record not found for delete: ${normalizedId}`);
    }
    const isLast = normalizedId === arrayLength(getCurrentChat()) - 1;
    const canDeleteSwipe = !message.is_user
        && message.swipes.length > 1
        && isLast
        && message.swipe_id !== undefined;
    return { canDeleteSwipe, swipeId: canDeleteSwipe ? message.swipe_id : undefined };
}

/**
 * Read-only view of `power_user.confirm_message_delete`, coerced to a strict
 * boolean (never forwarded as whatever raw settings value ST happens to
 * store). The adapter never decides UI from this itself — it only reports
 * it; store/chat-actions.ts is the sole reader (DOM-DECOUPLING.md decision
 * #3's Tier 2 resolution: orchestration lives in the store, the adapter
 * never shows UI).
 */
export function getConfirmMessageDeleteSetting(): boolean {
    return !!(getContext() as DeleteSettingsContext).powerUserSettings?.confirm_message_delete;
}

/**
 * Intent-explicit delete execution: the caller (store/chat-actions.ts) has
 * already decided — from getDeleteEligibility() + getConfirmMessageDeleteSetting()
 * plus, when applicable, the user's own confirm-dialog choice — exactly which
 * mutation to perform. This function never reads settings, never shows any
 * UI, and never asks anything; it only executes. `swipeId` is required (and
 * revalidated by _deleteSwipeById's own guards, protecting against staleness
 * between when eligibility was read and when the user actually confirmed)
 * when intent === 'swipe'.
 */
export async function deleteMessageWithIntent(
    mesId: MessageId,
    intent: DeleteIntent,
    swipeId?: number,
): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for delete: ${mesId}`);
    }
    if (intent === 'swipe') {
        if (swipeId === undefined) {
            throw new Error(`[ChatUI/adapter] Swipe id required for swipe-only delete: ${normalizedId}`);
        }
        await _deleteSwipeById(normalizedId, swipeId);
        return;
    }
    await _deleteFullMessageById(normalizedId);
}

export async function swipeMessage(mesEl: Element, direction: SwipeDirection): Promise<void> {
    const mesId = _getMessageId(mesEl);
    if (!Number.isInteger(mesId) || mesId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for swipe: ${mesId}`);
    }
    const rawMessage = getMessageById(mesId);
    if (!parseMessageRecord(rawMessage)) {
        throw new Error(`[ChatUI/adapter] Message record not found for swipe: ${mesId}`);
    }
    // Call ST's exported swipe() with forceMesId (it tolerates a null event when
    // forceMesId is a number) instead of clicking the off-screen .swipe_left /
    // .swipe_right buttons. direction 'left'|'right' matches ST's SWIPE_DIRECTION.
    await stSwipe(null, direction, { forceMesId: mesId, message: rawMessage });
}

/**
 * DOM-DECOUPLING.md: copySource / branch / checkpoint / hide never require a
 * live `.mes` node (Tier 1) — the blanket getMessageElementById gate that used
 * to guard every action here is gone for exactly those. The plain 「复制」 is
 * not dispatched through here at all: it needs the formatted HTML the row
 * actually rendered from, which only the store holds, so it is orchestrated
 * there (store/chat-actions.ts) against `copyMessageAsPlainText` directly —
 * same shape `delete` already uses, for the same reason (this dispatcher
 * takes an id and nothing else). `delete` is no longer
 * dispatched through this generic entry point at all as of Tier 2: it needs
 * to read confirm_message_delete and (conditionally) await a ChatUI-owned
 * confirm dialog *before* deciding which mutation to run, which this
 * dispatcher's synchronous-switch shape can't accommodate — see
 * store/chat-actions.ts's dedicated delete orchestration, which calls
 * getDeleteEligibility() / getConfirmMessageDeleteSetting() /
 * deleteMessageWithIntent() directly instead. `edit` is no longer dispatched
 * through here either as of Tier 3, and was never actually reachable through
 * it in the first place — ChatUI's own "enter edit mode" has always been
 * local Preact state (see the removed-code note above `saveMessageEditById`)
 * — so its DOM gate is gone along with the case itself; an `'edit'` string
 * reaching this function at runtime (not TypeScript-representable — `MessageAction`
 * no longer includes it — but nothing stops a raw string at the compiled-JS
 * boundary) falls through to the same safe `default: return;` `'delete'`
 * already uses. `regen` still resolves and requires the live element
 * explicitly right here — this tier leaves it untouched, it is a
 * generation-menu path, not an edit/delete concern — see DOM-DECOUPLING.md
 * §「推进顺序」for what stays DOM-gated and why.
 */
export async function triggerMessageActionById(mesId: MessageId, action: MessageAction): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for ${action}: ${mesId}`);
    }

    switch (action) {
        case 'copySource': await copyMessageSource(normalizedId);  return;
        case 'branch':     await createBranch(normalizedId);      return;
        case 'checkpoint': await createCheckpoint(normalizedId);  return;
        case 'hide':       await toggleHideMessage(normalizedId); return;
        case 'regen': {
            const mesEl = getMessageElementById(normalizedId);
            if (!mesEl) {
                throw new Error(`[ChatUI/adapter] Message element not found for ${action}: ${normalizedId}`);
            }
            regenerateMessage();
            return;
        }
        default:
            return;
    }
}

export async function swipeMessageById(mesId: MessageId, direction: SwipeDirection): Promise<void> {
    const normalizedId = Number(mesId);
    if (!Number.isInteger(normalizedId) || normalizedId < 0) {
        throw new Error(`[ChatUI/adapter] Invalid message id for swipe: ${mesId}`);
    }
    const mesEl = getMessageElementById(normalizedId);
    if (!mesEl) {
        throw new Error(`[ChatUI/adapter] Message element not found for swipe: ${normalizedId}`);
    }
    await swipeMessage(mesEl, direction);
}
