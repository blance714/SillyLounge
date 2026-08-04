/**
 * ST's own `humanizedDateTime()` shape (RossAscends-mods.js):
 * `YYYY-M-D@HHhMMmSSsMSms`, built from local-time getters and zero-padded.
 *
 * Two unrelated-looking features read it, which is why it lives in one place.
 * Chats written before ST moved to ISO carry it in `send_date`, and `Date`
 * cannot parse it at all — hence the explicit reader rather than a parse
 * attempt. And every chat ST names for itself is built from the same call:
 * `${character.name} - ${humanizedDateTime()}` for a character chat
 * (script.js), a bare `humanizedDateTime()` for a group one (group-chats.js).
 * So this pattern is also the only reliable way to tell a name the reader
 * chose from a name the host generated — see resolveConversationTitle.
 */
const ST_HUMANIZED_STAMP = /^(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms$/;

/**
 * Every shape ST has ever put in `send_date`, resolved to one instant.
 *
 * Modern messages carry ISO 8601 (`getMessageTimeStamp()` is
 * `Date#toISOString`), older ones carry `humanizedDateTime()`, and a few
 * import paths carry epoch milliseconds as a number or as a numeric string.
 * Returns null — never a guess — for anything else.
 */
function parseSendDate(value: string | number): Date | null {
    const finite = (date: Date): Date | null => (Number.isNaN(date.getTime()) ? null : date);

    if (typeof value === 'number') return finite(new Date(value));

    const trimmed = value.trim();
    if (trimmed === '') return null;
    // Epoch milliseconds handed over as text: `new Date(string)` would try to
    // read the digits as a date rather than as an offset, so convert first.
    if (!Number.isNaN(Number(trimmed))) return finite(new Date(Number(trimmed)));

    const humanized = ST_HUMANIZED_STAMP.exec(trimmed);
    if (humanized) {
        const [, year, month, day, hour, minute, second, millisecond] = humanized;
        // Read back as local time, because that is how humanizedDateTime()
        // wrote it; parsing it as UTC would shift every legacy stamp by the
        // reader's own offset.
        return finite(new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second),
            Number(millisecond),
        ));
    }

    return finite(new Date(trimmed));
}

/**
 * The message header's 「第 N 楼 · 时间」 stamp (design §4) — a clock time, not
 * a date string.
 *
 * This used to hand back any non-numeric string verbatim, which meant a modern
 * ST chat printed the whole ISO stamp (`2026-01-04T00:00:02.000Z`) in the
 * header. That was invisible while solo chats defaulted to no header at all;
 * the corridor-theater pass turns the header on by default, so the shortcut had
 * to go rather than be styled around. Verbatim survives only as the last
 * resort, for a stamp no known ST format explains: showing data we cannot read
 * is honest, inventing a time for it would not be.
 */
