import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { newChatuiChat } from '../../actions.js';

/**
 * Region-5 ＋新对话 · creates a new chat for the current character.
 * Disabled when no character is selected (doNewChat would silently no-op).
 */
export function NewChatButton({ disabled }: { disabled: boolean }): ComponentChild {
    return (
        <button
            className="cui-root-newchat"
            type="button"
            disabled={disabled}
            onClick={() => { void newChatuiChat(); }}
        >
            <i className="fa-solid fa-plus" />
            <span>新对话</span>
        </button>
    );
}
