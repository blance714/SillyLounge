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

/**
 * The reply that has not been written yet, standing in the stream where it will
 * appear. Design §4 gives it the same header a message has — speaker name and
 * connector — so the stream does not visibly restructure itself the moment the
 * first token lands; only the line beneath it is replaced.
 */
export function GeneratingIndicator({ name }: { name?: string }): ComponentChild {
    return (
        <div className="cui-root-generating" role="status" aria-atomic="true">
            {name && (
                <div className="cui-root-message-meta">
                    <span className="cui-root-message-name">{name}</span>
                    <span className="cui-root-message-connector" />
                </div>
            )}
            <div className="cui-root-generating-line">
                <span className="cui-root-generating-seal" aria-hidden="true" />
                <span className="cui-root-generating-label">正在酝酿……</span>
            </div>
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
    const hasDraft = draft.trim() !== '';

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
            {/* The ledger's own rule line (design §6 / DESIGN §4.4's "始终有结构
                横线"): a fixed-width left segment, the preset/model chips, and a
                hairline that fills out to the trailing edge. Single- and
                multi-line composers share this row unconditionally now — it
                replaced the old below-input selector strip that single-line mode
                used to hide/relocate into the ＋ menu, and at this row's height
                (~one chip tall) there is no longer a compact-mode reason to. */}
            <div className="cui-root-composer-deco">
                <span className="cui-root-composer-rule cui-root-composer-rule-left" aria-hidden="true" />
                <SelectorChips kinds={['preset', 'model']} />
                <span className="cui-root-composer-rule cui-root-composer-rule-right" aria-hidden="true" />
            </div>
            <AttachmentChips />
            <div className="cui-root-composer-row">
                <PlusMenu chatKey={chatKey} />
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
                            : (
                                <span
                                    className={`cui-root-send-glyph${hasDraft ? ' is-armed' : ''}`}
                                    aria-hidden="true"
                                >
                                    →
                                </span>
                            )}
                    </button>
                )}
            </div>
            {/* Design §6's bottom hint row. Its rgba(.25) contrast is below AA on
                purpose (evaluation report §6 D2) — a decorative caption, not the
                sole conveyor of the Enter/Shift+Enter behavior, so it stays as
                specified rather than getting brightened into a functional label. */}
            <div className="cui-root-composer-hint">⏎ 发送 · ⇧⏎ 换行</div>
        </form>
    );
}
