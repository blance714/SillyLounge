import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useSidebarBasics, useSidebarData } from '../../hooks.js';
import { CharacterConversationList } from './CharacterConversationList.js';
import { NewChatButton } from './NewChatButton.js';
import { QuarantinedDrafts } from './QuarantinedDrafts.js';

const SIDEBAR_NAV_SELECTOR = [
    '.cui-root-char-group-header',
    '.cui-root-nested-chat-row',
].join(',');
const SIDEBAR_NAV_IGNORE_SELECTOR = [
    '.cui-root-chat-row-act',
    '.cui-root-dialog-overlay',
    '.cui-root-dialog',
    'input',
    'textarea',
    'select',
].join(',');

/**
 * 场刊 playbill — the 252px column of conversations (DESIGN §4.2). It is the
 * second of the two rails: the spine says who, this says which night. It no
 * longer owns the drawer itself (the .cui-root-rails wrapper in app.tsx slides
 * spine + playbill in together on mobile) and no longer owns the settings
 * entry, which moved to the bottom of the spine.
 *
 * The list body is still the whole-cast accordion, unchanged: turning it into
 * the design's per-character conversation cards is its own change. So the
 * header names the *current* character while the list below still shows every
 * character — a real seam, and the reason the header's count is only drawn
 * when the current character's conversations are fully loaded rather than
 * guessed from a byte size.
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
    // Two hooks, one column: useSidebarData is the conversation feed the list
    // renders, useSidebarBasics is the only owner of the draft snapshot the
    // ＋新对话 button hands to the quarantine lease. Lifting the feed up here
    // (it used to be read inside CharacterConversationList) is what lets the
    // header count conversations without a second copy of that fan-out.
    const sidebar = useSidebarData();
    const { getDraftSnapshot } = useSidebarBasics();
    const { characters, header } = sidebar;
    const currentAvatar = characters.find(char => char.isCurrent)?.avatar ?? '';
    const currentGroup = sidebar.charGroups.find(group => group.isCurrent);
    const conversationCount = currentGroup?.fullyLoaded ? currentGroup.chats.length : null;
    const playbillName = header.characterName || 'ChatUI';

    const scheduleNavigateClose = () => {
        window.setTimeout(onNavigate, 0);
    };

    const onSidebarClickCapture = (event: Event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest(SIDEBAR_NAV_IGNORE_SELECTOR)) return;
        if (target.closest(SIDEBAR_NAV_SELECTOR)) scheduleNavigateClose();
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
            <div className="cui-root-sidebar-top">
                <NewChatButton
                    avatar={currentAvatar}
                    draftSnapshot={currentAvatar ? getDraftSnapshot(currentAvatar) : { fileNames: [], complete: false }}
                    disabled={!currentAvatar || !header.characterName || header.isGroup}
                    active={isTempChatActive}
                    onNavigate={onNavigate}
                />
                <QuarantinedDrafts characters={characters} onNavigate={onNavigate} />
            </div>
            <CharacterConversationList sidebar={sidebar} />
        </aside>
    );
}
