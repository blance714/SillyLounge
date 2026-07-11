/**
 * SillyTavern-ChatUI · composer adapter
 */

import {
    eventSource,
    event_types,
    extractMessageBias,
    isGenerating,
    removeMacros,
    sendTextareaMessage,
    stopGeneration as stopStGeneration,
    swipeState,
} from '@st/script';
import { hasPendingFileAttachment } from '@st/chats';
import { isExecutingCommandsFromChatInput } from '@st/slash-commands';
import { getCurrentChat, getCurrentChatKey } from './internals.js';

export type ComposerSendOperation = Promise<void> & Readonly<{
    /** Full ST generation lifecycle; may reject after the user message was accepted. */
    completion: Promise<unknown>;
}>;

type AcceptanceGate = {
    accepted: Promise<void>;
    cancel: () => void;
    label: 'USER_MESSAGE_RENDERED' | 'SLASH_INPUT_CLEARED';
};

/**
 * @returns {HTMLTextAreaElement|null}
 */
export function getNativeComposerTextarea(): HTMLTextAreaElement | null {
    return document.getElementById('send_textarea') as HTMLTextAreaElement | null;
}

/**
 * @param {string} text
 * @returns {void}
 */
export function setNativeComposerText(text: string) {
    const textarea = getNativeComposerTextarea();
    if (!textarea) throw new Error('[ChatUI/adapter] Native composer textarea not found');

    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

/**
 * Wait for the host-side acceptance event belonging to this send. Normal user
 * messages commit only after the newly-appended user row is rendered. Slash
 * commands use a separate native input-ownership gate; completion-only inputs
 * are handled by the caller.
 */
function _createAcceptanceGate(): AcceptanceGate {
    const expectedChatKey = getCurrentChatKey();
    const initialMessageCount = getCurrentChat().length;
    const eventType = event_types.USER_MESSAGE_RENDERED;
    let handler: (...args: any[]) => void = () => undefined;
    let settled = false;

    const cleanup = () => {
        eventSource.removeListener(eventType, handler);
    };

    const accepted = new Promise<void>((resolve, reject) => {
        handler = (messageId: unknown) => {
            if (getCurrentChatKey() !== expectedChatKey) return;
            const id = Number(messageId);
            if (!Number.isInteger(id) || id !== initialMessageCount) return;
            const rawMessage = getCurrentChat()[id];
            if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) return;
            if ((rawMessage as Record<string, unknown>).is_user !== true) return;
            settled = true;
            cleanup();
            resolve();
        };

        try {
            eventSource.on(eventType, handler);
        } catch (error) {
            settled = true;
            cleanup();
            reject(error);
            return;
        }
    });

    return {
        accepted,
        label: 'USER_MESSAGE_RENDERED',
        cancel: () => {
            if (settled) return;
            settled = true;
            cleanup();
        },
    };
}

/**
 * ST's slash wrapper resolves normally even when a competing slash pipeline
 * makes command execution return `null`. Actual ownership has one observable
 * synchronous commit boundary: executeSlashCommandsOnChatInput clears the exact
 * native textarea while its busy flag is true. Require that boundary rather
 * than treating Generate completion as command acceptance.
 */
function _createSlashAcceptanceGate(): AcceptanceGate {
    const expectedChatKey = getCurrentChatKey();
    const textarea = getNativeComposerTextarea();
    if (!textarea) throw new Error('[ChatUI/adapter] Native composer textarea not found');
    let settled = false;
    let handler: () => void = () => undefined;
    const cleanup = () => textarea.removeEventListener('input', handler);
    const accepted = new Promise<void>((resolve) => {
        handler = () => {
            if (getCurrentChatKey() !== expectedChatKey) return;
            if (!isExecutingCommandsFromChatInput || textarea.value !== '') return;
            settled = true;
            cleanup();
            resolve();
        };
        textarea.addEventListener('input', handler);
    });
    return {
        accepted,
        label: 'SLASH_INPUT_CLEARED',
        cancel: () => {
            if (settled) return;
            settled = true;
            cleanup();
        },
    };
}

