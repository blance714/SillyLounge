import { useEffect, useState } from 'preact/compat';
import type { RefObject } from 'preact';
import { getChatuiState, subscribeChatuiStore } from '../store/chat-store.js';
import { getToasts, subscribeToasts } from '../store/toast-store.js';
import type { ChatuiMessage, ChatuiState } from './types.js';

export function useToasts(): ReturnType<typeof getToasts> {
    const [toasts, setToasts] = useState(() => getToasts());
    useEffect(() => subscribeToasts(setToasts), []);
    return toasts;
}

export function useChatuiSnapshot(): ChatuiState {
    const [state, setState] = useState<ChatuiState>(() => getChatuiState());

    useEffect(() => subscribeChatuiStore(() => {
        setState(getChatuiState());
    }), []);

    return state;
}

export function useRootDomEnhancements(
    rootRef: RefObject<HTMLElement>,
    messages: ChatuiMessage[],
    isGenerating: boolean,
): void {
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        root.querySelectorAll('.cui-root-message-body pre, .cui-root-reasoning-body pre').forEach(pre => {
            const block = pre instanceof HTMLElement ? pre : null;
            if (!block || block.querySelector('.cui-root-code-copy')) return;

            const code = block.querySelector('code');
            if (!code) return;

            const copy = document.createElement('button');
            copy.className = 'cui-root-code-copy';
            copy.type = 'button';
            copy.setAttribute('aria-label', 'Copy code');
            copy.setAttribute('title', 'Copy code');
            copy.innerHTML = '<i class="fa-regular fa-copy"></i>';
            copy.addEventListener('click', (event) => {
                event.stopPropagation();
                navigator.clipboard?.writeText?.(code.textContent ?? '')?.catch(() => {});
            });

            block.appendChild(copy);
        });

        root.scrollTop = root.scrollHeight;
    }, [rootRef, messages, isGenerating]);
}
