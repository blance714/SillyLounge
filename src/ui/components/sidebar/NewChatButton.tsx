import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { beginTempChatDraft, newChatuiChat } from '../../actions.js';

/**
 * Region-5 ＋新对话 · creates a new chat for the current character.
 * Disabled when no character is selected (doNewChat would silently no-op).
 */
export function NewChatButton({
    disabled,
    active,
    avatar,
    draftSnapshot,
    onNavigate,
}: {
    disabled: boolean;
    active: boolean;
    avatar: string;
    draftSnapshot: { fileNames: string[]; complete: boolean };
    onNavigate: () => void;
}): ComponentChild {
    return (
        <button
            className={`cui-root-newchat${active ? ' is-active' : ''}`}
            type="button"
            disabled={disabled}
            onClick={() => {
                beginTempChatDraft({
                    avatar,
                    knownFileNames: draftSnapshot.fileNames,
                    complete: draftSnapshot.complete,
                });
                void newChatuiChat();
                onNavigate();
            }}
        >
            <i className="fa-solid fa-plus" />
            <span>新对话</span>
        </button>
    );
}
