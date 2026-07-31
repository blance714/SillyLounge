import React from 'preact/compat';
import type { ComponentChild } from 'preact';

export function ActionButton({
    label,
    iconClass,
    onClick,
    danger = false,
}: {
    label: string;
    iconClass: string;
    onClick: () => void;
    /** Destructive tiles wash red on hover instead of the shared warm tint (design §42). */
    danger?: boolean;
}): ComponentChild {
    return (
        <button
            className={`cui-root-action-btn${danger ? ' is-danger' : ''}`}
            type="button"
            aria-label={label}
            title={label}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
        >
            <i className={iconClass} />
        </button>
    );
}
