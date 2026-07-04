/**
 * SillyTavern-ChatUI · Preact root app
 *
 * Owns the ChatUI-rendered SPA shell under #chatui-root.
 * UI reads Store DTOs and action facades only; ST runtime details stay in adapter.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { createRoot } from 'preact/compat/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { ensureChatuiRoot } from '../shield/st-dom-shield.js';
import { Composer, GeneratingIndicator } from './components/Composer.js';
import { QRBar } from './components/QRBar.js';
import { NewChatCharacterPicker } from './components/composer/NewChatCharacterPicker.js';
import { MessageItem } from './components/MessageItem.js';
import { Sidebar } from './components/sidebar/Sidebar.js';
import { Toaster } from './components/Toaster.js';
import { SettingsNav } from './components/settings/SettingsNav.js';
import { SettingsContent } from './components/settings/SettingsContent.js';
import { TopbarMenu } from './components/TopbarMenu.js';
import { SelectorChips } from './components/SelectorChip.js';
import { useAutoScroll, useCardEmbedRendering, useChatuiSnapshot, useConfig, useIsTempChatActive, useRootDomEnhancements, useSidebarBasics, useSettings } from './hooks.js';
import { clearChatuiToasts, closeChatuiSettings, regenerateChatuiLast } from './actions.js';
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

function ChatuiApp(): ComponentChild {
    const state = useChatuiSnapshot();
    const config = useConfig();
    // Title comes from the sidebar store (single source for chat header; it also
    // tracks rename/delete events, so the title never goes stale).
    const sidebarBasics = useSidebarBasics();
    const chatHeader = sidebarBasics.header;
    const isTempChatActive = useIsTempChatActive();
    const [rootNode, setRootNode] = useState<HTMLElement | null>(null);
    const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
    const [editingMessage, setEditingMessage] = useState<EditingMessageTarget | null>(null);
    const headerMode: MessageHeaderMode = state.chat.isGroup ? config.headerGroup : config.headerSolo;
    const [isSidebarMobileOpen, setIsSidebarMobileOpen] = useState(false);
    const { settingsOpen } = useSettings();
    const messages = useMemo(() => state.chat.messages.filter(message => (
        !message.extra.isSmallSys && !message.extra.isToolCall
    )), [state]);
    const rootRef = useCallback((node: HTMLElement | null) => {
        setRootNode(node);
    }, []);
    const listRef = useCallback((node: HTMLDivElement | null) => {
        setListNode(node);
    }, []);

    useEffect(() => {
        if (editingMessage === null) return;
        if (editingMessage.chatKey === state.chat.chatKey && state.chat.byId[String(editingMessage.id)]) return;
        setEditingMessage(null);
    }, [editingMessage, state.chat.byId, state.chat.chatKey]);

    useEffect(() => {
        setIsSidebarMobileOpen(false);
    }, [settingsOpen, state.chat.chatKey]);

    useRootDomEnhancements(rootNode, messages, state.chat.isGenerating);
    useCardEmbedRendering(rootNode, messages, state.chat.isGenerating);
    const { atBottom, scrollToBottom } = useAutoScroll(listNode, messages, state.chat.isGenerating, state.chat.chatKey);

    const summonSidebar = () => setIsSidebarMobileOpen(true);
    const dismissSidebarNavigation = () => setIsSidebarMobileOpen(false);

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
                : <section ref={rootRef} className="cui-root-app" aria-label="ChatUI message root">
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
                              {chatHeader.characterName || chatHeader.sessionName || 'ChatUI'}
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
                                  key={`${state.chat.chatKey}:${message.id}`}
                                  message={message}
                                  headerMode={headerMode}
                                  isEditing={editingMessage?.chatKey === state.chat.chatKey && editingMessage.id === message.id}
                                  onStartEdit={() => setEditingMessage({ chatKey: state.chat.chatKey, id: message.id })}
                                  onCancelEdit={() => setEditingMessage(null)}
                                  onSavedEdit={() => setEditingMessage(null)}
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
                      {isTempChatActive && (
                          <NewChatCharacterPicker
                              characters={sidebarBasics.characters}
                              getDraftSnapshot={sidebarBasics.getDraftSnapshot}
                              isGenerating={state.chat.isGenerating}
                          />
                      )}
                      <Composer isGenerating={state.chat.isGenerating} />
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
        <QueryClientProvider client={chatuiQueryClient}>
            <StQueryBridge />
            <ChatuiApp />
        </QueryClientProvider>,
    );
    isSetup = true;
}

export function teardownChatuiRoot(): void {
    if (!isSetup) return;

    // The ui-store is a module singleton that outlives the Preact tree, so reset
    // the settings mode flag here — a disable→re-enable cycle should start clean.
    closeChatuiSettings();
    clearChatuiToasts();
    rootApi?.unmount();
    resetChatuiQueryClient();
    rootEl?.removeAttribute('data-cui-root-mounted');
    rootEl?.replaceChildren();

    rootApi = null;
    rootEl = null;
    isSetup = false;
}
