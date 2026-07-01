import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { formatTimestamp } from '../format.js';
import type { ChatuiMessage, MessageHeaderMode } from '../types.js';
import { MessageActions } from './message/MessageActions.js';
import { MessageAvatar } from './message/MessageAvatar.js';
import { MessageEditor } from './message/MessageEditor.js';
import { MessageMedia } from './message/MessageMedia.js';
import { MessageReasoning } from './message/MessageReasoning.js';

export function MessageItem({
    message,
    headerMode,
    isEditing,
    onStartEdit,
    onCancelEdit,
    onSavedEdit,
}: {
    message: ChatuiMessage;
    headerMode: MessageHeaderMode;
    isEditing: boolean;
    onStartEdit: () => void;
    onCancelEdit: () => void;
    onSavedEdit: () => void;
}): ComponentChild {
    const timestamp = formatTimestamp(message.sendDate);
    const shouldShowBody = message.attachments.inline || message.attachments.media.length === 0;

    // The 3-mode identity header (DESIGN §5.A) governs character messages only;
    // user bubbles keep their own meta. 'none' drops the header entirely, 'name'
    // keeps the name/time line but no avatar.
    const showMeta = !message.isChar || headerMode !== 'none';
    const showAvatar = !message.isChar || headerMode === 'icon';

    return (
        <article
            className={`cui-root-message cui-root-message-${message.role}`}
            data-cui-message-id={String(message.id)}
            data-cui-message-role={message.role}
        >
            {showMeta && (
                <div className="cui-root-message-meta">
                    {showAvatar && <MessageAvatar message={message} />}
                    <span className="cui-root-message-name">{message.name || message.role}</span>
                    {timestamp && <span className="cui-root-message-time">{timestamp}</span>}
                    {message.swipe.hasMultiple && (
                        <span className="cui-root-message-swipe">{message.swipe.label}</span>
                    )}
                </div>
            )}
            {isEditing ? (
                <MessageEditor message={message} onCancel={onCancelEdit} onSaved={onSavedEdit} />
            ) : (
                <>
                    <MessageReasoning message={message} />
                    {shouldShowBody && (
                        <div
                            className="cui-root-message-body"
                            dangerouslySetInnerHTML={{ __html: message.html }}
                        />
                    )}
                    <MessageMedia message={message} />
                    <MessageActions message={message} onEdit={onStartEdit} />
                </>
            )}
        </article>
    );
}
