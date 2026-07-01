/**
 * SillyTavern-ChatUI · media adapter
 */

import { _dispatchClick, getMessageElementById } from './internals.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
function _string(value: any) {
    return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function _numberOrNull(value: any) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {Record<string, any>} attachment
 * @param {number} index
 * @returns {{ id: string, type: string, url: string, title: string, source: string, index: number }}
 */
function toMediaDto(attachment: any, index: any) {
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

/**
 * @param {Record<string, any>} file
 * @param {number} index
 * @returns {{ id: string, name: string, url: string, size: number|null, type: string, index: number }}
 */
function toFileDto(file: any, index: any) {
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

/**
 * @param {object} rawMessage
 * @returns {{ display: string, inline: boolean, mediaIndex: number, media: Array<object>, files: Array<object> }}
 */
export function getMessageAttachments(rawMessage: any) {
    const message = /** @type {Record<string, any>} */ (rawMessage ?? {});
    const extra = /** @type {Record<string, any>} */ (message.extra ?? {});
    const media = Array.isArray(extra.media)
        ? extra.media
        : [
            ...(_string(extra.image) ? [{ type: 'image', url: _string(extra.image), title: _string(extra.title) }] : []),
            ...(_string(extra.video) ? [{ type: 'video', url: _string(extra.video), title: _string(extra.title) }] : []),
            ...(Array.isArray(extra.image_swipes) ? extra.image_swipes.map((url: any) => ({ type: 'image', url: _string(url), title: _string(extra.title) })) : []),
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
            .filter((item: any) => item && typeof item === 'object')
            .map((item: any, index: any) => toMediaDto(/** @type {Record<string, any>} */ (item), index))
            .filter((item: any) => item.url),
        files: files
            .filter((item: any) => item && typeof item === 'object')
            .map((item: any, index: any) => toFileDto(/** @type {Record<string, any>} */ (item), index)),
    };
}

/**
 * @param {number|string} messageId
 * @param {number} mediaIndex
 * @returns {void}
 */
export function openMessageMedia(messageId: any, mediaIndex: any) {
    const mesEl = getMessageElementById(messageId);
    const button = mesEl?.querySelector(`.mes_media_container[data-index="${mediaIndex}"] .mes_media_enlarge`);
    if (button) {
        _dispatchClick(button);
        return;
    }

    const media = mesEl?.querySelector(`.mes_media_container[data-index="${mediaIndex}"] .mes_img, .mes_media_container[data-index="${mediaIndex}"] .mes_video`);
    if (media) _dispatchClick(media);
}

/**
 * @param {number|string} messageId
 * @param {number} fileIndex
 * @returns {void}
 */
export function openMessageFile(messageId: any, fileIndex: any) {
    const mesEl = getMessageElementById(messageId);
    const button = mesEl?.querySelector(`.mes_file_container[data-index="${fileIndex}"] .mes_file_open`);
    if (button) _dispatchClick(button);
}
