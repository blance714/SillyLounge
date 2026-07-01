/**
 * SillyTavern-ChatUI · media adapter
 */

import { _dispatchClick, getMessageElementById } from './internals.js';

type UnknownRecord = Record<string, unknown>;

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

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object';
}

function _string(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function _numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toMediaDto(attachment: UnknownRecord, index: number): MediaAttachmentDto {
    const type = _string(attachment.type) || 'image';
    const url = _string(attachment.url);
    const title = _string(attachment.title) || _string(attachment.name) || url.split('/').pop() || type;

    return {
        id: `${index}:${type}:${url}`,
        type,
        url,
        title,
        source: _string(attachment.source),
        index,
    };
}

function toFileDto(file: UnknownRecord, index: number): FileAttachmentDto {
    const name = _string(file.name) || _string(file.url).split('/').pop() || 'Attachment';

    return {
        id: `${index}:${name}:${_string(file.url)}`,
        name,
        url: _string(file.url),
        size: _numberOrNull(file.size),
        type: _string(file.type),
        index,
    };
}

export function getMessageAttachments(rawMessage: unknown): MessageAttachmentsDto {
    const message = isRecord(rawMessage) ? rawMessage : {};
    const extra = isRecord(message.extra) ? message.extra : {};
    const media = Array.isArray(extra.media)
        ? extra.media
        : [
            ...(_string(extra.image) ? [{ type: 'image', url: _string(extra.image), title: _string(extra.title) }] : []),
            ...(_string(extra.video) ? [{ type: 'video', url: _string(extra.video), title: _string(extra.title) }] : []),
            ...(Array.isArray(extra.image_swipes) ? extra.image_swipes.map(url => ({ type: 'image', url: _string(url), title: _string(extra.title) })) : []),
        ];
    const files = Array.isArray(extra.files)
        ? extra.files
        : (extra.file ? [extra.file] : []);
    const display = _string(extra.media_display) || (media.length > 1 ? 'list' : '');

    return {
        display,
        inline: extra.inline_image !== false,
        mediaIndex: typeof extra.media_index === 'number' ? extra.media_index : 0,
        media: media
            .filter(isRecord)
            .map((item, index) => toMediaDto(item, index))
            .filter(item => item.url),
        files: files
            .filter(isRecord)
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
