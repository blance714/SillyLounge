import React, { useEffect, useRef, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    clearChatuiMessageEditDraft,
    getChatuiMessageEditDraft,
    isChatuiLifecycleCancellation,
    saveEditedChatuiMessage,
    setChatuiMessageEditDraft,
} from '../../actions.js';
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
    // Seed from the external draft store first: the row this editor mounts
    // into may be a *remount* of an edit that was scrolled out of the
    // virtualizer's window earlier (see message-edit-draft-store.ts). Only
    // fall back to the saved message text when no draft was ever recorded.
    const [draft, setDraft] = useState(
        () => getChatuiMessageEditDraft(message.chatKey, message.id) ?? message.text,
    );
    const [isSaving, setIsSaving] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        setDraft(getChatuiMessageEditDraft(message.chatKey, message.id) ?? message.text);
    }, [message.id, message.chatKey, message.text]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, []);

    const setDraftText = (text: string) => {
        setDraft(text);
        // Write-through on every keystroke: an unmount without save/cancel
        // (virtualizer scroll, chat switch guard) must leave the draft
        // intact so a remount restores it verbatim.
        setChatuiMessageEditDraft(message.chatKey, message.id, text);
    };

    const cancel = () => {
        clearChatuiMessageEditDraft(message.chatKey, message.id);
        onCancel();
    };

    const save = async () => {
        if (isSaving) return;
        setIsSaving(true);
        try {
            await saveEditedChatuiMessage(message.id, draft, message.chatKey);
            clearChatuiMessageEditDraft(message.chatKey, message.id);
            onSaved();
        } catch (error) {
            if (!isChatuiLifecycleCancellation(error)) {
                console.error('[ChatUI] Failed to save message edit', error);
            }
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
                onInput={(event) => setDraftText(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        // Stop this from also reaching the app-level Escape-to-stop
                        // handler (hooks.ts useEscapeToStopGeneration) — cancelling an
                        // edit should never also abort an unrelated in-flight generation.
                        event.stopPropagation();
                        cancel();
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
                    aria-label="Cancel edit"
                    title="Cancel edit"
                    onClick={cancel}
                >
                    <i className="fa-solid fa-xmark" />
                    <span>Cancel</span>
                </button>
                <button
                    className="cui-root-edit-btn cui-root-edit-save"
                    type="button"
                    disabled={isSaving}
                    aria-label="Save edit"
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