/**
 * The returned thenable resolves when ST accepts the send, allowing the caller
 * to clear its draft immediately. `operation.completion` remains available to
 * observe the later model-generation result independently.
 */
export function sendComposerMessage(text: string): ComposerSendOperation {
    const assertComposerAvailable = () => {
        if (isGenerating() || swipeState !== 'none' || isExecutingCommandsFromChatInput) {
            throw new Error('[ChatUI/adapter] ST composer is busy');
        }
    };
    assertComposerAvailable();
    const expectedChatKey = getCurrentChatKey();
    const initialMessageCount = getCurrentChat().length;
    setNativeComposerText(text);
    const isCommand = text.trimStart().startsWith('/');
    const waitsForCompletionOnly = !isCommand && text === '' && !hasPendingFileAttachment();
    let isBiasOnly = false;
    if (!isCommand && text !== '') {
        try {
            isBiasOnly = Boolean(extractMessageBias(text)) && !removeMacros(text);
        } catch (error) {
            console.error('[ChatUI/adapter] failed to classify composer bias input', error);
        }
    }
    const gate = waitsForCompletionOnly
        ? null
        : isCommand
            ? _createSlashAcceptanceGate()
            : _createAcceptanceGate();

    let completion: Promise<unknown>;
    try {
        // Recheck after native input/change listeners but immediately before the
        // synchronous host call. ST otherwise resolves silent no-op branches,
        // which must never clear a slash or message draft as "accepted".
        assertComposerAvailable();
        completion = Promise.resolve(sendTextareaMessage());
    } catch (error) {
        completion = Promise.reject(error);
    }

    // Existing callers only await acceptance. Mark the independent completion
    // branch handled while preserving its rejection for explicit awaiters.
    void completion.catch(() => undefined);
    const acceptsBiasSystemMessage = () => {
        if (getCurrentChatKey() !== expectedChatKey) return false;
        const rawMessage = getCurrentChat()[initialMessageCount];
        if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) return false;
        const record = rawMessage as Record<string, unknown>;
        const extra = record.extra && typeof record.extra === 'object' && !Array.isArray(record.extra)
            ? record.extra as Record<string, unknown>
            : null;
        return record.is_system === true && typeof extra?.bias === 'string' && extra.bias.length > 0;
    };
    const biasAcceptance = () => completion.then(
        () => {
            if (!acceptsBiasSystemMessage()) {
                throw new Error('[ChatUI/adapter] ST send completed without bias-message acceptance');
            }
        },
        (error: unknown) => {
            // ST inserts a bias system row only in memory and may never save it
            // when generation fails. Preserve the draft unless completion proves
            // the host accepted the whole operation.
            throw error;
        },
    );
    const accepted = (waitsForCompletionOnly
        ? completion.then(() => undefined)
        : isCommand
            ? Promise.race([
                gate!.accepted,
                completion.then(
                    () => { throw new Error(`[ChatUI/adapter] ST send completed without acceptance: ${gate!.label}`); },
                    (error: unknown) => { throw error; },
                ),
            ]).finally(gate!.cancel)
        : isBiasOnly
            ? Promise.race([gate!.accepted, biasAcceptance()]).finally(gate!.cancel)
        : Promise.race([
            gate!.accepted,
            completion.then(
                () => { throw new Error(`[ChatUI/adapter] ST send completed without acceptance: ${gate!.label}`); },
                (error: unknown) => { throw error; },
            ),
        ]).finally(gate!.cancel)
    ) as ComposerSendOperation;
    Object.defineProperty(accepted, 'completion', {
        configurable: false,
        enumerable: true,
        value: completion,
        writable: false,
    });
    return accepted;
}

/**
 * @returns {boolean} true if an active generation was stopped
 */
export function stopGeneration() {
    return stopStGeneration();
}
