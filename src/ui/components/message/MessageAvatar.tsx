import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import type { ChatuiMessage } from '../../types.js';

export function MessageAvatar({ message }: { message: ChatuiMessage }): ComponentChild {
    if (!message.forceAvatarSrc && !message.name) return null;

    return (
        <div className="cui-root-avatar">
            {message.forceAvatarSrc ? (
                <img src={message.forceAvatarSrc} alt={message.name || message.role} />
            ) : (
                (message.name || message.role).trim().slice(0, 1).toUpperCase()
            )}
        </div>
    );
}
