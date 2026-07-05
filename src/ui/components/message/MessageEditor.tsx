import React, { useEffect, useRef, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { saveEditedChatuiMessage } from '../../actions.js';
import type { ChatuiMessage } from '../../types.js';

export function MessageEditor({
    message,
    onCancel,
    onSaved,
}: {
    message: ChatuiMessage;
    onCancel: () => void;
    onSaved: () => void;
}): ComponentChild {
    const [draft, setDraft] = useState(message.text);
    const [isSaving, setIsSaving] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        setDraft(message.text);
    }, [message.id, message.text]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, []);

    const save = async () => {
        if (isSaving) return;
        setIsSaving(true);
        try {
            await saveEditedChatuiMessage(message.id, draft);
            onSaved();
        } catch (error) {
            console.error('[ChatUI] Failed to save message edit', error);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="cui-root-edit">
            <textarea
                ref={textareaRef}
                className="cui-root-edit-textarea"
                value={draft}
                disabled={isSaving}
                rows={Math.min(18, Math.max(4, draft.split('\n').length + 1))}
                onInput={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        // Stop this from also reaching the app-level Escape-to-stop
                        // handler (hooks.ts useEscapeToStopGeneration) — cancelling an
                        // edit should never also abort an unrelated in-flight generation.
                        event.stopPropagation();
                        onCancel();
                    }
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault();
                        event.stopPropagation();
                        void save();
                    }
                }}
            />
            <div className="cui-root-edit-actions">
                <button
                    className="cui-root-edit-btn"
                    type="button"
                    disabled={isSaving}
                    title="Cancel edit"
                    onClick={onCancel}
                >
                    <i className="fa-solid fa-xmark" />
                    <span>Cancel</span>
                </button>
                <button
                    className="cui-root-edit-btn cui-root-edit-save"
                    type="button"
                    disabled={isSaving}
                    title="Save edit"
                    onClick={() => void save()}
                >
                    <i className={isSaving ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-check'} />
                    <span>{isSaving ? 'Saving' : 'Save'}</span>
                </button>
            </div>
        </div>
    );
}
