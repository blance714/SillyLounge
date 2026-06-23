import React from 'preact/compat';
import type { ComponentChild } from 'preact';

export function ActionButton({
    label,
    iconClass,
    onClick,
}: {
    label: string;
    iconClass: string;
    onClick: () => void;
}): ComponentChild {
    return (
        <button
            className="cui-root-action-btn"
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
