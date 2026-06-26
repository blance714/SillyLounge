import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { openSettingsPanel, triggerChatuiShellAction } from '../../actions.js';
import type { ShellAction } from '../../types.js';

const CONFIG_ITEMS: Array<{ action: ShellAction; label: string; iconClass: string }> = [
    { action: 'aiConfig', label: 'AI 配置', iconClass: 'fa-solid fa-sliders' },
    { action: 'formatting', label: '格式化', iconClass: 'fa-solid fa-font' },
    { action: 'worldInfo', label: '世界书', iconClass: 'fa-solid fa-book-atlas' },
    { action: 'background', label: '背景', iconClass: 'fa-solid fa-image' },
    { action: 'userSettings', label: '用户设置', iconClass: 'fa-solid fa-user-gear' },
    { action: 'extensions', label: '扩展', iconClass: 'fa-solid fa-cubes' },
    { action: 'personas', label: '人设', iconClass: 'fa-solid fa-masks-theater' },
];

/**
 * Region-5 上段 · config-drawer icons. Opening a config reuses ST's native
 * .drawer-content (which renders centered at the top of the page) and closes the
 * ChatUI drawer so the native panel is unobstructed — an open/close state
 * independent of conversation selection (DESIGN 2.2).
 */
export function ConfigRail({ onNavigate }: { onNavigate: () => void }): ComponentChild {
    return (
        <div className="cui-root-configrail">
            <span className="cui-root-section-label">配置</span>
            <div className="cui-root-configrail-icons" role="toolbar" aria-label="配置">
                {/* ChatUI-native settings (独立配置面) — opens the in-app panel, not an
                    ST drawer, so it sits ahead of the native-drawer icons with its own
                    handler. */}
                <button
                    className="cui-root-configrail-btn cui-root-configrail-btn-chatui"
                    type="button"
                    aria-label="ChatUI 设置"
                    title="ChatUI 设置"
                    onClick={() => {
                        openSettingsPanel();
                        onNavigate();
                    }}
                >
                    <i className="fa-solid fa-gear" />
                </button>
                {CONFIG_ITEMS.map(item => (
                    <button
                        key={item.action}
                        className="cui-root-configrail-btn"
                        type="button"
                        aria-label={item.label}
                        title={item.label}
                        onClick={() => {
                            triggerChatuiShellAction(item.action);
                            onNavigate();
                        }}
                    >
                        <i className={item.iconClass} />
                    </button>
                ))}
            </div>
        </div>
    );
}
