import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useSidebarBasics } from '../../hooks.js';
import { CharacterConversationList } from './CharacterConversationList.js';
import { NewChatButton } from './NewChatButton.js';
import { QuarantinedDrafts } from './QuarantinedDrafts.js';
import { SettingsEntry } from './SettingsEntry.js';

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
 * Region-5 sidebar. Persistent left column on desktop; slide-in overlay on mobile
 * (.is-mobile-open + backdrop). Two-section layout: NewChatButton pinned at top,
 * ConversationList slot in middle, SettingsEntry pinned at bottom.
 */
export function Sidebar({
    mobileOpen,
    onClose,
    onNavigate,
    isTempChatActive,
}: {
    mobileOpen: boolean;
    onClose: () => void;
    onNavigate: () => void;
    isTempChatActive: boolean;
}): ComponentChild {
    const { characters, getDraftSnapshot, header } = useSidebarBasics();
    const currentAvatar = characters.find(char => char.isCurrent)?.avatar ?? '';

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
        <>
            {mobileOpen && (
                <button
                    className="cui-root-sidebar-backdrop"
                    type="button"
                    aria-label="Close navigation"
                    onClick={onClose}
                />
            )}
            <aside
                className={`cui-root-sidebar${mobileOpen ? ' is-mobile-open' : ''}`}
                aria-label="ChatUI navigation"
                onClickCapture={onSidebarClickCapture}
                onKeyDownCapture={onSidebarKeyDownCapture}
            >
                <header className="cui-root-shell-header">
                    <span className="cui-root-sidebar-title">ChatUI</span>
                    <button
                        className="cui-root-shell-close"
                        type="button"
                        aria-label="Close navigation"
                        title="Close navigation"
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
                <CharacterConversationList />
                <SettingsEntry onNavigate={onNavigate} />
            </aside>
        </>
    );
}
