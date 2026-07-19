import React, { createPortal, useEffect, useRef } from 'preact/compat';
import type { ComponentChild } from 'preact';

/**
 * ChatUI-owned confirm dialog (no native ST popup). Portals to document.body:
 * callers render this inline inside arbitrary rows (e.g. NestedChatRow), and
 * some of those ancestors carry their own `transform` (the sidebar's slide
 * animation) — a `transform` anywhere up the tree makes that ancestor the
 * containing block for this dialog's `position:fixed` overlay instead of the
 * viewport, so the "modal" ends up sized/positioned against a small,
 * possibly off-screen box. Portaling sidesteps that regardless of where a
 * caller mounts it. stopPropagation everywhere so it can still be rendered
 * inside a clickable row without triggering it; Escape cancels and the
 * cancel button auto-focuses (safe default for destructive use).
 */
export function ConfirmDialog({
    title,
    message,
    confirmLabel = '确定',
    cancelLabel = '取消',
    danger = false,
    escalateLabel,
    onConfirm,
    onCancel,
    onEscalate,
}: {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    /** Optional third ("escalate") button rendered between cancel and confirm —
     * e.g. message delete's "Delete Message" upgrade from the default "Delete
     * Swipe" (DOM-DECOUPLING.md decision #3's three-way delete confirm).
     * Omitted (with onEscalate) means a plain two-button dialog, unchanged for
     * every other existing caller of this component. */
    escalateLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    onEscalate?: () => void;
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

    return createPortal(
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
                    {escalateLabel && onEscalate && (
                        <button
                            className="cui-root-dialog-btn cui-root-dialog-escalate"
                            type="button"
                            onClick={(event) => { event.stopPropagation(); onEscalate(); }}
                        >
                            {escalateLabel}
                        </button>
                    )}
                    <button
                        className={`cui-root-dialog-btn cui-root-dialog-confirm${danger ? ' is-danger' : ''}`}
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onConfirm(); }}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
