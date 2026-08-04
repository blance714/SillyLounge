import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useSettings } from '../../hooks.js';
import { listChatuiStSettingsEntries } from '../../actions.js';
import { StDrawerHost } from './StDrawerHost.js';
import { ChatUiSettingsContent } from './ChatUiSettingsContent.js';

/**
 * Right pane in settings mode. Renders one StDrawerHost per ST entry (all
 * present in DOM, most hidden) and ChatUiSettingsContent for the active ChatUI
 * entry.
 *
 * Escape is *not* handled here. It used to be — a plain `window` keydown
 * listener that called `closeChatuiSettings()` unconditionally — which is
 * exactly the second-listener shape ui/escape-ladder.ts exists to forbid: with
 * a reply streaming, one Escape ran both this listener and the ladder's, so the
 * reader left settings and lost the generation in a single keystroke. The rung
 * lives in `resolveEscapeIntent` now, ahead of stop-generation and behind any
 * open menu.
 */
export function SettingsContent(): ComponentChild {
    const { activeSettingsId } = useSettings();
    const stEntries = listChatuiStSettingsEntries();

    const activeChatUiId = activeSettingsId?.startsWith('chatui:') ? activeSettingsId : null;

    return (
        <div className="cui-settings-content">
            {/* ST drawer hosts — always rendered, shown/hidden individually */}
            {stEntries.map(entry => (
                <StDrawerHost
                    key={entry.drawerContentId}
                    drawerContentId={entry.drawerContentId}
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
