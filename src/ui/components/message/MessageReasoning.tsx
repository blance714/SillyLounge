import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { formatDuration } from '../../format.js';
import type { ChatuiMessage } from '../../types.js';

export function MessageReasoning({ message }: { message: ChatuiMessage }): ComponentChild {
    if (!message.extra.reasoningHtml) return null;

    const duration = formatDuration(message.extra.reasoningDuration);

    return (
        <details className="cui-root-reasoning">
            <summary className="cui-root-reasoning-summary">
                Reasoning
                {duration && <span className="cui-root-reasoning-duration">{duration}</span>}
            </summary>
            <div
                className="cui-root-reasoning-body mes_text"
                dangerouslySetInnerHTML={{ __html: message.extra.reasoningHtml }}
            />
        </details>
    );
}
