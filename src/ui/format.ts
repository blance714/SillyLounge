/**
 * ST's own `humanizedDateTime()` shape (RossAscends-mods.js):
 * `YYYY-M-D@HHhMMmSSsMSms`, built from local-time getters and zero-padded.
 * Chats written before ST moved to ISO still carry it, and `Date` cannot parse
 * it at all — hence the explicit reader rather than a parse attempt.
 */
const ST_HUMANIZED_SEND_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms$/;

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

    const humanized = ST_HUMANIZED_SEND_DATE.exec(trimmed);
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
export function formatConversationMeta(messageCount: number, timeLabel: string): string {
    const count = Number.isFinite(messageCount) && messageCount > 0 ? `${messageCount} 条` : '';
    const time = typeof timeLabel === 'string' ? timeLabel.trim() : '';
    return [count, time].filter(Boolean).join(' · ');
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
