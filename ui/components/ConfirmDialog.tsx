import React, { useEffect, useRef } from 'preact/compat';
import type { ComponentChild } from 'preact';

/**
 * ChatUI-owned confirm dialog (no native ST popup). stopPropagation everywhere
 * so it can be rendered inside a clickable row without triggering it; Escape
 * cancels and the cancel button auto-focuses (safe default for destructive use).
 */
export function ConfirmDialog({
    title,
    message,
    confirmLabel = '确定',
    cancelLabel = '取消',
    danger = false,
    onConfirm,
    onCancel,
}: {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}): ComponentChild {
    const cancelRef = useRef<HTMLButtonElement>(null);

    useEffect(() => { cancelRef.current?.focus(); }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    return (
        <div
            className="cui-root-dialog-overlay"
            onClick={(event) => { event.stopPropagation(); onCancel(); }}
        >
            <div
                className="cui-root-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="cui-root-dialog-title">{title}</div>
                {message && <div className="cui-root-dialog-message">{message}</div>}
                <div className="cui-root-dialog-actions">
                    <button
                        ref={cancelRef}
                        className="cui-root-dialog-btn"
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onCancel(); }}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        className={`cui-root-dialog-btn cui-root-dialog-confirm${danger ? ' is-danger' : ''}`}
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onConfirm(); }}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
