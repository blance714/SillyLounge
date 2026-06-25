import { useCallback, useEffect, useRef, useState } from 'preact/compat';
import type { RefObject } from 'preact';
import { getChatuiState, subscribeChatuiStore } from '../store/chat-store.js';
import { getSidebarState, subscribeSidebarStore } from '../store/sidebar-store.js';
import { getToasts, subscribeToasts } from '../store/toast-store.js';
import { getConfig, subscribeConfig } from '../store/config-store.js';
import type { ChatuiMessage, ChatuiState, ChatuiSidebarState, ChatuiConfig } from './types.js';

export function useConfig(): ChatuiConfig {
    const [config, setConfig] = useState<ChatuiConfig>(() => getConfig());

    useEffect(() => subscribeConfig(() => {
        setConfig(getConfig());
    }), []);

    return config;
}

export function useToasts(): ReturnType<typeof getToasts> {
    const [toasts, setToasts] = useState(() => getToasts());
    useEffect(() => subscribeToasts(setToasts), []);
    return toasts;
}

export function useSidebarData(): ChatuiSidebarState {
    const [state, setState] = useState<ChatuiSidebarState>(() => getSidebarState());

    useEffect(() => subscribeSidebarStore(() => {
        setState(getSidebarState());
    }), []);

    return state;
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
            if (!block) return;

            const code = block.querySelector('code');
            if (!code) return;

            // Language label (top-left) — only for fences that declared a language,
            // read off the `language-xxx` class showdown emits (ChatUI renders that
            // markdown string directly; hljs auto-detection runs on ST's own DOM, not
            // here, so undeclared fences carry no class and stay unlabelled). The
            // matching top-padding is reserved in CSS via :has() off that same class,
            // so it stays put even as innerHTML is rebuilt each streaming frame.
            if (!block.querySelector('.cui-root-code-lang')) {
                const lang = /\blanguage-([\w#+.-]+)/.exec(code.className)?.[1];
                if (lang) {
                    const label = document.createElement('span');
                    label.className = 'cui-root-code-lang';
                    label.textContent = lang;
                    block.appendChild(label);
                }
            }

            // Copy button (top-right).
            if (!block.querySelector('.cui-root-code-copy')) {
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
            }
        });
    }, [rootRef, messages, isGenerating]);
}

/** Distance (px) from the bottom within which we treat the view as "pinned". */
const AT_BOTTOM_THRESHOLD = 80;

/**
 * Auto-scroll that respects the reader. New messages/tokens only pull the view
 * to the bottom when the user is already near the bottom; if they have scrolled
 * up to read history, their position is left alone and `atBottom` flips false so
 * the caller can show a "back to bottom" affordance.
 */
export function useAutoScroll(
    rootRef: RefObject<HTMLElement>,
    messages: ChatuiMessage[],
    isGenerating: boolean,
    chatKey: string,
): { atBottom: boolean; scrollToBottom: () => void } {
    const [atBottom, setAtBottom] = useState(true);
    // Authoritative "was the user pinned to the bottom" flag, updated on scroll.
    // A ref (not state) so the content effect below reads the value from BEFORE
    // the new content grew scrollHeight.
    const wasAtBottomRef = useRef(true);
    // null sentinel so the very first render also counts as a switch → land at bottom.
    const chatKeyRef = useRef<string | null>(null);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const onScroll = () => {
            const distance = root.scrollHeight - root.scrollTop - root.clientHeight;
            const pinned = distance < AT_BOTTOM_THRESHOLD;
            wasAtBottomRef.current = pinned;
            setAtBottom(prev => (prev === pinned ? prev : pinned));
        };

        root.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
        return () => root.removeEventListener('scroll', onScroll);
    }, [rootRef]);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        // A chat switch (or first mount) always lands at the latest message,
        // regardless of where the previous chat was scrolled. An in-place
        // append/edit/stream only follows when the reader is already pinned — so
        // scrolling up to read history during streaming is never interrupted.
        const switched = chatKeyRef.current !== chatKey;
        chatKeyRef.current = chatKey;

        if (!switched && !wasAtBottomRef.current) return;
        root.scrollTop = root.scrollHeight;
        wasAtBottomRef.current = true;
        setAtBottom(true);
    }, [rootRef, messages, isGenerating, chatKey]);

    const scrollToBottom = useCallback(() => {
        const root = rootRef.current;
        if (!root) return;
        root.scrollTop = root.scrollHeight;
        wasAtBottomRef.current = true;
        setAtBottom(true);
    }, [rootRef]);

    return { atBottom, scrollToBottom };
}
