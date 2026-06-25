import React, { useRef, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    notifyChatui,
    sendChatuiComposerMessage,
    stopChatuiGeneration,
} from '../actions.js';
import { PlusMenu } from './PlusMenu.js';
import { AttachmentChips } from './AttachmentChips.js';
import { SelectorChips } from './SelectorChip.js';

export function GeneratingIndicator(): ComponentChild {
    return (
        <div className="cui-root-generating">
            <i className="fa-solid fa-spinner fa-spin" />
            <span>Generating</span>
        </div>
    );
}

export function Composer({
    isGenerating,
}: {
    isGenerating: boolean;
}): ComponentChild {
    const [draft, setDraft] = useState('');
    const [isSending, setIsSending] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const submit = async () => {
        if (isSending || isGenerating) return;

        setIsSending(true);
        try {
            await sendChatuiComposerMessage(draft);
            setDraft('');
            textareaRef.current?.focus();
        } catch (error) {
            console.error('[ChatUI] Failed to send composer message', error);
            notifyChatui('error', '发送失败');
        } finally {
            setIsSending(false);
        }
    };

    return (
        <form
            className="cui-root-composer"
            aria-label="ChatUI composer"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <AttachmentChips />
            <div className="cui-root-composer-row">
                <PlusMenu />
                <textarea
                    ref={textareaRef}
                    className="cui-root-composer-input"
                    value={draft}
                    rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                    disabled={isSending}
                    placeholder="Message"
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter' || event.shiftKey) return;
                        event.preventDefault();
                        void submit();
                    }}
                />
                {isGenerating ? (
                    <button
                        className="cui-root-composer-btn cui-root-composer-stop"
                        type="button"
                        aria-label="Stop generation"
                        title="Stop generation"
                        onClick={() => stopChatuiGeneration()}
                    >
                        <i className="fa-solid fa-stop" />
                    </button>
                ) : (
                    <button
                        className="cui-root-composer-btn"
                        type="submit"
                        aria-label={draft.trim() ? 'Send message' : 'Send or continue'}
                        title={draft.trim() ? 'Send message' : 'Send or continue'}
                        disabled={isSending}
                    >
                        <i className={isSending ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-paper-plane'} />
                    </button>
                )}
            </div>
            <SelectorChips kinds={['preset', 'model']} />
        </form>
    );
}
