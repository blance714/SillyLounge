import React from 'preact/compat';
import type { ComponentChild } from 'preact';

export type ConfigSelectOption = { value: string; label: string };

/**
 * One labeled `<select>` row for the settings panel. Declarative replacement for
 * index.js's old optionsHtml + bindConfigSelect DOM wiring — the parent passes the
 * current value (from useConfig) and an onChange that persists via a config-store
 * setter, so two-way sync is just normal Preact rendering.
 */
export function ConfigSelect({
    label,
    title,
    value,
    options,
    onChange,
}: {
    label: string;
    title?: string;
    value: string;
    options: ConfigSelectOption[];
    onChange: (value: string) => void;
}): ComponentChild {
    return (
        <label className="cui-root-config-row" title={title}>
            <span className="cui-root-config-row-label">{label}</span>
            <select
                className="cui-root-config-select text_pole"
                value={value}
                onChange={event => onChange((event.target as HTMLSelectElement).value)}
            >
                {options.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </label>
    );
}
