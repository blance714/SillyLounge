/**
 * SillyTavern-ChatUI · Preact root app
 *
 * Owns the ChatUI-rendered SPA shell under #chatui-root.
 * UI reads Store DTOs and action facades only; ST runtime details stay in adapter.
 */

import React, { Component, useCallback, useEffect, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { createRoot } from 'preact/compat/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { ensureChatuiRoot } from '../shield/st-dom-shield.js';
import { Composer, GeneratingIndicator } from './components/Composer.js';
import { QRBar } from './components/QRBar.js';
import { NewChatCharacterPicker } from './components/composer/NewChatCharacterPicker.js';
import { MessageItem } from './components/MessageItem.js';
import { MessageFloorRail } from './components/MessageFloorRail.js';
import { Sidebar } from './components/sidebar/Sidebar.js';
import { Toaster } from './components/Toaster.js';
import { SettingsNav } from './components/settings/SettingsNav.js';
import { SettingsContent } from './components/settings/SettingsContent.js';
import { TopbarMenu } from './components/TopbarMenu.js';
import { SelectorChips } from './components/SelectorChip.js';
import { useAutoScroll, useChatuiMessage, useChatuiSnapshot, useConfig, useEscapeToStopGeneration, useIsTempChatActive, useSidebarBasics, useSettings } from './hooks.js';
import { clearChatuiToasts, closeChatuiSettings, disableChatui, regenerateChatuiLast, resetChatuiComposerDraftStore } from './actions.js';
import { teardownCardEmbedRuntime } from './card-embed.js';
import { chatuiQueryClient, resetChatuiQueryClient } from './query-client.js';
import { StQueryBridge } from './use-st-query-bridge.js';
import type { ChatuiMessage, MessageHeaderMode, RootApi } from './types.js';

let isSetup = false;
let rootEl: HTMLElement | null = null;
let rootApi: RootApi | null = null;

type EditingMessageTarget = {
    chatKey: string;
    id: ChatuiMessage['id'];
};

class ChatuiErrorBoundary extends Component<
    { children: ComponentChild },
    { failed: boolean }
> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(error: unknown): void {
        console.error('[ChatUI] render failed; restoring the native SillyTavern UI', error);
        // Avoid unmounting the root re-entrantly from Preact's error lifecycle.
        queueMicrotask(() => disableChatui());
    }

    render(): ComponentChild {
        return this.state.failed ? null : this.props.children;
    }
}

function ChatuiMessageRow({
    messageId,
    headerMode,
    isGenerating,
    isEditing,
    onStartEdit,
    onFinishEdit,
}: {
    messageId: number;
    headerMode: MessageHeaderMode;
    isGenerating: boolean;
    isEditing: boolean;
    onStartEdit: () => void;
    onFinishEdit: () => void;
}): ComponentChild {
    const message = useChatuiMessage(messageId);
    if (!message) return null;
    return (
        <MessageItem
            message={message}
            headerMode={headerMode}
            isGenerating={isGenerating}
            isEditing={isEditing}
            onStartEdit={onStartEdit}
            onCancelEdit={onFinishEdit}
            onSavedEdit={onFinishEdit}
        />
    );
}

