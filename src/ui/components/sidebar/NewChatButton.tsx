import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { newChatuiChat } from '../../actions.js';

/**
 * The playbill's footer entry (DESIGN §4.2, 原型 L88): a dashed outline that
 * reads as an empty slot waiting to be filled, pinned below the card column
 * instead of riding at the top of it. Creates a new chat for the current
 * character; disabled when none is selected (doNewChat would silently no-op).
 *
 * A plain button, and nothing more. It used to double as the *row* for the new
 * chat it had just created — lighting up while that chat was quarantined and
 * therefore absent from the card column above — which is why it once needed an
 * `active` flag and a snapshot of the sidebar listing. A new chat is an
 * ordinary conversation now: it gets its own card like every other, so the
 * button has nothing left to stand in for.
 */
export function NewChatButton({
    disabled,
    onNavigate,
}: {
    disabled: boolean;
    onNavigate: () => void;
}): ComponentChild {
    return (
        <button
            className="cui-root-newchat"
            type="button"
            disabled={disabled}
            onClick={() => {
                void newChatuiChat();
                onNavigate();
            }}
        >
            <i className="fa-solid fa-plus" aria-hidden="true" />
            <span>新对话</span>
        </button>
    );
}
