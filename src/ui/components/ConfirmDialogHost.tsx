import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useChatuiConfirmRequest } from '../hooks.js';
import { resolveChatuiConfirm } from '../actions.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * Single ChatUI-owned confirm dialog, mounted once at the app root
 * (ui/app.tsx, alongside <Toaster/>). Renders whatever request
 * store/confirm-store.ts currently holds -- at most one at a time, matching
 * the store's own "at most one pending" policy. Every caller (currently just
 * store/chat-actions.ts's message-delete orchestration) goes through
 * requestChatuiConfirm()/the returned promise; this component only ever
 * turns the *current* request into buttons and reports back which one the
 * user pressed.
 *
 * The `key` is load-bearing, not decoration. The store lets a new request
 * pre-empt an unanswered one, and without a key the dialog would be *updated*
 * rather than remounted: it would keep the previous request's mount-time
 * state, which now includes when its Enter guard started and whether it has
 * focused its confirm button. A pre-empting delete confirm would inherit an
 * already-expired guard — the exact case the guard exists for.
 */
export function ConfirmDialogHost(): ComponentChild {
    const request = useChatuiConfirmRequest();
    if (!request) return null;

    return (
        <ConfirmDialog
            key={request.id}
            title={request.title}
            message={request.message}
            confirmLabel={request.confirmLabel}
            cancelLabel={request.cancelLabel}
            escalateLabel={request.variant === 'three-way' ? request.escalateLabel : undefined}
            danger={request.danger}
            onConfirm={() => resolveChatuiConfirm(request.id, 'confirm')}
            onEscalate={request.variant === 'three-way'
                ? () => resolveChatuiConfirm(request.id, 'escalate')
                : undefined}
            onCancel={() => resolveChatuiConfirm(request.id, 'cancel')}
        />
    );
}
