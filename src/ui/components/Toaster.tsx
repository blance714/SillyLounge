import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { dismissChatuiToast } from '../actions.js';
import { useToasts } from '../hooks.js';

const TOAST_ICON: Record<string, string> = {
    info: 'fa-solid fa-circle-info',
    success: 'fa-solid fa-circle-check',
    error: 'fa-solid fa-circle-exclamation',
};

export function Toaster(): ComponentChild {
    const toasts = useToasts();
    if (toasts.length === 0) return null;

    return (
        <div className="cui-root-toasts" role="status" aria-live="polite">
            {toasts.map(toast => (
                <div key={toast.id} className={`cui-root-toast cui-root-toast-${toast.kind}`}>
                    <i className={TOAST_ICON[toast.kind] ?? TOAST_ICON.info} />
                    <span className="cui-root-toast-text">{toast.text}</span>
                    <button
                        className="cui-root-toast-close"
                        type="button"
                        aria-label="关闭"
                        title="关闭"
                        onClick={() => dismissChatuiToast(toast.id)}
                    >
                        <i className="fa-solid fa-xmark" />
                    </button>
                </div>
            ))}
        </div>
    );
}
