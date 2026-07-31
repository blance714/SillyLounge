import React, { useEffect, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { deleteChatuiChat, openChatuiSettings, triggerChatuiMessageAction } from '../actions.js';
import { useChatuiSnapshot, useTopbarChatTarget } from '../hooks.js';
import { resolveBranchFromLastFloor } from '../topbar-menu-logic.js';
import type { TopbarChatTarget } from '../topbar-menu-logic.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { MenuItem } from './message/MenuItem.js';

/**
 * Topbar-right ⋯ overflow menu for current-chat operations (design §7's
 * order: 重命名对话 / 从末楼开新分支 / — / 角色卡设定…… / — / 删除对话……).
 * Rename itself now lives on the topbar title (TopbarTitle.tsx) — this row is
 * a second, hover-independent entry into the exact same edit, via
 * `onStartRename` from the shared app.tsx state.
 */
export function TopbarMenu({
    onStartRename,
}: {
    onStartRename: (target: TopbarChatTarget) => void;
}): ComponentChild {
    const { hasCurrentChat, isGroup, target: currentTarget } = useTopbarChatTarget();
    const state = useChatuiSnapshot();
    const [deleteTarget, setDeleteTarget] = useState<TopbarChatTarget | null>(null);

    const canRename = hasCurrentChat;
    const canDelete = hasCurrentChat;
    // Character-card settings edit the roster, not this specific chat file, so
    // (unlike rename/delete) they stay open with no chat loaded at all — the
    // spine's own「＋」into this same panel has no such requirement either.
    // Only a group, which has no single character card to open, disables it.
    const canOpenCharacterSettings = !isGroup;
    const branch = resolveBranchFromLastFloor(state.chat.messageIds, state.chat.isGenerating);
    const currentTargetKey = currentTarget ? `${currentTarget.avatar}:${currentTarget.fileName}` : '';

    useEffect(() => {
        setDeleteTarget(null);
    }, [currentTargetKey]);

    const confirmDelete = () => {
        const target = deleteTarget;
        setDeleteTarget(null);
        if (!target) return;
        void deleteChatuiChat(target.avatar, target.fileName);
    };

    return (
        <div className="cui-root-topbar-menu">
            <details className="cui-root-action-menu">
                <summary
                    className="cui-root-shell-toggle cui-root-menu-trigger"
                    aria-label="对话操作"
                    title="对话操作"
                >
                    <i className="fa-solid fa-ellipsis-vertical" />
                </summary>
                <div className="cui-root-menu cui-root-topbar-menu-dropdown cui-paper">
                    <MenuItem
                        label="重命名对话"
                        iconClass="fa-solid fa-pen"
                        disabled={!canRename}
                        onClick={() => {
                            if (currentTarget) onStartRename(currentTarget);
                        }}
                    />
                    <MenuItem
                        label="从末楼开新分支"
                        iconClass="fa-solid fa-code-branch"
                        disabled={!branch.enabled}
                        onClick={() => {
                            if (branch.messageId === null) return;
                            triggerChatuiMessageAction(branch.messageId, 'branch', state.chat.chatKey);
                        }}
                    />
                    <div className="cui-paper-sep" />
                    <MenuItem
                        label="角色卡设定……"
                        iconClass="fa-solid fa-address-card"
                        disabled={!canOpenCharacterSettings}
                        onClick={() => openChatuiSettings('st:right-nav-panel')}
                    />
                    <div className="cui-paper-sep" />
                    <MenuItem
                        label="删除对话……"
                        iconClass="fa-solid fa-trash"
                        danger
                        disabled={!canDelete}
                        onClick={() => {
                            if (currentTarget) setDeleteTarget(currentTarget);
                        }}
                    />
                </div>
            </details>
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
