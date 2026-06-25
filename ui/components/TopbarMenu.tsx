import React, { useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { deleteChatuiChat, newChatuiChat, renameChatuiChat } from '../actions.js';
import { useSidebarData } from '../hooks.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { MenuItem } from './message/MenuItem.js';

/**
 * Topbar-right ⋯ overflow menu for current-chat operations:
 * rename, delete (guarded by ConfirmDialog), and new chat.
 */
export function TopbarMenu(): ComponentChild {
    const sidebar = useSidebarData();
    const [renaming, setRenaming] = useState(false);
    const [draft, setDraft] = useState('');
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    // Resolve the current chat and character from sidebar state.
    const currentChat = sidebar.chats.find(c => c.isCurrent) ?? null;
    const currentCharacter = sidebar.characters.find(c => c.isCurrent) ?? null;
    const currentAvatar = currentCharacter?.avatar ?? '';
    const hasCurrentChat = currentChat !== null;
    const chatDisplayName = currentChat?.displayName ?? sidebar.header.sessionName ?? '';

    const startRename = () => {
        setDraft(chatDisplayName);
        setRenaming(true);
    };

    const commitRename = () => {
        setRenaming(false);
        const next = draft.trim();
        if (next && next !== chatDisplayName && currentChat) {
            void renameChatuiChat(currentChat.fileName, next);
        }
    };

    const confirmDelete = () => {
        setConfirmingDelete(false);
        if (currentChat && currentAvatar) {
            void deleteChatuiChat(currentAvatar, currentChat.fileName);
        }
    };

    return (
        <div className="cui-root-topbar-menu">
            {renaming ? (
                <input
                    className="cui-root-topbar-rename"
                    type="text"
                    value={draft}
                    autoFocus
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    onBlur={() => setRenaming(false)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
                        else if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); }
                    }}
                />
            ) : (
                <details className="cui-root-action-menu">
                    <summary
                        className="cui-root-shell-toggle cui-root-menu-trigger"
                        aria-label="对话操作"
                        title="对话操作"
                    >
                        <i className="fa-solid fa-ellipsis-vertical" />
                    </summary>
                    <div className="cui-root-menu cui-root-topbar-menu-dropdown">
                        <MenuItem
                            label="重命名对话"
                            iconClass="fa-solid fa-pen"
                            onClick={hasCurrentChat ? startRename : () => {}}
                        />
                        <MenuItem
                            label="删除对话"
                            iconClass="fa-solid fa-trash"
                            onClick={hasCurrentChat && currentAvatar ? () => setConfirmingDelete(true) : () => {}}
                        />
                        <MenuItem
                            label="＋ 新对话"
                            iconClass="fa-solid fa-plus"
                            onClick={() => void newChatuiChat()}
                        />
                    </div>
                </details>
            )}
            {confirmingDelete && (
                <ConfirmDialog
                    title="删除对话"
                    message={`确定删除「${chatDisplayName}」？此操作不可撤销。`}
                    confirmLabel="删除"
                    danger
                    onConfirm={confirmDelete}
                    onCancel={() => setConfirmingDelete(false)}
                />
            )}
        </div>
    );
}
