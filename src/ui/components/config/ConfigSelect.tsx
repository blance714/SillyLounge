import React from 'preact/compat';
import type { ComponentChild } from 'preact';

export type ConfigSelectOption<T extends string = string> = { value: T; label: string };

type ConfigSelectProps<T extends string> = {
    label: string;
    title?: string;
    value: T;
    options: readonly ConfigSelectOption<T>[];
    onChange: (value: T) => void;
};

function findOptionValue<T extends string>(
    options: readonly ConfigSelectOption<T>[],
    value: string,
): T | null {
    for (const option of options) {
        if (option.value === value) return option.value;
    }
    return null;
}

/**
 * One labeled `<select>` row for the settings panel. Declarative replacement for
 * index.js's old optionsHtml + bindConfigSelect DOM wiring — the parent passes the
 * current value (from useConfig) and an onChange that persists via a config-store
 * setter, so two-way sync is just normal Preact rendering.
 */
export function ConfigSelect<T extends string>({
    label,
    title,
    value,
    options,
    onChange,
}: ConfigSelectProps<T>): ComponentChild {
    return (
        <label className="cui-root-config-row" title={title}>
            <span className="cui-root-config-row-label">{label}</span>
            <select
                className="cui-root-config-select text_pole"
                value={value}
                onChange={event => {
                    const nextValue = findOptionValue(options, (event.target as HTMLSelectElement).value);
                    if (nextValue !== null) onChange(nextValue);
                }}
            >
                {options.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </label>
    );
}
