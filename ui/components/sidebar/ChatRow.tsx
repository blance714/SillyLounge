import React, { useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { deleteChatuiChat, openChatuiChat, renameChatuiChat } from '../../actions.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { ChatListItem } from '../../types.js';

/**
 * One past-chat row: icon · name + preview · time · (active ✓), with hover
 * rename (inline) + delete (confirm dialog) affordances. `currentAvatar` is the
 * Mode-A character that owns these chats.
 */
export function ChatRow({
    chat,
    currentAvatar,
}: {
    chat: ChatListItem;
    currentAvatar: string;
}): ComponentChild {
    const [renaming, setRenaming] = useState(false);
    const [draft, setDraft] = useState('');
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const open = () => { void openChatuiChat(chat.fileName); };

    const startRename = (event: Event) => {
        event.stopPropagation();
        setDraft(chat.displayName);
        setRenaming(true);
    };

    const commitRename = () => {
        setRenaming(false);
        const next = draft.trim();
        if (next && next !== chat.displayName) void renameChatuiChat(chat.fileName, next);
    };

    const confirmDelete = () => {
        setConfirmingDelete(false);
        void deleteChatuiChat(currentAvatar, chat.fileName);
    };

    return (
        <li
            className={`cui-root-chat-row${chat.isCurrent ? ' is-current' : ''}`}
            role="button"
            tabIndex={0}
            data-current={chat.isCurrent}
            onClick={renaming ? undefined : open}
            onKeyDown={(event) => {
                if (renaming || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                open();
            }}
        >
            <i className="fa-regular fa-message cui-root-chat-row-icon" />
            <div className="cui-root-chat-row-main">
                {renaming ? (
                    <input
                        className="cui-root-chat-row-rename"
                        type="text"
                        value={draft}
                        autoFocus
                        onClick={(event) => event.stopPropagation()}
                        onInput={(event) => setDraft(event.currentTarget.value)}
                        onBlur={() => setRenaming(false)}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
                            else if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); }
                        }}
                    />
                ) : (
                    <>
                        <span className="cui-root-chat-row-name">{chat.displayName}</span>
                        {chat.preview && <span className="cui-root-chat-row-preview">{chat.preview}</span>}
                    </>
                )}
            </div>
            {!renaming && (
                <>
                    {chat.lastMesLabel && <span className="cui-root-chat-row-time">{chat.lastMesLabel}</span>}
                    {chat.isCurrent && <i className="fa-solid fa-check cui-root-chat-row-check" />}
                    <div className="cui-root-chat-row-actions">
                        <button
                            className="cui-root-chat-row-act"
                            type="button"
                            aria-label="重命名"
                            title="重命名"
                            onClick={startRename}
                        >
                            <i className="fa-solid fa-pen" />
                        </button>
                        <button
                            className="cui-root-chat-row-act cui-root-chat-row-act-danger"
                            type="button"
                            aria-label="删除"
                            title="删除"
                            onClick={(event) => { event.stopPropagation(); setConfirmingDelete(true); }}
                        >
                            <i className="fa-solid fa-trash" />
                        </button>
                    </div>
                </>
            )}
            {confirmingDelete && (
                <ConfirmDialog
                    title="删除对话"
                    message={`确定删除「${chat.displayName}」？此操作不可撤销。`}
                    confirmLabel="删除"
                    danger
                    onConfirm={confirmDelete}
                    onCancel={() => setConfirmingDelete(false)}
                />
            )}
        </li>
    );
}
