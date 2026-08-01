import React from 'preact/compat';
import type { ComponentChild } from 'preact';

export function MenuItem({
    label,
    iconClass,
    onClick,
    disabled = false,
    danger = false,
}: {
    label: string;
    iconClass: string;
    onClick: () => void;
    disabled?: boolean;
    /** Destructive rows are written in cinnabar on the paper surface (design §8). */
    danger?: boolean;
}): ComponentChild {
    return (
        <button
            className={`cui-root-menu-item cui-paper-item${danger ? ' is-danger' : ''}`}
            type="button"
            disabled={disabled}
            /* The row never dismisses the menu on its own: since the topbar's
               ⋯ stopped being a native `<details>` there is no disclosure left
               for a row to reach up and shut, and every menu's open state is a
               single slot in store/menu-store.ts that its own component knows
               how to clear. `stopPropagation` stays — a menu row's click is an
               answer to the menu, never also a click on whatever the menu
               happens to be drawn over. */
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
        >
            <i className={iconClass} />
            <span>{label}</span>
        </button>
    );
}
