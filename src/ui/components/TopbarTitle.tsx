import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useCaretOnMount } from '../hooks.js';

/**
 * Title-page topbar heading (DESIGN §4.1, README §7): eyebrow above, the
 * conversation's title below with a hover-revealed pencil that swaps the
 * title for an in-place rename input. Rename state itself is lifted to
 * app.tsx (like `editingMessage`) rather than owned here, because the ⋯
 * menu's「重命名对话」row (TopbarMenu.tsx) must be able to start the very
 * same edit.
 *
 * `.cui-root-topbar-title` is a CI-asserted class (e2e/smoke.spec.mjs,
 * scripts/e2e/measure-chat-switch.mjs both read its exact text): it stays a
 * plain `<h1>` with nothing but the title string inside it in the non-rename
 * state, and the pencil trigger is always a *sibling*, never a child, so it
 * can never leak into that text.
 */
export function TopbarTitle({
    title,
    eyebrow,
    canRename,
    isRenaming,
    draft,
    onStartRename,
    onDraftChange,
    onCommit,
    onCancel,
}: {
    title: string;
    eyebrow: string;
    canRename: boolean;
    isRenaming: boolean;
    draft: string;
    onStartRename: () => void;
    onDraftChange: (text: string) => void;
    onCommit: () => void;
    onCancel: () => void;
}): ComponentChild {
    // Not `autoFocus`: it is inert for a field mounted after load — see
    // useCaretOnMount for the measurement and the mechanism.
    const inputRef = useCaretOnMount<HTMLInputElement>(isRenaming);
    return (
        <div className="cui-root-topbar-heading">
            <span className="cui-root-topbar-eyebrow">{eyebrow}</span>
            {isRenaming ? (
                <div className="cui-root-topbar-title-editor">
                    <input
                        ref={inputRef}
                        className="cui-root-topbar-rename"
                        type="text"
                        value={draft}
                        aria-label="重命名对话"
                        onInput={(event) => onDraftChange(event.currentTarget.value)}
                        onBlur={onCancel}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                onCommit();
                            } else if (event.key === 'Escape') {
                                // Stop this from also reaching the app-level
                                // Escape-to-stop handler (hooks.ts
                                // useEscapeToStopGeneration): cancelling a
                                // rename must never also abort an unrelated
                                // in-flight generation (MessageEditor's own
                                // Escape handler makes the same guard).
                                event.preventDefault();
                                event.stopPropagation();
                                onCancel();
                            }
                        }}
                    />
                    <span className="cui-root-topbar-rename-hint">Enter 保存 · Esc 取消</span>
                </div>
            ) : (
                <div className="cui-root-topbar-title-row">
                    <h1 className="cui-root-topbar-title">{title}</h1>
                    {canRename && (
                        <button
                            className="cui-root-topbar-rename-trigger"
                            type="button"
                            aria-label="重命名对话"
                            title="重命名对话"
                            onClick={onStartRename}
                        >
                            <i className="fa-solid fa-pen" />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
