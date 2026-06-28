import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { newChatuiChat } from '../../actions.js';

/**
 * Region-5 ＋新对话 · creates a new chat for the current character.
 * Disabled when no character is selected (doNewChat would silently no-op).
 */
export function NewChatButton({
    disabled,
    active,
    onNavigate,
}: {
    disabled: boolean;
    active: boolean;
    onNavigate: () => void;
}): ComponentChild {
    return (
        <button
            className={`cui-root-newchat${active ? ' is-active' : ''}`}
            type="button"
            disabled={disabled}
            onClick={() => {
                void newChatuiChat();
                onNavigate();
            }}
        >
            <i className="fa-solid fa-plus" />
            <span>新对话</span>
        </button>
    );
}
