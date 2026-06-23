import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { openChatuiChat } from '../../actions.js';
import type { ChatListItem } from '../../types.js';

/**
 * One past-chat row: icon · name + preview · time · (active ✓).
 * Pure DTO in; opens the chat through the action facade.
 */
export function ChatRow({ chat }: { chat: ChatListItem }): ComponentChild {
    const open = () => { void openChatuiChat(chat.fileName); };

    return (
        <li
            className={`cui-root-chat-row${chat.isCurrent ? ' is-current' : ''}`}
            role="button"
            tabIndex={0}
            data-current={chat.isCurrent}
            onClick={open}
            onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                open();
            }}
        >
            <i className="fa-regular fa-message cui-root-chat-row-icon" />
            <div className="cui-root-chat-row-main">
                <span className="cui-root-chat-row-name">{chat.displayName}</span>
                {chat.preview && <span className="cui-root-chat-row-preview">{chat.preview}</span>}
            </div>
            {chat.lastMesLabel && <span className="cui-root-chat-row-time">{chat.lastMesLabel}</span>}
            {chat.isCurrent && <i className="fa-solid fa-check cui-root-chat-row-check" />}
        </li>
    );
}
