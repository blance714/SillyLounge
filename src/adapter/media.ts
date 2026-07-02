/**
 * SillyTavern-ChatUI · media adapter
 */

import { _dispatchClick, getMessageElementById } from './internals.js';
import {
    type UnknownRecord,
    numberOrNull,
    parseMessageRecord,
    parseOptionalRecord,
    parseRecordArray,
    stringValue,
} from './schema.js';

export type MediaAttachmentDto = {
    id: string;
    type: string;
    url: string;
    title: string;
    source: string;
    index: number;
};

export type FileAttachmentDto = {
    id: string;
    name: string;
    url: string;
    size: number | null;
    type: string;
    index: number;
};

export type MessageAttachmentsDto = {
    display: string;
    inline: boolean;
    mediaIndex: number;
    media: MediaAttachmentDto[];
    files: FileAttachmentDto[];
};

function toMediaDto(attachment: UnknownRecord, index: number): MediaAttachmentDto {
    const type = stringValue(attachment.type) || 'image';
    const url = stringValue(attachment.url);
    const title = stringValue(attachment.title) || stringValue(attachment.name) || url.split('/').pop() || type;

    return {
        id: `${index}:${type}:${url}`,
        type,
        url,
        title,
        source: stringValue(attachment.source),
        index,
    };
}

function toFileDto(file: UnknownRecord, index: number): FileAttachmentDto {
    const url = stringValue(file.url);
    const name = stringValue(file.name) || url.split('/').pop() || 'Attachment';

    return {
        id: `${index}:${name}:${url}`,
        name,
        url,
        size: numberOrNull(file.size),
        type: stringValue(file.type),
        index,
    };
}

export function getMessageAttachments(rawMessage: unknown): MessageAttachmentsDto {
    const message = parseMessageRecord(rawMessage);
    const extra = message?.extra ?? {};
    const media = Array.isArray(extra.media)
        ? parseRecordArray(extra.media)
        : [
            ...(stringValue(extra.image) ? [{ type: 'image', url: stringValue(extra.image), title: stringValue(extra.title) }] : []),
            ...(stringValue(extra.video) ? [{ type: 'video', url: stringValue(extra.video), title: stringValue(extra.title) }] : []),
            ...(Array.isArray(extra.image_swipes) ? extra.image_swipes.map((url: unknown) => ({ type: 'image', url: stringValue(url), title: stringValue(extra.title) })) : []),
        ];
    const legacyFile = parseOptionalRecord(extra.file);
    const files = Array.isArray(extra.files)
        ? parseRecordArray(extra.files)
        : (legacyFile ? [legacyFile] : []);
    const display = stringValue(extra.media_display) || (media.length > 1 ? 'list' : '');

    return {
        display,
        inline: extra.inline_image !== false,
        mediaIndex: typeof extra.media_index === 'number' ? extra.media_index : 0,
        media: media
            .map((item, index) => toMediaDto(item, index))
            .filter(item => item.url),
        files: files
            .map((item, index) => toFileDto(item, index)),
    };
}

export function openMessageMedia(messageId: number | string, mediaIndex: number): void {
    const mesEl = getMessageElementById(messageId);
    const button = mesEl?.querySelector(`.mes_media_container[data-index="${mediaIndex}"] .mes_media_enlarge`);
    if (button) {
        _dispatchClick(button);
        return;
    }

    const media = mesEl?.querySelector(`.mes_media_container[data-index="${mediaIndex}"] .mes_img, .mes_media_container[data-index="${mediaIndex}"] .mes_video`);
    if (media) _dispatchClick(media);
}

export function openMessageFile(messageId: number | string, fileIndex: number): void {
    const mesEl = getMessageElementById(messageId);
    const button = mesEl?.querySelector(`.mes_file_container[data-index="${fileIndex}"] .mes_file_open`);
    if (button) _dispatchClick(button);
}
