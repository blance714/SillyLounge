import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useSidebarBasics, useSidebarData } from '../../hooks.js';
import { CharacterConversationList } from './CharacterConversationList.js';
import { NewChatButton } from './NewChatButton.js';

const SIDEBAR_NAV_IGNORE_SELECTOR = [
    '.cui-root-playbill-card-act',
    '.cui-root-dialog-overlay',
    '.cui-root-dialog',
    'input',
    'textarea',
    'select',
].join(',');

/**
 * 场刊 playbill — the 252px column of conversations (DESIGN §4.2). It is the
 * second of the two rails: the spine says who, this says which night. It does
 * not own the drawer (the .cui-root-rails wrapper in app.tsx slides spine +
 * playbill in together on mobile) and does not own the settings entry, which
 * sits at the foot of the spine.
 *
 * Three bands, and only the middle one scrolls: the masthead names the
 * character and counts their nights, the card column lists them, and the
 * ＋新对话 slot is pinned to the floor where the design puts it.
 */
export function Sidebar({
    onClose,
    onNavigate,
    isTempChatActive,
}: {
    onClose: () => void;
    onNavigate: () => void;
    isTempChatActive: boolean;
}): ComponentChild {
    // Two hooks, one column: useSidebarData is the current character's
    // conversation feed, useSidebarBasics is the only owner of the draft
    // snapshot the ＋新对话 button hands to the quarantine lease.
    const sidebar = useSidebarData();
    const { getDraftSnapshot } = useSidebarBasics();
    const { characters, header } = sidebar;
    const currentAvatar = characters.find(char => char.isCurrent)?.avatar ?? '';
    const conversationCount = sidebar.charGroups[0]?.totalCount ?? null;
    const playbillName = header.characterName || 'ChatUI';

    const scheduleNavigateClose = () => {
        window.setTimeout(onNavigate, 0);
    };

    const onSidebarClickCapture = (event: Event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest(SIDEBAR_NAV_IGNORE_SELECTOR)) return;
        if (target.closest('.cui-root-nested-chat-row')) scheduleNavigateClose();
    };

    const onSidebarKeyDownCapture = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest(SIDEBAR_NAV_IGNORE_SELECTOR)) return;
        if (target.closest('.cui-root-nested-chat-row')) scheduleNavigateClose();
    };

    return (
        <aside
            className="cui-root-sidebar"
            aria-label="ChatUI navigation"
            onClickCapture={onSidebarClickCapture}
            onKeyDownCapture={onSidebarKeyDownCapture}
        >
            <header className="cui-root-shell-header">
                <div className="cui-root-playbill-heading">
                    <span className="cui-root-playbill-name" title={playbillName}>{playbillName}</span>
                    <span className="cui-root-playbill-count">
                        {conversationCount === null ? '的对话' : `的对话 · ${conversationCount}`}
                    </span>
                </div>
                <button
                    className="cui-root-shell-close"
                    type="button"
                    aria-label="收起侧栏"
                    title="收起侧栏"
                    onClick={onClose}
                >
                    <i className="fa-solid fa-xmark" />
                </button>
            </header>
            <CharacterConversationList sidebar={sidebar} onNavigate={onNavigate} />
            <div className="cui-root-playbill-footer">
                <NewChatButton
                    avatar={currentAvatar}
                    draftSnapshot={currentAvatar ? getDraftSnapshot(currentAvatar) : { fileNames: [], complete: false }}
                    disabled={!currentAvatar || !header.characterName || header.isGroup}
                    active={isTempChatActive}
                    onNavigate={onNavigate}
                />
            </div>
        </aside>
    );
}