export function formatTimestamp(value: string | number | null): string {
    if (value === null || value === '') return '';

    const date = parseSendDate(value);
    if (!date) return String(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Reasoning durations, in the language the rest of the UI speaks. */
export function formatDuration(duration: string | number | null): string {
    const ms = Number(duration);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} 秒`;
}

/**
 * The playbill card's 9px meta line (DESIGN §4.2 / README §1).
 *
 * The design writes this line as 「N 楼 · 时间」, and this deliberately says
 * 「N 条」instead. 楼 has one meaning in this app — a user turn, the same number
 * the floor rail and the message header count (DESIGN §4.3) — and the only
 * quantity a chat listing carries is ST's `chat_items`, the raw line count of
 * the .jsonl. Printing that as 楼 would put "40 楼" on a card whose rail tops
 * out at 20. Deriving real floors would mean reading every chat file just to
 * draw the sidebar, which is the one thing a list query must not do. So the
 * card prints the number it actually has, under the name that number has.
 *
 * Either half may be missing (a chat with no readable timestamp, a draft whose
 * listing row has not arrived), and neither placeholder is invented: an absent
 * half drops itself and the separator with it.
 */
export function formatConversationMeta(messageCount: number | null, timeLabel: string): string {
    const count = messageCount !== null && Number.isFinite(messageCount) && messageCount > 0
        ? `${messageCount} 条`
        : '';
    const time = typeof timeLabel === 'string' ? timeLabel.trim() : '';
    return [count, time].filter(Boolean).join(' · ');
}

const HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
});

/**
 * The playbill card's preview line, as prose rather than as source
 * (ROADMAP B2).
 *
 * ST's listing hands over the last message's *stored* text — markdown, HTML,
 * whatever the model wrote — and the card printed it verbatim, so `**粗体**`,
 * `<div>` and fence backticks all showed up as themselves on a line that is
 * meant to read like a sentence.
 *
 * The reduction has to be a pure function over that string. Calling ST's own
 * `messageFormatting()` is not available to this path and would be wrong even
 * if it were: every call re-evaluates non-deterministic macros, which is the
 * same reason 「复制」 reduces already-rendered HTML instead of re-running the
 * formatter (pr5). The sidebar has no rendered copy to reduce, so this reads
 * the source and removes what is unambiguously markup.
 *
 * Three properties of the input shape the rules, and the first two are easy to
 * forget:
 *
 * - **It is a tail, not a head.** `getPreviewMessage()` (ST's
 *   src/endpoints/chats.js) keeps the last 400 characters and prefixes `...`
 *   when it cut. So the string routinely begins mid-syntax: an opening `**`
 *   with no closer in view, a `<div>` whose tag was cut in half. Anything that
 *   only handles balanced pairs leaves debris exactly where the reader looks
 *   first.
 * - **It is one line on screen.** The card clamps to a single line with an
 *   ellipsis, so every newline has to become a space rather than disappear —
 *   otherwise two sentences fuse into one word.
 * - **Not every delimiter is markup.** `snake_case_names`, `2 * 3` and
 *   `5 < 7` are prose. `_` is therefore only stripped as a matched pair at
 *   word boundaries, and a lone one is left where it is; `**` and `~~` have no
 *   plausible literal reading and go unconditionally.
 *
 * Table pipes are deliberately left alone. A row like `| a | b |` reads
 * awkwardly on a card, but `|` is an ordinary character in prose and a rule
 * that removed it would be the one kind of mistake this function must not make
 * — eating something the writer meant.
 */
export function toPlainConversationPreview(preview: string): string {
    if (typeof preview !== 'string' || preview === '') return '';

    return preview
        // Fences first: their info string (```js) is not prose, and the code
        // inside them is still what was said.
        .replace(/^[ \t]*(?:```|~~~).*$/gm, ' ')
        // Tags before entities, so a decoded `&lt;` can never become one.
        .replace(/<\/?[A-Za-z][^>]*>/g, '')
        // A tag the 400-character cut severed: `class="mes">…` left at the
        // head, `…<spa` left at the tail. Both rules demand evidence that the
        // fragment really is tag innards, because the naive versions — strip
        // to the first `>`, strip from the last `<` — eat 「他说 5 > 3」 and
        // 「他说 5 < 7」 whole. The head needs an attribute assignment before
        // its `>`; the tail needs a tag name right after its `<`.
        .replace(/^[^<>]*=\s*["'][^<>]*>/, '')
        .replace(/<\/?[A-Za-z][^<>]*$/, '')
        .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (whole, name: string) => HTML_ENTITIES[name] ?? whole)
        // Line-leading structure. Blockquotes nest, so the marker repeats.
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
        .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ')
        // Images before links: `![alt](src)` is a link whose text is the alt.
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`+/g, '')
        .replace(/~~/g, '')
        .replace(/\*\*/g, '')
        // A single `*` only where emphasis can open or close: after a
        // boundary and before a non-space, or after a non-space and before a
        // boundary. Written as negated classes rather than a list of
        // punctuation, because the list would have to know 。、！ and the rest
        // of CJK — the first draft stopped at ASCII and left the closer
        // standing in 「*再见*。」. `2 * 3` keeps its asterisk either way: both
        // rules need a non-space on the inner side.
        .replace(/(^|[^\w*])\*(?=[^\s*])/g, '$1')
        .replace(/([^\s*])\*(?=$|[^\w*])/g, '$1')
        // `_` only as a matched pair around a run with no underscore in it,
        // and only at word boundaries — `snake_case` is not emphasis.
        .replace(/(^|[^\w`])_([^_\n]+)_(?=$|[^\w`])/g, '$1$2')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Drop the 「角色名 - 」 that ST puts in front of every chat it names itself.
 *
 * ST builds a new character chat's name as `${character.name} - ${stamp}`
 * (script.js). Wherever the character's own name is already on screen next to
 * the chat's — the playbill column is titled with it, the topbar's eyebrow
 * carries it — repeating it inside the chat's name is not information, it is
 * the same word twice, and it pushes the part that actually distinguishes one
 * chat from another out past the ellipsis.
 *
 * Only an exact `${characterName} - ` prefix is dropped, and only when there is
 * a character name to match: a chat the reader named 「走廊 - 第二夜」 keeps
 * every character of it. Groups pass their group name here, which is what
 * `getCurrentChatDetails().characterName` holds for them.
 */
export function stripChatNameCharacterPrefix({ chatName, characterName }: {
    chatName: string;
    characterName: string;
}): string {
    if (characterName === '') return chatName;
    const prefix = `${characterName} - `;
    return chatName.startsWith(prefix) ? chatName.slice(prefix.length) : chatName;
}

/**
 * The topbar's page title (DESIGN §4.1): the conversation's own name, falling
 * back when it does not have one.
 *
 * The fallback chain 「会话名 → 角色名 → ChatUI」 was already here and provably
 * worked — but it was written as `sessionName || characterName`, and ST's
 * `sessionName` is never empty. A brand-new chat therefore printed its raw
 * host filename, 「Lounge Test Character - 2026-08-01@01h25m42s735ms」, which is
 * both an implementation detail leaking onto the title page and a verbatim
 * repeat of the eyebrow directly above it — the one thing §4.1 rules out
 * without qualification (「同时避免重复题名」).
 *
 * So the guard is not「是否为空」but「这名字是宿主起的还是读者起的」. Strip the
 * repeated character name, and if what is left is a bare `humanizedDateTime()`
 * stamp (or nothing at all), ST named this chat, not the reader — take the
 * fallback. Anything else is a name someone chose and is shown as chosen.
 *
 * The eyebrow's own 「characterName !== title」 guard then does the rest: when
 * this falls back to the character's name, the eyebrow steps aside to
 * 「对话手记」 rather than printing it twice. The two rules are one mechanism.
 */
export function resolveConversationTitle({ sessionName, characterName }: {
    sessionName: string;
    characterName: string;
}): string {
    // Strip against the host's literal string, then trim: the prefix ST writes
    // ends in a space, so trimming first would stop 「角色名 - 」 (a name that is
    // nothing but the repeat) from matching and let it through as a title.
    const cast = characterName.trim();
    const own = stripChatNameCharacterPrefix({ chatName: sessionName, characterName: cast }).trim();
    if (own !== '' && !ST_HUMANIZED_STAMP.test(own)) return own;
    return cast || 'ChatUI';
}

export function formatBytes(value: number | null): string {
    if (value === null || value < 0) return '';

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    const precision = unitIndex === 0 || size >= 10 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
}
