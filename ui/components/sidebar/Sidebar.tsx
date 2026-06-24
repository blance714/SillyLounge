import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { triggerChatuiShellAction } from '../../actions.js';
import type { ShellAction } from '../../types.js';
import { ConfigRail } from './ConfigRail.js';
import { ConversationList } from './ConversationList.js';

export type SidebarForm = 'list' | 'block' | 'icon';

// Navigation launchers into ST's native right-nav (browse / create / groups).
const NAV_ITEMS: Array<{ action: ShellAction; label: string; iconClass: string }> = [
    { action: 'characters', label: 'Characters', iconClass: 'fa-solid fa-image-portrait' },
    { action: 'characterCreate', label: 'New character', iconClass: 'fa-solid fa-user-plus' },
    { action: 'groupChats', label: 'Groups', iconClass: 'fa-solid fa-user-group' },
];

/**
 * Region-5 sidebar. Persistent left column on desktop (three collapse forms via
 * data-cui-form: list ① / block ② / icon ③) and a slide-in overlay on mobile
 * (.is-mobile-open + backdrop). Pure-CSS responsive — JS only flips the form
 * attribute + the mobile-open flag.
 */
export function Sidebar({
    form,
    onCycleForm,
    mobileOpen,
    onClose,
}: {
    form: SidebarForm;
    onCycleForm: () => void;
    mobileOpen: boolean;
    onClose: () => void;
}): ComponentChild {
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
                data-cui-form={form}
                aria-label="ChatUI navigation"
            >
                <header className="cui-root-shell-header">
                    <button
                        className="cui-root-sidebar-collapse"
                        type="button"
                        aria-label="折叠 / 展开侧栏"
                        title="折叠 / 展开侧栏"
                        onClick={onCycleForm}
                    >
                        <i className="fa-solid fa-table-columns" />
                    </button>
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
                <nav className="cui-root-shell-nav">
                    {NAV_ITEMS.map(item => (
                        <button
                            key={item.action}
                            className="cui-root-shell-item"
                            type="button"
                            title={item.label}
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
