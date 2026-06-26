import React, { useEffect } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { ConfigSelect } from './ConfigSelect.js';
import type { ConfigSelectOption } from './ConfigSelect.js';
import { PlusPinEditor } from './PlusPinEditor.js';
import { useConfig, useSettingsPanel } from '../../hooks.js';
import {
    closeSettingsPanel,
    setChatuiSidebarForm,
    setChatuiMessageHeader,
    setChatuiComposerLines,
    SIDEBAR_FORMS,
    MESSAGE_HEADERS,
    COMPOSER_LINES,
} from '../../actions.js';

// Localized option labels. Values (and their order) come from the config-store
// enums, so this map only supplies display text — the single source of truth for
// which values exist stays in store/config-store.js.
const SIDEBAR_FORM_LABELS: Record<string, string> = { list: '列表', block: '方块', icon: '纯图标' };
const MESSAGE_HEADER_LABELS: Record<string, string> = { icon: '头像 + 名字', name: '仅名字', none: '无（纯净）' };
const COMPOSER_LINES_LABELS: Record<string, string> = { multi: '多行', single: '单行' };

const toOptions = (values: string[], labels: Record<string, string>): ConfigSelectOption[] =>
    values.map(value => ({ value, label: labels[value] }));

const SIDEBAR_FORM_OPTIONS = toOptions(SIDEBAR_FORMS, SIDEBAR_FORM_LABELS);
const MESSAGE_HEADER_OPTIONS = toOptions(MESSAGE_HEADERS, MESSAGE_HEADER_LABELS);
const COMPOSER_LINES_OPTIONS = toOptions(COMPOSER_LINES, COMPOSER_LINES_LABELS);

/**
 * ChatUI-native settings panel (独立配置面). Desktop: an in-flow push-aside column
 * between the sidebar and the chat (the chat shrinks but stays visible). Mobile: a
 * full-screen takeover. Renders null when closed so it costs no layout.
 *
 * Holds the per-feature config migrated out of ST's extension-settings drawer
 * (index.js now keeps only the master enable toggle) plus the ＋menu pin editor.
 */
export function ConfigPanel(): ComponentChild {
    const open = useSettingsPanel();
    const config = useConfig();

    // Escape closes the panel (mirrors ConfirmDialog). Bound only while open.
    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeSettingsPanel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    if (!open) return null;

    return (
        <aside className="cui-root-configpanel" aria-label="ChatUI 设置">
            <header className="cui-root-configpanel-header">
                <button
                    className="cui-root-configpanel-back"
                    type="button"
                    aria-label="返回"
                    title="返回"
                    onClick={closeSettingsPanel}
                >
                    <i className="fa-solid fa-arrow-left" />
                </button>
                <span className="cui-root-configpanel-title">ChatUI 设置</span>
            </header>
            <div className="cui-root-configpanel-body">
                <div className="cui-root-config-group">
                    <span className="cui-root-section-label">界面</span>
                    <ConfigSelect
                        label="侧边栏形式"
                        title="侧边栏默认展示形式"
                        value={config.sidebarForm}
                        options={SIDEBAR_FORM_OPTIONS}
                        onChange={value => setChatuiSidebarForm(value as any)}
                    />
                    <ConfigSelect
                        label="输入框行数"
                        title="输入框单行 / 多行"
                        value={config.composerLines}
                        options={COMPOSER_LINES_OPTIONS}
                        onChange={value => setChatuiComposerLines(value as any)}
                    />
                </div>
                <div className="cui-root-config-group">
                    <span className="cui-root-section-label">消息标头</span>
                    <ConfigSelect
                        label="群聊标头"
                        title="群聊里角色消息的身份标头"
                        value={config.headerGroup}
                        options={MESSAGE_HEADER_OPTIONS}
                        onChange={value => setChatuiMessageHeader('group', value as any)}
                    />
                    <ConfigSelect
                        label="单聊标头"
                        title="单聊里角色消息的身份标头"
                        value={config.headerSolo}
                        options={MESSAGE_HEADER_OPTIONS}
                        onChange={value => setChatuiMessageHeader('solo', value as any)}
                    />
                </div>
                <PlusPinEditor />
            </div>
        </aside>
    );
}
