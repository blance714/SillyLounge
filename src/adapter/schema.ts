import { z } from 'zod/mini';

export const UnknownRecordSchema = z.catchall(z.object({}), z.unknown());
export type UnknownRecord = z.infer<typeof UnknownRecordSchema>;

const StringFieldSchema = z.catch(z.string(), '');
const OptionalStrictNumberFieldSchema = z.catch(z.optional(z.number()), undefined);
const BooleanFieldSchema = z.catch(z.boolean(), false);
const RecordFieldSchema = z.catch(UnknownRecordSchema, () => ({}));
const StringArrayFieldSchema = z.catch(z.array(z.string()), () => []);
const LastMessageFieldSchema = z.catch(z.optional(z.union([z.string(), z.number()])), undefined);
const FiniteNumberFieldSchema = z.catch(
    z.pipe(
        z.transform((value: unknown) => Number(value)),
        z.number(),
    ),
    0,
);

const FavoriteFieldSchema = z.transform((value: unknown) => value === true || value === 'true');

export const StCharacterSchema = z.catchall(z.object({
    avatar: StringFieldSchema,
    name: StringFieldSchema,
    chat: StringFieldSchema,
    chat_size: FiniteNumberFieldSchema,
    date_last_chat: FiniteNumberFieldSchema,
    fav: FavoriteFieldSchema,
}), z.unknown());
export type StCharacter = z.infer<typeof StCharacterSchema>;

export const StChatRowSchema = z.catchall(z.object({
    avatar: StringFieldSchema,
    group: StringFieldSchema,
    file_name: StringFieldSchema,
    file_id: StringFieldSchema,
    preview_message: StringFieldSchema,
    mes: StringFieldSchema,
    message_count: OptionalStrictNumberFieldSchema,
    chat_items: OptionalStrictNumberFieldSchema,
    file_size: StringFieldSchema,
    last_mes: LastMessageFieldSchema,
}), z.unknown());
export type StChatRow = z.infer<typeof StChatRowSchema>;

export const StMessageSchema = z.catchall(z.object({
    mes: StringFieldSchema,
    swipes: StringArrayFieldSchema,
    swipe_id: OptionalStrictNumberFieldSchema,
    is_system: BooleanFieldSchema,
    is_user: BooleanFieldSchema,
    extra: RecordFieldSchema,
}), z.unknown());
export type StMessageRecord = z.infer<typeof StMessageSchema>;

/**
 * Immutable, fully-normalized view of one live ST message. Raw host records
 * stop at the adapter boundary; store/UI code can consume this shape without
 * knowing ST's optional/catch-all field conventions.
 */
export type MessageSnapshotDto = Readonly<{
    id: number;
    name: string;
    text: string;
    isSystem: boolean;
    isUser: boolean;
    sendDate: string | number | null;
    forceAvatar: boolean;
    forceAvatarSrc: string;
    swipeId: number;
    swipeCount: number;
    displayText: string;
    usesSystemUi: boolean;
    type: string;
    isSmallSys: boolean;
    isToolCall: boolean;
    bookmarkLink: string;
    tokenCount: number | null;
    reasoning: string;
    reasoningDisplayText: string;
    reasoningDuration: string | number | null;
}>;

export function parseRecord(value: unknown): UnknownRecord {
    const parsed = UnknownRecordSchema.safeParse(value);
    return parsed.success ? parsed.data : {};
}

export function parseOptionalRecord(value: unknown): UnknownRecord | null {
    const parsed = UnknownRecordSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function parseRecordArray(value: unknown): UnknownRecord[] {
    const parsed = z.array(z.unknown()).safeParse(value);
    if (!parsed.success) return [];
    return parsed.data.flatMap(item => {
        const record = parseOptionalRecord(item);
        return record ? [record] : [];
    });
}

export function parseCharacters(value: unknown): StCharacter[] {
    const parsed = z.array(z.unknown()).safeParse(value);
    if (!parsed.success) return [];
    return parsed.data.map(item => {
        const character = StCharacterSchema.safeParse(item);
        return character.success ? character.data : StCharacterSchema.parse({});
    });
}

export function parseChatRows(value: unknown): StChatRow[] {
    const parsed = z.array(z.unknown()).safeParse(value);
    if (!parsed.success) return [];
    return parsed.data.flatMap(item => {
        const row = StChatRowSchema.safeParse(item);
        return row.success ? [row.data] : [];
    });
}

export function parseMessageRecord(value: unknown): StMessageRecord | null {
    const parsed = StMessageSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function stringOrNumberOrNull(value: unknown): string | number | null {
    if (typeof value === 'string') return value;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Pure raw-host -> boundary DTO projector. Deliberately returns a placeholder
 * for a malformed array slot so message ids remain aligned with ST's indexes.
 * Exported for contract tests without requiring a live SillyTavern runtime.
 */
export function projectMessageSnapshot(value: unknown, id: number): MessageSnapshotDto {
    const message = parseMessageRecord(value) ?? StMessageSchema.parse({});
    const extra = message.extra;

    return Object.freeze({
        id,
        name: stringValue(message.name),
        text: message.mes,
        isSystem: message.is_system,
        isUser: message.is_user,
        sendDate: stringOrNumberOrNull(message.send_date),
        forceAvatar: Boolean(message.force_avatar),
        forceAvatarSrc: stringValue(message.force_avatar),
        swipeId: message.swipe_id ?? 0,
        swipeCount: message.swipes.length,
        displayText: stringValue(extra.display_text) || message.mes,
        usesSystemUi: extra.uses_system_ui === true,
        type: stringValue(extra.type),
        isSmallSys: extra.isSmallSys === true,
        isToolCall: Array.isArray(extra.tool_invocations),
        bookmarkLink: stringValue(extra.bookmark_link),
        tokenCount: numberOrNull(extra.token_count),
        reasoning: stringValue(extra.reasoning),
        reasoningDisplayText: stringValue(extra.reasoning_display_text),
        reasoningDuration: stringOrNumberOrNull(extra.reasoning_duration),
    });
}

export function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
