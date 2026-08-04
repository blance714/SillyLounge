/**
 * SillyTavern-ChatUI · 未落笔的对话 blank conversation
 *
 * Whether a conversation in the playbill is one nobody has written in yet —
 * the only thing the dashed card says (DESIGN §4.2). Presentation only: a
 * blank conversation is an ordinary conversation in every other respect. It is
 * listed, opened, renamed and deleted like any other, nothing withholds it,
 * and nothing limits how many may exist. That is the whole difference between
 * this and the 「未完成草稿」 tier retired on 2026-08-02, which was a *lease*
 * deciding what the reader was allowed to see.
 *
 * ## Why the rule is shaped like this
 *
 * ST's conversation listing does not say who wrote a message. Both endpoints
 * that back the playbill (`/api/characters/chats` and `/api/chats/search`,
 * via `getChatInfo` in src/endpoints/chats.js) report a message *count*, the
 * last message's text, a timestamp and a file size — and nothing else. So
 * 「the only message is the character's」 cannot be read off the listing
 * directly. Answering it exactly would mean opening every chat file on every
 * playbill render, which is a request per conversation for a border style.
 *
 * It can be derived instead, because ST seeds a new chat from exactly one
 * place (script.js's getChatResult):
 *
 *     if (chat.length === 0) {
 *         const message = getFirstMessage();      // first_mes, or the first
 *         if (message.mes) chat.push(message);    // non-empty alternate
 *     }
 *
 * A character with a greeting therefore *always* starts a chat at one
 * character message, so a one-message chat of theirs is that greeting and
 * nothing else — the reader's own first line would make it two. A character
 * with no greeting starts at zero, so a one-message chat of theirs is the
 * reader's line. Both branches are exact, and both are answered from data the
 * page already holds.
 *
 * 「Has a greeting」 means precisely what `getFirstMessage()` does with the
 * character record, down to its truthiness tests and its blind use of the
 * first alternate greeting; adapter/chats/queries.ts's `characterHasGreeting`
 * mirrors it and says why each of those details changes the answer.
 *
 * Two states fool it, both accepted rather than paid for with a request per
 * row:
 *
 * - Delete the greeting out of a chat by hand, write exactly one line, and
 *   never get a reply. Reachable only deliberately, and it costs a border
 *   style until the reply lands.
 * - Run a regex script with AI_OUTPUT placement that empties the greeting.
 *   `getFirstMessage()` passes the greeting through `getRegexedString()` before
 *   `getChatResult()` decides whether to push it, so such a character seeds
 *   nothing while its record still carries the greeting. Nothing readable from
 *   the character card can tell us that, and running the scripts here to find
 *   out is exactly the non-deterministic-macro problem that made 「复制」
 *   reduce cached HTML instead of re-invoking the formatter.
 *
 * `hasGreeting` itself is computed where ST's raw character record is read
 * (adapter/chats/queries.ts, beside `chat_size`), because what a host field
 * means is the adapter's question; what a card looks like is this layer's.
 *
 * `import type` only — this module compiles to a standalone, dependency-free
 * entry under `dist/runtime/ui/`, so the rule can be pinned by a Node test
 * without a renderer (the same reason spine-cast.ts lives on its own).
 */

export type BlankConversationInput = {
    /**
     * Messages ST's listing counted in the file, or null when it did not say.
     *
     * The adapter passes the absence through rather than filling it in
     * (adapter/chats/state.ts's ChatListItemDto), because the dashed border is
     * an assertion about a file and 「no count」 is not evidence for it — while
     * `0`, the obvious stand-in, is the *strongest* evidence for it.
     */
    messageCount: number | null;
    /** Whether ST would seed a new chat for this character with a greeting. */
    hasGreeting: boolean;
};

/** True when nobody has written in this conversation yet. */
export function isBlankConversation({ messageCount, hasGreeting }: BlankConversationInput): boolean {
    if (messageCount === null || !Number.isFinite(messageCount) || messageCount < 0) return false;
    if (messageCount === 0) return true;
    return messageCount === 1 && hasGreeting;
}
