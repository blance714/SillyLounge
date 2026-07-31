import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { beginTempChatDraft, newChatuiChat } from '../../actions.js';

/**
 * The playbill's footer entry (DESIGN §4.2, 原型 L88): a dashed outline that
 * reads as an empty slot waiting to be filled, pinned below the card column
 * instead of riding at the top of it. Creates a new chat for the current
 * character; disabled when none is selected (doNewChat would silently no-op).
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
            <i className="fa-solid fa-plus" aria-hidden="true" />
            <span>新对话</span>
        </button>
    );
}
