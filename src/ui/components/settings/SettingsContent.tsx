import React, { useEffect } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useSettings } from '../../hooks.js';
import { listChatuiStSettingsEntries, closeChatuiSettings } from '../../actions.js';
import { StDrawerHost } from './StDrawerHost.js';
import { ChatUiSettingsContent } from './ChatUiSettingsContent.js';

/**
 * Right pane in settings mode. Renders one StDrawerHost per ST entry (all
 * present in DOM, most hidden) and ChatUiSettingsContent for the active ChatUI
 * entry. Handles Escape key to close settings mode.
 */
export function SettingsContent(): ComponentChild {
    const { activeSettingsId } = useSettings();
    const stEntries = listChatuiStSettingsEntries();

    const activeChatUiId = activeSettingsId?.startsWith('chatui:') ? activeSettingsId : null;

    // Escape closes settings mode.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeChatuiSettings(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return (
        <div className="cui-settings-content">
            {/* ST drawer hosts — always rendered, shown/hidden individually */}
            {stEntries.map(entry => (
                <StDrawerHost
                    key={entry.drawerContentId}
                    drawerContentId={entry.drawerContentId!}
                    active={activeSettingsId === entry.id}
                />
            ))}

            {/* ChatUI settings pane — rendered only when a chatui entry is active */}
            {activeChatUiId && (
                <div className="cui-settings-chatui">
                    <ChatUiSettingsContent activeId={activeChatUiId} />
                </div>
            )}
        </div>
    );
}
