import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { ConfigSelect } from '../config/ConfigSelect.js';
import type { ConfigSelectOption } from '../config/ConfigSelect.js';
import { PlusPinEditor } from '../config/PlusPinEditor.js';
import { useConfig } from '../../hooks.js';
import {
    setChatuiMessageHeader,
    setChatuiComposerLines,
    MESSAGE_HEADERS,
    COMPOSER_LINES,
} from '../../actions.js';

// Localized option labels. Values (and their order) come from the config-store
// enums, so this map only supplies display text.
const MESSAGE_HEADER_LABELS: Record<string, string> = { icon: '头像 + 名字', name: '仅名字', none: '无（纯净）' };
const COMPOSER_LINES_LABELS: Record<string, string> = { multi: '多行', single: '单行' };

const toOptions = (values: string[], labels: Record<string, string>): ConfigSelectOption[] =>
    values.map(value => ({ value, label: labels[value] }));

const MESSAGE_HEADER_OPTIONS = toOptions(MESSAGE_HEADERS, MESSAGE_HEADER_LABELS);
const COMPOSER_LINES_OPTIONS = toOptions(COMPOSER_LINES, COMPOSER_LINES_LABELS);

type ChatUiSettingsContentProps = {
    /** One of 'chatui:appearance', 'chatui:headers', 'chatui:pins' */
    activeId: string;
};

/**
 * Right-pane content for ChatUI-native settings entries.
 * Renders the config rows / editors that were previously in ConfigPanel's body.
 */
export function ChatUiSettingsContent({ activeId }: ChatUiSettingsContentProps): ComponentChild {
    const config = useConfig();

    if (activeId === 'chatui:appearance') {
        return (
            <div className="cui-root-config-group">
                <span className="cui-root-section-label">界面</span>
                <ConfigSelect
                    label="输入框行数"
                    title="输入框单行 / 多行"
                    value={config.composerLines}
                    options={COMPOSER_LINES_OPTIONS}
                    onChange={v => setChatuiComposerLines(v as any)}
                />
            </div>
        );
    }

    if (activeId === 'chatui:headers') {
        return (
            <div className="cui-root-config-group">
                <span className="cui-root-section-label">消息标头</span>
                <ConfigSelect
                    label="群聊标头"
                    title="群聊里角色消息的身份标头"
                    value={config.headerGroup}
                    options={MESSAGE_HEADER_OPTIONS}
                    onChange={v => setChatuiMessageHeader('group', v as any)}
                />
                <ConfigSelect
                    label="单聊标头"
                    title="单聊里角色消息的身份标头"
                    value={config.headerSolo}
                    options={MESSAGE_HEADER_OPTIONS}
                    onChange={v => setChatuiMessageHeader('solo', v as any)}
                />
            </div>
        );
    }

    if (activeId === 'chatui:pins') {
        return <PlusPinEditor />;
    }

    return null;
}
