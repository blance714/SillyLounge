import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useSettings } from '../../hooks.js';
import { closeChatuiSettings, setActiveChatuiSettings, listChatuiStSettingsEntries } from '../../actions.js';
import type { SettingsEntry } from '../../types.js';

const CHATUI_SETTINGS_ENTRIES: SettingsEntry[] = [
    { id: 'chatui:appearance', section: 'chatui', label: '界面',    iconClass: 'fa-solid fa-sliders-h' },
    { id: 'chatui:headers',    section: 'chatui', label: '消息标头', iconClass: 'fa-solid fa-id-card-clip' },
    { id: 'chatui:pins',       section: 'chatui', label: '＋磁贴',  iconClass: 'fa-solid fa-thumbtack' },
];

/**
 * Left pane in settings mode. Renders ST settings entries (in DOM order) and
 * ChatUI-native settings entries in separate sections, with a ←返回对话 button.
 */
export function SettingsNav(): ComponentChild {
    const { activeSettingsId } = useSettings();
    const stEntries = listChatuiStSettingsEntries();

    return (
        <nav className="cui-settings-nav" aria-label="设置导航">
            {/* ←返回对话 */}
            <button
                type="button"
                className="cui-settings-nav-back"
                onClick={closeChatuiSettings}
            >
                <i className="fa-solid fa-arrow-left" />
                <span>返回对话</span>
            </button>

            {/* ST section */}
            <div className="cui-settings-nav-section">
                <span className="cui-root-section-label">ST 设置</span>
                {stEntries.map(entry => (
                    <button
                        key={entry.id}
                        type="button"
                        className={`cui-settings-nav-item${activeSettingsId === entry.id ? ' is-active' : ''}`}
                        onClick={() => setActiveChatuiSettings(entry.id)}
                    >
                        <i className={entry.iconClass} />
                        <span>{entry.label}</span>
                    </button>
                ))}
            </div>

            {/* ChatUI section */}
            <div className="cui-settings-nav-section">
                <span className="cui-root-section-label">ChatUI</span>
                {CHATUI_SETTINGS_ENTRIES.map(entry => (
                    <button
                        key={entry.id}
                        type="button"
                        className={`cui-settings-nav-item${activeSettingsId === entry.id ? ' is-active' : ''}`}
                        onClick={() => setActiveChatuiSettings(entry.id)}
                    >
                        <i className={entry.iconClass} />
                        <span>{entry.label}</span>
                    </button>
                ))}
            </div>
        </nav>
    );
}
