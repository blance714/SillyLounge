import React, { useCallback, useEffect, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    getChatuiSelectorOptions,
    selectChatuiSelector,
    subscribeChatuiSelectorSync,
} from '../actions.js';

type SelectorKind = 'preset' | 'model' | 'persona';
type SelectorOption = { value: string; label: string; selected: boolean };

function SelectorChip({ kind, icon }: { kind: SelectorKind; icon: string }): ComponentChild {
    const [isOpen, setIsOpen] = useState(false);
    const [options, setOptions] = useState<SelectorOption[]>([]);

    const refresh = useCallback(async () => {
        try {
            setOptions(await getChatuiSelectorOptions(kind));
        } catch (error) {
            console.error('[ChatUI] selector refresh failed', error);
        }
    }, [kind]);

    useEffect(() => {
        void refresh();
        return subscribeChatuiSelectorSync(() => { void refresh(); });
    }, [refresh]);

    const current = options.find(option => option.selected);

    const choose = async (value: string) => {
        setIsOpen(false);
        try {
            await selectChatuiSelector(kind, value);
        } catch (error) {
            console.error('[ChatUI] selector select failed', error);
        }
    };

    return (
        <div className="cui-root-selchip" data-kind={kind}>
            <button
                className="cui-root-selchip-btn"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                onClick={() => setIsOpen(open => !open)}
            >
                <i className={icon} />
                <span className="cui-root-selchip-label">{current?.label || '—'}</span>
                <i className="fa-solid fa-chevron-down cui-root-selchip-caret" />
            </button>
            {isOpen && (
                <>
                    <button
                        className="cui-root-selchip-backdrop"
                        type="button"
                        aria-label="Close"
                        onClick={() => setIsOpen(false)}
                    />
                    <ul className="cui-root-selchip-menu" role="listbox">
                        {options.length === 0 && (
                            <li className="cui-root-selchip-empty">无可用项</li>
                        )}
                        {options.map(option => (
                            <li
                                key={option.value}
                                className={`cui-root-selchip-item${option.selected ? ' is-selected' : ''}`}
                                role="option"
                                aria-selected={option.selected}
                                onClick={() => void choose(option.value)}
                            >
                                <span>{option.label}</span>
                                {option.selected && <i className="fa-solid fa-check" />}
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}

export function SelectorChips(): ComponentChild {
    return (
        <div className="cui-root-selchips">
            <SelectorChip kind="preset" icon="fa-solid fa-sliders" />
            <SelectorChip kind="model" icon="fa-solid fa-plug" />
            <SelectorChip kind="persona" icon="fa-solid fa-user" />
        </div>
    );
}
