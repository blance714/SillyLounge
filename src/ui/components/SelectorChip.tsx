import React, { useCallback, useEffect, useRef, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    closeChatuiMenu,
    closeChatuiMenuById,
    getChatuiSelectorOptions,
    notifyChatui,
    selectChatuiSelector,
    subscribeChatuiSelectorSync,
    toggleChatuiMenu,
} from '../actions.js';
import { useActiveChatuiMenu } from '../hooks.js';

export type SelectorKind = 'preset' | 'model' | 'persona';
type SelectorOption = { value: string; label: string; selected: boolean };

const KIND_ICON: Record<SelectorKind, string> = {
    preset: 'fa-solid fa-sliders',
    model: 'fa-solid fa-plug',
    persona: 'fa-solid fa-user',
};

const KIND_LABEL: Record<SelectorKind, string> = {
    preset: '预设',
    model: '模型',
    persona: '人设',
};

// Paper menus are titled (design §8). Tracking does the spacing, so these stay
// plain strings rather than the spaced-out form the design mock writes inline.
const KIND_MENU_TITLE: Record<SelectorKind, string> = {
    preset: '笔法 · PROMPT 预设',
    model: '笔 · 模型',
    persona: '以谁的身份落笔',
};

function SelectorChip({ kind, icon }: { kind: SelectorKind; icon: string }): ComponentChild {
    // One component, three instances (composer: 预设/模型, topbar: 人设), so the
    // menu id has to carry the kind — the single open slot in
    // store/menu-store.ts is what makes them mutually exclusive with each other
    // and with every other menu.
    const menuId = `selector:${kind}` as const;
    const isOpen = useActiveChatuiMenu()?.id === menuId;
    const [options, setOptions] = useState<SelectorOption[]>([]);
    const mountedRef = useRef(false);
    const requestIdRef = useRef(0);

    // A chip that leaves the tree (settings mode, or the composer's decoration
    // row changing shape) takes its own menu with it and no one else's.
    useEffect(() => () => closeChatuiMenuById(menuId), [menuId]);

    const refresh = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        try {
            const nextOptions = await getChatuiSelectorOptions(kind);
            if (!mountedRef.current || requestId !== requestIdRef.current) return;
            setOptions(nextOptions);
        } catch (error) {
            if (!mountedRef.current || requestId !== requestIdRef.current) return;
            console.error('[ChatUI] selector refresh failed', error);
        }
    }, [kind]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            requestIdRef.current += 1;
        };
    }, []);

    useEffect(() => {
        void refresh();
        return subscribeChatuiSelectorSync(() => { void refresh(); });
    }, [refresh]);

    const current = options.find(option => option.selected);

    const choose = async (value: string) => {
        closeChatuiMenu();
        try {
            await selectChatuiSelector(kind, value);
        } catch (error) {
            console.error('[ChatUI] selector select failed', error);
            notifyChatui('error', '切换失败');
        }
    };

    return (
        <div className="cui-root-selchip" data-kind={kind}>
            <button
                className="cui-root-selchip-btn"
                type="button"
                aria-label={`${KIND_LABEL[kind]}：${current?.label || '未选择'}`}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                title={`${KIND_LABEL[kind]}：${current?.label || '未选择'}`}
                onClick={() => toggleChatuiMenu(menuId)}
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
                        aria-label="关闭菜单"
                        onClick={() => closeChatuiMenu()}
                    />
                    <ul className="cui-root-selchip-menu cui-paper" role="listbox">
                        <li className="cui-paper-title" role="presentation">{KIND_MENU_TITLE[kind]}</li>
                        {options.length === 0 && (
                            <li className="cui-root-selchip-empty">无可用项</li>
                        )}
                        {options.map(option => (
                            <li
                                key={option.value}
                                className={`cui-root-selchip-item cui-paper-item${option.selected ? ' is-selected' : ''}`}
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

export function SelectorChips({ kinds = ['preset', 'model', 'persona'] }: { kinds?: SelectorKind[] } = {}): ComponentChild {
    return (
        <div className="cui-root-selchips">
            {kinds.map(kind => (
                <SelectorChip key={kind} kind={kind} icon={KIND_ICON[kind]} />
            ))}
        </div>
    );
}
