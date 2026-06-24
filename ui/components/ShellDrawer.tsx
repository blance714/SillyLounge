import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { triggerChatuiShellAction } from '../actions.js';
import type { ShellAction } from '../types.js';
import { ConfigRail } from './sidebar/ConfigRail.js';
import { ConversationList } from './sidebar/ConversationList.js';

// Navigation launchers into ST's native right-nav (browse / create / groups).
// Config drawers now live in <ConfigRail> (上段); conversations in <ConversationList> (下段).
const NAV_ITEMS: Array<{ action: ShellAction; label: string; iconClass: string }> = [
    { action: 'characters', label: 'Characters', iconClass: 'fa-solid fa-image-portrait' },
    { action: 'characterCreate', label: 'New character', iconClass: 'fa-solid fa-user-plus' },
    { action: 'groupChats', label: 'Groups', iconClass: 'fa-solid fa-user-group' },
];

export function ShellDrawer({
    isOpen,
    onClose,
}: {
    isOpen: boolean;
    onClose: () => void;
}): ComponentChild {
    if (!isOpen) return null;

    return (
        <>
            <button
                className="cui-root-shell-backdrop"
                type="button"
                aria-label="Close navigation"
                onClick={onClose}
            />
            <aside className="cui-root-shell-drawer" aria-label="ChatUI navigation">
                <header className="cui-root-shell-header">
                    <span>ChatUI</span>
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
                <nav className="cui-root-shell-nav">
                    {NAV_ITEMS.map(item => (
                        <button
                            key={item.action}
                            className="cui-root-shell-item"
                            type="button"
                            onClick={() => {
                                triggerChatuiShellAction(item.action);
                                onClose();
                            }}
                        >
                            <i className={item.iconClass} />
                            <span>{item.label}</span>
                        </button>
                    ))}
                </nav>
                <ConfigRail onNavigate={onClose} />
                <ConversationList />
            </aside>
        </>
    );
}