function ChatuiApp(): ComponentChild {
    const state = useChatuiSnapshot();
    const config = useConfig();
    // Title comes from the sidebar store (single source for chat header; it also
    // tracks rename/delete events, so the title never goes stale).
    const sidebarBasics = useSidebarBasics();
    const chatHeader = sidebarBasics.header;
    const isTempChatActive = useIsTempChatActive();
    const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
    const [editingMessage, setEditingMessage] = useState<EditingMessageTarget | null>(null);
    const headerMode: MessageHeaderMode = state.chat.isGroup ? config.headerGroup : config.headerSolo;
    const [isSidebarMobileOpen, setIsSidebarMobileOpen] = useState(false);
    const { settingsOpen } = useSettings();
    const messageIds = state.chat.messageIds;
    const conversationTitle = chatHeader.sessionName || chatHeader.characterName || 'ChatUI';
    const conversationEyebrow = chatHeader.characterName && chatHeader.characterName !== conversationTitle
        ? chatHeader.characterName
        : chatHeader.isGroup ? '群组手记' : '对话手记';
    const listRef = useCallback((node: HTMLDivElement | null) => {
        setListNode(node);
    }, []);

    useEffect(() => {
        if (editingMessage === null) return;
        if (editingMessage.chatKey === state.chat.chatKey && messageIds.includes(editingMessage.id)) return;
        setEditingMessage(null);
    }, [editingMessage, messageIds, state.chat.chatKey]);

    useEffect(() => {
        setIsSidebarMobileOpen(false);
    }, [settingsOpen, state.chat.chatKey]);

    const { atBottom, scrollToBottom } = useAutoScroll(listNode, messageIds, state.chat.isGenerating, state.chat.chatKey);
    useEscapeToStopGeneration(state.chat.isGenerating);

    const summonSidebar = () => setIsSidebarMobileOpen(true);
    const dismissSidebarNavigation = () => setIsSidebarMobileOpen(false);
    const handleEditLast = useCallback(() => {
        const lastMessageId = messageIds[messageIds.length - 1];
        if (lastMessageId === undefined || state.chat.isGenerating) return;
        setEditingMessage({ chatKey: state.chat.chatKey, id: lastMessageId });
    }, [messageIds, state.chat.isGenerating, state.chat.chatKey]);

    return (
        <>
            {settingsOpen
                ? <SettingsNav />
                : <Sidebar
                      mobileOpen={isSidebarMobileOpen}
                      onClose={() => setIsSidebarMobileOpen(false)}
                      onNavigate={dismissSidebarNavigation}
                      isTempChatActive={isTempChatActive}
                  />
            }
            {settingsOpen
                ? <SettingsContent />
                : <section className="cui-root-app" aria-label="ChatUI message root">
                      <header className="cui-root-topbar">
                          <button
                              className="cui-root-shell-toggle cui-root-shell-hamburger"
                              type="button"
                              aria-label="Open navigation"
                              title="Open navigation"
                              onClick={summonSidebar}
                          >
                              <i className="fa-solid fa-bars" />
                          </button>
                          <div className="cui-root-topbar-heading">
                              <span className="cui-root-topbar-eyebrow">{conversationEyebrow}</span>
                              <h1 className="cui-root-topbar-title">{conversationTitle}</h1>
                          </div>
                          <div className="cui-root-topbar-tools">
                              <SelectorChips kinds={['persona']} />
                              <TopbarMenu />
                          </div>
                      </header>
                      <div className="cui-root-message-stage">
                          <MessageFloorRail root={listNode} turns={state.chat.userTurns} />
                          <div
                              ref={listRef}
                              className="cui-root-message-list"
                              role="log"
                              aria-live="polite"
                              aria-relevant="additions text"
                          >
                              {messageIds.map(messageId => (
                                  <ChatuiMessageRow
                                      key={`${state.chat.chatKey}:${messageId}`}
                                      messageId={messageId}
                                      headerMode={headerMode}
                                      isGenerating={state.chat.isGenerating}
                                      isEditing={editingMessage?.chatKey === state.chat.chatKey && editingMessage.id === messageId}
                                      onStartEdit={() => setEditingMessage({ chatKey: state.chat.chatKey, id: messageId })}
                                      onFinishEdit={() => setEditingMessage(null)}
                                  />
                              ))}
                              {state.chat.isGenerating && <GeneratingIndicator />}
                          </div>
                          <div className="cui-root-empty" hidden={messageIds.length > 0}>
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
                      </div>
                      {state.chat.lastMessageNeedsGenerate && !state.chat.isGenerating && (
                          <div className="cui-root-generate-bar">
                              <button
                                  className="cui-root-generate-btn"
                                  type="button"
                                  onClick={() => regenerateChatuiLast(state.chat.chatKey)}
                              >
                                  <i className="fa-solid fa-rotate-right" />
                                  <span>生成回复</span>
                              </button>
                          </div>
                      )}
                      <QRBar chatKey={state.chat.chatKey} />
                      {isTempChatActive && (
                          <NewChatCharacterPicker
                              characters={sidebarBasics.characters}
                              getDraftSnapshot={sidebarBasics.getDraftSnapshot}
                              isGenerating={state.chat.isGenerating}
                          />
                      )}
                      <Composer
                          chatKey={state.chat.chatKey}
                          isGenerating={state.chat.isGenerating}
                          onEditLast={handleEditLast}
                      />
                  </section>
            }
            <Toaster />
        </>
    );
}

export function initChatuiRoot(): void {
    if (isSetup) return;

    rootEl = ensureChatuiRoot();
    rootEl.setAttribute('data-cui-root-mounted', '1');
    rootApi = createRoot(rootEl);
    rootApi.render(
        <ChatuiErrorBoundary>
            <QueryClientProvider client={chatuiQueryClient}>
                <StQueryBridge />
                <ChatuiApp />
            </QueryClientProvider>
        </ChatuiErrorBoundary>,
    );
    isSetup = true;
}

export function teardownChatuiRoot(): void {
    isSetup = false;

    // Every cleanup is best-effort: this function is also the rollback path for
    // a partially-mounted root, so one failure must not strand other resources.
    const cleanups: Array<() => void> = [
        closeChatuiSettings,
        clearChatuiToasts,
        resetChatuiComposerDraftStore,
        () => rootApi?.unmount(),
        resetChatuiQueryClient,
        teardownCardEmbedRuntime,
        () => rootEl?.removeAttribute('data-cui-root-mounted'),
        () => rootEl?.replaceChildren(),
    ];
    for (const cleanup of cleanups) {
        try {
            cleanup();
        } catch (error) {
            console.error('[ChatUI] root cleanup failed', error);
        }
    }

    rootApi = null;
    rootEl = null;
}
