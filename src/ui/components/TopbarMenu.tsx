import React, { useEffect, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    closeChatuiMenu,
    closeChatuiMenuById,
    deleteChatuiChat,
    openChatuiSettings,
    toggleChatuiMenu,
    triggerChatuiMessageAction,
} from '../actions.js';
import { useActiveChatuiMenu, useChatuiSnapshot, useTopbarChatTarget } from '../hooks.js';
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
 *
 * ── Why this is a button and not a `<details>` ──
 *
 * It used to be a native `<details>/<summary>`, which is the one disclosure
 * widget the platform gives away for free and the one that cannot be told
 * anything. It answered to neither Escape nor a click anywhere else on the
 * page — the only way back out was to hit the same summary a second time — and
 * because its open state lived in the DOM rather than in the app, no other menu
 * could know it was open. DESIGN §6 asks for all three (mutual exclusion,
 * click-outside, Escape) and a `<details>` can supply none of them, so the
 * disclosure is now this app's own: state in store/menu-store.ts, a transparent
 * full-viewport backdrop for the click-outside, and the shared Escape ladder.
 */
export function TopbarMenu({
    onStartRename,
}: {
    onStartRename: (target: TopbarChatTarget) => void;
}): ComponentChild {
    const { hasCurrentChat, isGroup, target: currentTarget } = useTopbarChatTarget();
    const state = useChatuiSnapshot();
    const [deleteTarget, setDeleteTarget] = useState<TopbarChatTarget | null>(null);
    const isOpen = useActiveChatuiMenu()?.id === 'topbar';

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

    // A topbar that leaves (settings mode swaps the whole header out) must take
    // its menu with it; scoped so it can only ever close its own.
    useEffect(() => () => closeChatuiMenuById('topbar'), []);

    const confirmDelete = () => {
        const target = deleteTarget;
        setDeleteTarget(null);
        if (!target) return;
        void deleteChatuiChat(target.avatar, target.fileName);
    };

    // Every row dismisses the menu before it acts. Under `<details>` this was
    // the browser's job (and MenuItem used to reach up and strip the `open`
    // attribute to do it); now that the disclosure is ours, saying so at each
    // row is the whole of it.
    const pick = (run: () => void) => () => {
        closeChatuiMenu();
        run();
    };

    return (
        <div className="cui-root-topbar-menu">
            <div className="cui-root-action-menu">
                <button
                    className="cui-root-shell-toggle cui-root-menu-trigger"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    aria-label="对话操作"
                    title="对话操作"
                    onClick={() => toggleChatuiMenu('topbar')}
                >
                    <i className="fa-solid fa-ellipsis-vertical" />
                </button>
                {isOpen && (
                    <>
                        <button
                            className="cui-root-menu-backdrop"
                            type="button"
                            aria-label="关闭菜单"
                            onClick={() => closeChatuiMenu()}
                        />
                        {/* No `role="menu"`: these rows are MenuItem buttons
                            with no `role="menuitem"`, and a menu whose children
                            do not claim to be items is worse for a screen
                            reader than no role at all. The message ⋯ menu makes
                            the same choice; claiming the ARIA menu pattern also
                            means owing it arrow-key navigation, which is a
                            separate piece of work. */}
                        <div className="cui-root-menu cui-root-topbar-menu-dropdown cui-paper">
                            <MenuItem
                                label="重命名对话"
                                iconClass="fa-solid fa-pen"
                                disabled={!canRename}
                                onClick={pick(() => {
                                    if (currentTarget) onStartRename(currentTarget);
                                })}
                            />
                            <MenuItem
                                label="从末楼开新分支"
                                iconClass="fa-solid fa-code-branch"
                                disabled={!branch.enabled}
                                onClick={pick(() => {
                                    if (branch.messageId === null) return;
                                    triggerChatuiMessageAction(branch.messageId, 'branch', state.chat.chatKey);
                                })}
                            />
                            <div className="cui-paper-sep" />
                            <MenuItem
                                label="角色卡设定……"
                                iconClass="fa-solid fa-address-card"
                                disabled={!canOpenCharacterSettings}
                                onClick={pick(() => openChatuiSettings('st:right-nav-panel'))}
                            />
                            <div className="cui-paper-sep" />
                            <MenuItem
                                label="删除对话……"
                                iconClass="fa-solid fa-trash"
                                danger
                                disabled={!canDelete}
                                onClick={pick(() => {
                                    if (currentTarget) setDeleteTarget(currentTarget);
                                })}
                            />
                        </div>
                    </>
                )}
            </div>
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
