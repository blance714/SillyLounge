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
import { QRBar } from './components/QRBar.js';
import { MessageItem } from './components/MessageItem.js';
import { Sidebar } from './components/sidebar/Sidebar.js';
import type { SidebarForm } from './components/sidebar/Sidebar.js';
import { Toaster } from './components/Toaster.js';
import { TopbarMenu } from './components/TopbarMenu.js';
import { SelectorChips } from './components/SelectorChip.js';
import { useAutoScroll, useChatuiSnapshot, useConfig, useRootDomEnhancements } from './hooks.js';
import { cycleChatuiSidebarForm, regenerateChatuiLast, setChatuiSidebarForm } from './actions.js';
import type { ChatuiMessage, MessageHeaderMode, RootApi } from './types.js';

let isSetup = false;
let rootEl: HTMLElement | null = null;
let rootApi: RootApi | null = null;

function ChatuiApp(): ComponentChild {
    const state = useChatuiSnapshot();
    const config = useConfig();
    const rootRef = useRef<HTMLElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [editingMessageId, setEditingMessageId] = useState<ChatuiMessage['id'] | null>(null);
    const sidebarForm: SidebarForm = config.sidebarForm;
    const headerMode: MessageHeaderMode = state.chat.isGroup ? config.headerGroup : config.headerSolo;
    const [isSidebarMobileOpen, setIsSidebarMobileOpen] = useState(false);
    const messages = useMemo(() => state.chat.messages.filter(message => (
        !message.extra.isSmallSys && !message.extra.isToolCall
    )), [state]);

    useEffect(() => {
        if (editingMessageId === null) return;
        if (state.chat.byId[String(editingMessageId)]) return;
        setEditingMessageId(null);
    }, [editingMessageId, state.chat.byId]);

    useRootDomEnhancements(rootRef, messages, state.chat.isGenerating);
    const { atBottom, scrollToBottom } = useAutoScroll(listRef, messages, state.chat.isGenerating, state.chat.chatKey);

    // ☰ = "summon list ①": expand to the full form (desktop) and open the
    // overlay (mobile). One handler works for both — the irrelevant effect is a
    // no-op at each breakpoint (CSS-gated). Resetting to 'list' is intentional:
    // tapping the hamburger always reveals the full conversation list first.
    const summonSidebar = () => {
        setChatuiSidebarForm('list');
        setIsSidebarMobileOpen(true);
    };

    return (
        <>
            <Sidebar
                form={sidebarForm}
                onCycleForm={cycleChatuiSidebarForm}
                mobileOpen={isSidebarMobileOpen}
                onClose={() => setIsSidebarMobileOpen(false)}
            />
            <section ref={rootRef} className="cui-root-app" aria-label="ChatUI message root">
                <header className="cui-root-topbar">
                    <button
                        className="cui-root-shell-toggle"
                        type="button"
                        aria-label="Open navigation"
                        title="Open navigation"
                        onClick={summonSidebar}
                    >
                        <i className="fa-solid fa-bars" />
                    </button>
                    <SelectorChips kinds={['persona']} />
                    <span className="cui-root-topbar-title">
                        {state.chat.chatHeader.characterName || state.chat.chatHeader.sessionName || 'ChatUI'}
                    </span>
                    <TopbarMenu />
                </header>
                <div
                    ref={listRef}
                    className="cui-root-message-list"
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions text"
                >
                    {messages.map(message => (
                        <MessageItem
                            key={message.id}
                            message={message}
                            headerMode={headerMode}
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
                <button
                    className="cui-root-scroll-bottom"
                    type="button"
                    hidden={atBottom}
                    aria-label="回到底部"
                    title="回到底部"
                    onClick={scrollToBottom}
                >
                    <i className="fa-solid fa-arrow-down" />
                </button>
                {state.chat.lastMessageNeedsGenerate && !state.chat.isGenerating && (
                    <div className="cui-root-generate-bar">
                        <button
                            className="cui-root-generate-btn"
                            type="button"
                            onClick={regenerateChatuiLast}
                        >
                            <i className="fa-solid fa-rotate-right" />
                            <span>生成回复</span>
                        </button>
                    </div>
                )}
                <QRBar />
                <Composer isGenerating={state.chat.isGenerating} />
                <Toaster />
            </section>
        </>
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
