import React, { useEffect, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { deleteChatuiChat, renameChatuiChat, getChatuiCurrentChatIdentity } from '../actions.js';
import { useCurrentChatIdentity, useSidebarBasics } from '../hooks.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { MenuItem } from './message/MenuItem.js';

type ChatOperationTarget = {
    fileName: string;
    avatar: string;
    displayName: string;
};

const _isLiveTarget = (t: ChatOperationTarget) => {
    const live = getChatuiCurrentChatIdentity();
    return !!live && live.avatar === t.avatar && live.fileName === t.fileName;
};

/**
 * Topbar-right ⋯ overflow menu for current-chat operations:
 * rename and delete (guarded by ConfirmDialog).
 */
export function TopbarMenu(): ComponentChild {
    const identity = useCurrentChatIdentity();
    const sidebar = useSidebarBasics();
    const [renameTarget, setRenameTarget] = useState<ChatOperationTarget | null>(null);
    const [draft, setDraft] = useState('');
    const [deleteTarget, setDeleteTarget] = useState<ChatOperationTarget | null>(null);

    const isGroup = sidebar.header.isGroup;
    const hasCurrentChat = !!identity && !isGroup;
    const currentTarget = hasCurrentChat
        ? { fileName: identity.fileName, avatar: identity.avatar, displayName: identity.fileName }
        : null;
    const currentTargetKey = currentTarget ? `${currentTarget.avatar}:${currentTarget.fileName}` : '';
    const canRename = hasCurrentChat;
    const canDelete = hasCurrentChat;

    useEffect(() => {
        setRenameTarget(null);
        setDeleteTarget(null);
    }, [currentTargetKey]);

    const startRename = () => {
        if (!currentTarget) return;
        setDraft(currentTarget.displayName);
        setRenameTarget(currentTarget);
    };

    const commitRename = () => {
        const target = renameTarget;
        setRenameTarget(null);
        const next = draft.trim();
        if (target && next && next !== target.displayName) {
            if (!_isLiveTarget(target)) return;
            void renameChatuiChat(target.fileName, next);
        }
    };

    const confirmDelete = () => {
        const target = deleteTarget;
        setDeleteTarget(null);
        if (!target || !target.avatar || !_isLiveTarget(target)) return;
        void deleteChatuiChat(target.avatar, target.fileName);
    };

    return (
        <div className="cui-root-topbar-menu">
            {renameTarget ? (
                <input
                    className="cui-root-topbar-rename"
                    type="text"
                    value={draft}
                    autoFocus
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    onBlur={() => setRenameTarget(null)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
                        else if (event.key === 'Escape') { event.preventDefault(); setRenameTarget(null); }
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
                            disabled={!canRename}
                            onClick={startRename}
                        />
                        <MenuItem
                            label="删除对话"
                            iconClass="fa-solid fa-trash"
                            disabled={!canDelete}
                            onClick={() => {
                                if (currentTarget) setDeleteTarget(currentTarget);
                            }}
                        />
                    </div>
                </details>
            )}
            {deleteTarget && (
                <ConfirmDialog
                    title="删除对话"
                    message={`确定删除「${deleteTarget.displayName}」？此操作不可撤销。`}
                    confirmLabel="删除"
                    danger
                    onConfirm={confirmDelete}
                    onCancel={() => setDeleteTarget(null)}
                />
            )}
        </div>
    );
}
