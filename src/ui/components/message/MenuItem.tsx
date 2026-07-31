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
            onClick={(event) => {
                event.stopPropagation();
                event.currentTarget.closest('details')?.removeAttribute('open');
                onClick();
            }}
        >
            <i className={iconClass} />
            <span>{label}</span>
        </button>
    );
}
