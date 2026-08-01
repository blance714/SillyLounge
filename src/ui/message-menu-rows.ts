/**
 * SillyTavern-ChatUI · what the message ⋯ menu carries
 *
 * The overflow rows of a message's action bar (design §45's 复制 / 复制原文 /
 * 从此楼开分支 / 在此楼设检查点 / — / 隐藏此楼), as data rather than JSX.
 *
 * They live out here because two components now need the same answer and must
 * never disagree about it: the row draws the ⋯ *trigger*
 * (components/message/MessageActions.tsx), while the menu itself is drawn by a
 * host at the app root (components/message/MessageMenuHost.tsx) so it can
 * outlive the virtualised row. If each derived its own list, a menu could
 * open under a trigger whose row believes the menu is empty — or, worse, a
 * trigger could exist for a menu with nothing in it.
 *
 * Each row names a `ChatuiAction` instead of carrying a closure, which is what
 * lets the list cross that gap at all: the host dispatches
 * `triggerChatuiMessageAction(messageId, action, chatKey)` from the anchor the
 * store handed it, with no reference back into the row that is no longer
 * guaranteed to be mounted.
 *
 * `import type` only — this module compiles to a standalone, dependency-free
 * entry under `dist/runtime/ui/` so the row order can be pinned by a Node test.
 */

import type { ChatuiAction } from './types.js';

export type MessageMenuRow = Readonly<{
    label: string;
    iconClass: string;
    action: ChatuiAction;
    /** Destructive rows are written in cinnabar on the paper surface (design §8). */
    danger?: boolean;
    /** Design §45 rules a line off before the destructive row. */
    separatorBefore?: boolean;
}>;

const COPY: MessageMenuRow = { label: '复制', iconClass: 'fa-solid fa-copy', action: 'copy' };
const COPY_SOURCE: MessageMenuRow = { label: '复制原文', iconClass: 'fa-solid fa-clipboard', action: 'copySource' };
const BRANCH: MessageMenuRow = { label: '从此楼开分支', iconClass: 'fa-solid fa-code-branch', action: 'branch' };
const CHECKPOINT: MessageMenuRow = { label: '在此楼设检查点', iconClass: 'fa-solid fa-flag-checkered', action: 'checkpoint' };
const HIDE: MessageMenuRow = {
    label: '隐藏此楼',
    iconClass: 'fa-solid fa-eye-slash',
    action: 'hide',
    danger: true,
    separatorBefore: true,
};

/**
 * Design §42/§45 split the action bar by *kind of act*, not by who spoke: the
 * tiled buttons are what you do **to** this turn, this menu is what you do
 * **with** it — take it somewhere else, or take it out of the conversation.
 * 隐藏此楼 sits below a rule because it is the only row that changes what the
 * model is told.
 *
 * A system row is not a turn anyone speaks: nothing may be branched from it or
 * hidden on its behalf, but its text is still text the reader may want.
 */
export function buildMessageMenuRows(isSystem: boolean): MessageMenuRow[] {
    if (isSystem) return [COPY, COPY_SOURCE];
    return [COPY, COPY_SOURCE, BRANCH, CHECKPOINT, HIDE];
}

/** How many separators `rows` draws — the second input the height estimate needs. */
export function countMessageMenuSeparators(rows: readonly MessageMenuRow[]): number {
    return rows.filter(row => row.separatorBefore).length;
}
