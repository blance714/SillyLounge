import React, { useRef } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    beginChatuiComposerSend,
    clearChatuiComposerDraftIfMatches,
    finishChatuiComposerSend,
    isChatuiLifecycleCancellation,
    notifyChatui,
    regenerateChatuiLast,
    sendChatuiComposerMessage,
    stopChatuiGeneration,
} from '../actions.js';
import { PlusMenu } from './PlusMenu.js';
import { AttachmentChips } from './AttachmentChips.js';
import { SelectorChips } from './SelectorChip.js';
import { useComposerDraft, useConfig } from '../hooks.js';

export function GeneratingIndicator(): ComponentChild {
    return (
        <div className="cui-root-generating" role="status" aria-atomic="true">
            <span className="cui-root-generating-seal" aria-hidden="true" />
            <span className="cui-root-generating-label">落笔中</span>
        </div>
    );
}

export function Composer({
    chatKey,
    isGenerating,
    onEditLast,
}: {
    chatKey: string;
    isGenerating: boolean;
    onEditLast?: () => void;
}): ComponentChild {
    const { draft, pendingSend, setDraft } = useComposerDraft(chatKey);
    const isSending = pendingSend !== null;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const chatKeyRef = useRef(chatKey);
    chatKeyRef.current = chatKey;
    const singleLine = useConfig().composerLines === 'single';
    // Slot B = preset + model. Multi-line shows it on its own row below the input;
    // single-line relocates it into the ＋ menu top (DESIGN §4.2).
    const selectorSlotB = <SelectorChips kinds={['preset', 'model']} />;

    const submit = async () => {
        if (isSending || isGenerating) return;

        const sendToken = beginChatuiComposerSend(chatKey, draft);
        if (!sendToken) return;
        let accepted = false;
        try {
            await sendChatuiComposerMessage(sendToken.text, sendToken.chatKey, () => {
                accepted = true;
                clearChatuiComposerDraftIfMatches(sendToken);
                if (chatKeyRef.current === sendToken.chatKey) textareaRef.current?.focus();
            });
        } catch (error) {
            if (isChatuiLifecycleCancellation(error)) {
                // Full teardown intentionally invalidated this queued intent.
            } else if (accepted) {
                console.error('[ChatUI] Generation failed after the message was accepted', error);
            } else {
                console.error('[ChatUI] Failed to send composer message', error);
                notifyChatui('error', '发送失败');
            }
        } finally {
            finishChatuiComposerSend(sendToken);
        }
    };

    return (
        <form
            className="cui-root-composer"
            data-lines={singleLine ? 'single' : 'multi'}
            aria-label="ChatUI composer"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <AttachmentChips />
            <div className="cui-root-composer-row">
                <PlusMenu chatKey={chatKey} topSlot={singleLine ? selectorSlotB : undefined} />
                <textarea
                    ref={textareaRef}
                    className="cui-root-composer-input"
                    value={draft}
                    rows={singleLine ? 1 : Math.min(8, Math.max(2, draft.split('\n').length))}
                    disabled={isSending}
                    placeholder="写下这一夜……"
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        // Mirrors ST's native RossAscends-mods.js hotkeys, which key off
                        // the native #send_textarea having focus while empty — that
                        // native check goes silently inert once #send_form is
                        // display:none, so ChatUI owns the equivalent behavior here
                        // against its own composer textarea/draft state instead.
                        if (event.key === 'ArrowUp' && draft === '') {
                            event.preventDefault();
                            onEditLast?.();
                            return;
                        }

                        if (event.key !== 'Enter' || event.shiftKey) return;

                        if ((event.ctrlKey || event.metaKey) && draft.trim() === '' && !isGenerating) {
                            event.preventDefault();
                            regenerateChatuiLast(chatKey);
                            return;
                        }

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
                        {isSending
                            ? <i className="fa-solid fa-spinner fa-spin" />
                            : <span className="cui-root-send-glyph" aria-hidden="true">→</span>}
                    </button>
                )}
            </div>
            {!singleLine && selectorSlotB}
        </form>
    );
}
