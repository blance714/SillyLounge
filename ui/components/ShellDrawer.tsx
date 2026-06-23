import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { triggerChatuiShellAction } from '../actions.js';
import type { ShellAction } from '../types.js';
import { ConversationList } from './sidebar/ConversationList.js';

const SHELL_ITEMS: Array<{ action: ShellAction; label: string; iconClass: string }> = [
    { action: 'characters', label: 'Characters', iconClass: 'fa-solid fa-image-portrait' },
    { action: 'characterCreate', label: 'New character', iconClass: 'fa-solid fa-user-plus' },
    { action: 'groupChats', label: 'Groups', iconClass: 'fa-solid fa-user-group' },
    { action: 'aiConfig', label: 'AI config', iconClass: 'fa-solid fa-sliders' },
    { action: 'worldInfo', label: 'World info', iconClass: 'fa-solid fa-earth-americas' },
    { action: 'personas', label: 'Personas', iconClass: 'fa-solid fa-face-smile' },
    { action: 'extensions', label: 'Extensions', iconClass: 'fa-solid fa-puzzle-piece' },
    { action: 'userSettings', label: 'User settings', iconClass: 'fa-solid fa-gear' },
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
                    {SHELL_ITEMS.map(item => (
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
                <ConversationList />
            </aside>
        </>
    );
}
