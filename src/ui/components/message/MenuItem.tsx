import React from 'preact/compat';
import type { ComponentChild } from 'preact';

export function MenuItem({
    label,
    iconClass,
    onClick,
    disabled = false,
}: {
    label: string;
    iconClass: string;
    onClick: () => void;
    disabled?: boolean;
}): ComponentChild {
    return (
        <button
            className="cui-root-menu-item"
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
