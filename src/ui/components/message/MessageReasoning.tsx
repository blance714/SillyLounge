import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { formatDuration } from '../../format.js';
import type { ChatuiMessage } from '../../types.js';

export function MessageReasoning({ message }: { message: ChatuiMessage }): ComponentChild {
    if (!message.extra.reasoningHtml) return null;

    // Design §4 labels the trigger 「思考了 N 秒」. Not every provider reports a
    // duration, and an invented number would be worse than none, so without one
    // the label names the block instead of timing it.
    const duration = formatDuration(message.extra.reasoningDuration);

    return (
        <details className="cui-root-reasoning">
            <summary className="cui-root-reasoning-summary">
                <i className="fa-solid fa-lightbulb cui-root-reasoning-icon" aria-hidden="true" />
                {duration ? `思考了 ${duration}` : '思考片刻'}
            </summary>
            <div
                className="cui-root-reasoning-body mes_text"
                dangerouslySetInnerHTML={{ __html: message.extra.reasoningHtml }}
            />
        </details>
    );
}
