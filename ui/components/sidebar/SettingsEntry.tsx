import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { openChatuiSettings } from '../../actions.js';

/**
 * Bottom-pinned settings entry button in the sidebar. Calls openChatuiSettings()
 * to enter settings mode. The cui-root-sidebar-footer wrapper uses margin-top:
 * auto to anchor it to the bottom of the flex column regardless of list length.
 */
export function SettingsEntry({ onNavigate }: { onNavigate: () => void }): ComponentChild {
    return (
        <div className="cui-root-sidebar-footer">
            <button
                className="cui-root-settings-entry"
                type="button"
                onClick={() => {
                    openChatuiSettings();
                    onNavigate();
                }}
            >
                <i className="fa-solid fa-gear" />
                <span>设置</span>
            </button>
        </div>
    );
}
