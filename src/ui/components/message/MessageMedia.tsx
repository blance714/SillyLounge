import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    openChatuiMessageFile,
    openChatuiMessageMedia,
} from '../../actions.js';
import { formatBytes } from '../../format.js';
import type { ChatuiMessage } from '../../types.js';

export function MessageMedia({ message }: { message: ChatuiMessage }): ComponentChild {
    const { media, files, display, mediaIndex } = message.attachments;
    const visibleMedia = display === 'gallery' && media.length > 0
        ? [media[Math.min(Math.max(mediaIndex, 0), media.length - 1)]]
        : media;

    if (visibleMedia.length === 0 && files.length === 0) return null;

    return (
        <div className="cui-root-attachments">
            {visibleMedia.length > 0 && (
                <div className={`cui-root-media-list cui-root-media-${display || 'list'}`}>
                    {visibleMedia.map(item => (
                        <figure
                            key={item.id}
                            className={`cui-root-media-item cui-root-media-item-${item.type}`}
                        >
                            {item.type === 'video' ? (
                                <video className="cui-root-media-video" src={item.url} title={item.title} controls preload="metadata" />
                            ) : item.type === 'audio' ? (
                                <audio className="cui-root-media-audio" src={item.url} title={item.title} controls preload="metadata" />
                            ) : (
                                <button
                                    className="cui-root-media-open"
                                    type="button"
                                    aria-label={`Open ${item.title}`}
                                    title={item.title}
                                    onClick={() => openChatuiMessageMedia(message.id, item.index)}
                                >
                                    <img className="cui-root-media-image" src={item.url} alt={item.title} loading="lazy" />
                                </button>
                            )}
                            {display === 'gallery' && media.length > 1 && (
                                <figcaption className="cui-root-media-counter">
                                    {mediaIndex + 1}/{media.length}
                                </figcaption>
                            )}
                        </figure>
                    ))}
                </div>
            )}
            {files.length > 0 && (
                <div className="cui-root-file-list">
                    {files.map(file => (
                        <button
                            key={file.id}
                            className="cui-root-file-item"
                            type="button"
                            title={file.name}
                            onClick={() => openChatuiMessageFile(message.id, file.index)}
                        >
                            <i className="fa-solid fa-file-lines" />
                            <span className="cui-root-file-name">{file.name}</span>
                            {formatBytes(file.size) && (
                                <span className="cui-root-file-size">{formatBytes(file.size)}</span>
                            )}
                            <i className="fa-solid fa-magnifying-glass cui-root-file-open" />
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
