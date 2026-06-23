/**
 * SillyTavern-ChatUI · Preact root app
 *
 * Owns the ChatUI-rendered SPA shell under #chatui-root.
 * UI reads Store DTOs and action facades only; ST runtime details stay in adapter.
 */

import React, { useEffect, useMemo, useRef, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { createRoot } from 'preact/compat/client';
import { ensureChatuiRoot } from '../shield/st-dom-shield.js';
import { Composer, GeneratingIndicator } from './components/Composer.js';
import { MessageItem } from './components/MessageItem.js';
import { ShellDrawer } from './components/ShellDrawer.js';
import { useChatuiSnapshot, useRootDomEnhancements } from './hooks.js';
import type { ChatuiMessage, RootApi } from './types.js';

let isSetup = false;
let rootEl: HTMLElement | null = null;
let rootApi: RootApi | null = null;

function ChatuiApp(): ComponentChild {
    const state = useChatuiSnapshot();
    const rootRef = useRef<HTMLElement>(null);
    const [editingMessageId, setEditingMessageId] = useState<ChatuiMessage['id'] | null>(null);
    const [isShellOpen, setIsShellOpen] = useState(false);
    const messages = useMemo(() => state.chat.messages.filter(message => (
        !message.extra.isSmallSys && !message.extra.isToolCall
    )), [state]);

    useEffect(() => {
        if (editingMessageId === null) return;
        if (state.chat.byId[String(editingMessageId)]) return;
        setEditingMessageId(null);
    }, [editingMessageId, state.chat.byId]);

    useRootDomEnhancements(rootRef, messages, state.chat.isGenerating);

    return (
        <section ref={rootRef} className="cui-root-app" aria-label="ChatUI message root">
            <header className="cui-root-topbar">
                <button
                    className="cui-root-shell-toggle"
                    type="button"
                    aria-label="Open navigation"
                    title="Open navigation"
                    onClick={() => setIsShellOpen(true)}
                >
                    <i className="fa-solid fa-bars" />
                </button>
                <span className="cui-root-topbar-title">ChatUI</span>
            </header>
            <ShellDrawer isOpen={isShellOpen} onClose={() => setIsShellOpen(false)} />
            <div
                className="cui-root-message-list"
                role="log"
                aria-live="polite"
                aria-relevant="additions text"
            >
                {messages.map(message => (
                    <MessageItem
                        key={message.id}
                        message={message}
                        isEditing={editingMessageId === message.id}
                        onStartEdit={() => setEditingMessageId(message.id)}
                        onCancelEdit={() => setEditingMessageId(null)}
                        onSavedEdit={() => setEditingMessageId(null)}
                    />
                ))}
            </div>
            {state.chat.isGenerating && <GeneratingIndicator />}
            <div className="cui-root-empty" hidden={messages.length > 0}>
                No messages
            </div>
            <Composer isGenerating={state.chat.isGenerating} />
        </section>
    );
}

export function initChatuiRoot(): void {
    if (isSetup) return;

    rootEl = ensureChatuiRoot();
    rootEl.setAttribute('data-cui-root-mounted', '1');
    rootApi = createRoot(rootEl);
    rootApi.render(<ChatuiApp />);
    isSetup = true;
}

export function teardownChatuiRoot(): void {
    if (!isSetup) return;

    rootApi?.unmount();
    rootEl?.removeAttribute('data-cui-root-mounted');
    rootEl?.replaceChildren();

    rootApi = null;
    rootEl = null;
    isSetup = false;
}
