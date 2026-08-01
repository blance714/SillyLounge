/**
 * SillyTavern-ChatUI · Preact root app
 *
 * Owns the ChatUI-rendered SPA shell under #chatui-root.
 * UI reads Store DTOs and action facades only; ST runtime details stay in adapter.
 */

import React, { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { createRoot } from 'preact/compat/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { Range as VirtualRange } from '@tanstack/react-virtual';
import { ensureChatuiRoot } from '../shield/st-dom-shield.js';
import { Composer, GeneratingIndicator } from './components/Composer.js';
import { QRBar } from './components/QRBar.js';
import { NewChatCharacterPicker } from './components/composer/NewChatCharacterPicker.js';
import { MessageItem } from './components/MessageItem.js';
import { MessageFloorRail } from './components/MessageFloorRail.js';
import { MessageMenuHost } from './components/message/MessageMenuHost.js';
import { Sidebar } from './components/sidebar/Sidebar.js';
import { Spine } from './components/sidebar/Spine.js';
import { Toaster } from './components/Toaster.js';
import { ConfirmDialogHost } from './components/ConfirmDialogHost.js';
import { SettingsNav } from './components/settings/SettingsNav.js';
import { SettingsContent } from './components/settings/SettingsContent.js';
import { TopbarMenu } from './components/TopbarMenu.js';
import { TopbarTitle } from './components/TopbarTitle.js';
import { SelectorChips } from './components/SelectorChip.js';
import { useAutoScroll, useChatuiEscapeKey, useChatuiMessage, useChatuiSnapshot, useConfig, useIsTempChatActive, useSidebarBasics, useSettings, useTopbarChatTarget } from './hooks.js';
import { clearChatuiToasts, closeChatuiSettings, disableChatui, regenerateChatuiLast, renameChatuiChat, resetChatuiComposerDraftStore, resetChatuiConfirmStore, resetChatuiMenuStore, resetChatuiMessageEditDraftStore } from './actions.js';
import { teardownCardEmbedRuntime } from './card-embed.js';
import { resolveConversationTitle } from './format.js';
import { chatuiQueryClient, resetChatuiQueryClient } from './query-client.js';
import { StQueryBridge } from './use-st-query-bridge.js';
import { resolveTopbarRenameCommit } from './topbar-menu-logic.js';
import type { TopbarChatTarget } from './topbar-menu-logic.js';
import type { ChatuiMessage, MessageHeaderMode, RootApi } from './types.js';

/**
 * Assumed height of a message row the virtualizer has not measured yet. It is
 * only ever wrong — the question is by how much, and in which direction.
 *
 * Re-measured against both 400-floor e2e fixtures in the real pinned host on
 * 2026-07-31, after the corridor-theater reskin raised every row (line-height
 * 1.82 -> 1.9, 20.8px -> 26px between rows, and a header that solo chats now
 * render by default). Mean measured row height, before -> after the reskin:
 *
 *   long-plain (short turns both sides)   110px -> 135px
 *   long-rich  (assistant p50 6147 chars) 4523px -> 4719px
 *
 * So this constant is ~2.4x too large for one corpus and ~15x too small for
 * the other, and the reskin moved neither number enough to relocate it: +4.3%
 * on the realistic fixture, and on the synthetic one it moved *toward* this
 * value rather than away.
 *
 * Raising it was measured too, not assumed. One capacity-sized floor-rail jump
 * into unmeasured rows, sampling scrollTop every frame (travelled/net = how
 * much the view chases its own target before settling):
 *
 *   estimate   long-rich chase   long-rich settle   long-plain settle
 *   320        2.05x             2617ms             1366ms
 *   500        1.61x             2550ms             ~1680ms (interpolated)
 *   800        1.33x             2516ms             2200ms
 *
 * Every step toward the rich corpus buys less chase there and pays for it in
 * plain-chat jump latency, because the smooth scroll has to animate across the
 * estimated distance. There is no value in range that is simply better, which
 * is the real finding: one constant cannot serve rows spanning 130px..16000px.
 * The principled fix is an estimate that learns from what has been measured,
 * i.e. a change to the virtualizer's own configuration — out of scope for a
 * reskin, and deliberately left as the next question rather than papered over
 * by nudging this number.
 */
const VIRTUAL_MESSAGE_ESTIMATE_PX = 320;
const VIRTUAL_MESSAGE_OVERSCAN = 5;

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
    const { hasCurrentChat: canRenameTopbarTitle, target: topbarChatTarget } = useTopbarChatTarget();
    const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
    const initializedVirtualChatKeyRef = useRef<string | null>(null);
    const [editingMessage, setEditingMessage] = useState<EditingMessageTarget | null>(null);
    // Which chat the topbar's in-place rename input is open for, and its
    // draft text kept in a separate state (not nested inside the target) so
    // typing a keystroke doesn't also re-run the stale-target effect below.
    // Lifted here, not owned by TopbarTitle, because TopbarMenu's own
    // 「重命名对话」row (design §7) must be able to start this exact edit.
    const [topbarRenameTarget, setTopbarRenameTarget] = useState<TopbarChatTarget | null>(null);
    const [topbarRenameDraft, setTopbarRenameDraft] = useState('');
    const headerMode: MessageHeaderMode = state.chat.isGroup ? config.headerGroup : config.headerSolo;
    const [isSidebarMobileOpen, setIsSidebarMobileOpen] = useState(false);
    const { settingsOpen } = useSettings();
    const messageIds = state.chat.messageIds;
    const messageIndexById = useMemo(
        () => new Map(messageIds.map((messageId, index) => [messageId, index])),
        [messageIds],
    );
    const getVirtualMessageKey = useCallback(
        (index: number) => `${state.chat.chatKey}:${messageIds[index] ?? index}`,
        [messageIds, state.chat.chatKey],
    );
    // The row under edit holds uncommitted MessageEditor state (see
    // message-edit-draft-store.ts's module doc): if the default range
    // extractor lets it scroll out of the overscan window, the virtualizer
    // unmounts it like any other offscreen row. Union the editing row's
    // index into the extracted range so it is always kept mounted, however
    // far it drifts from the viewport.
    const editingMessageIndex = editingMessage?.chatKey === state.chat.chatKey
        ? messageIndexById.get(editingMessage.id) ?? null
        : null;
    const keepEditingRowMountedRangeExtractor = useCallback(
        (range: VirtualRange) => {
            const extracted = defaultRangeExtractor(range);
            if (editingMessageIndex === null || extracted.includes(editingMessageIndex)) return extracted;
            return [...extracted, editingMessageIndex].sort((a, b) => a - b);
        },
        [editingMessageIndex],
    );
    const messageVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: messageIds.length,
        getScrollElement: () => listNode,
        estimateSize: () => VIRTUAL_MESSAGE_ESTIMATE_PX,
        getItemKey: getVirtualMessageKey,
        overscan: VIRTUAL_MESSAGE_OVERSCAN,
        rangeExtractor: keepEditingRowMountedRangeExtractor,
        scrollPaddingStart: 12,
        anchorTo: 'end',
        followOnAppend: false,
        scrollEndThreshold: 80,
        useAnimationFrameWithResizeObserver: true,
    });
    const virtualMessages = messageVirtualizer.getVirtualItems();
    const messageNavigation = useMemo(() => ({
        messageIds,
        indexAtOffset: (offset: number) => messageVirtualizer.getVirtualItemForOffset(offset)?.index ?? null,
        scrollToMessage: (messageId: number, behavior: ScrollBehavior) => {
            const index = messageIndexById.get(messageId);
            if (index === undefined) return;
            messageVirtualizer.scrollToIndex(index, { align: 'start', behavior });
        },
    }), [messageIds, messageIndexById, messageVirtualizer]);
    // DESIGN §4.1's two layers. The title resolves the fallback chain in
    // format.ts (a chat ST named for itself does not count as having a name);
    // the eyebrow then steps aside whenever the title has landed on the very
    // name it would otherwise print, so the two lines can never say the same
    // thing twice.
    const conversationTitle = resolveConversationTitle(chatHeader);
    const conversationEyebrow = chatHeader.characterName && chatHeader.characterName !== conversationTitle
        ? chatHeader.characterName
        : chatHeader.isGroup ? '群组手记' : '对话手记';
    const listRef = useCallback((node: HTMLDivElement | null) => {
        setListNode(node);
    }, []);

    useLayoutEffect(() => {
        if (!listNode || messageIds.length === 0) return;
        if (initializedVirtualChatKeyRef.current === state.chat.chatKey) return;
        initializedVirtualChatKeyRef.current = state.chat.chatKey;
        messageVirtualizer.measure();
        messageVirtualizer.scrollToEnd({ behavior: 'auto' });
    }, [listNode, messageIds.length, messageVirtualizer, state.chat.chatKey]);

    useEffect(() => {
        if (editingMessage === null) return;
        if (editingMessage.chatKey === state.chat.chatKey && messageIds.includes(editingMessage.id)) return;
        setEditingMessage(null);
    }, [editingMessage, messageIds, state.chat.chatKey]);

    useEffect(() => {
        setIsSidebarMobileOpen(false);
    }, [settingsOpen, state.chat.chatKey]);

    // The reader switching chats (spine, playbill, temp-chat navigation — any
    // of them) while the topbar rename input is still open must not leave a
    // stale rename box floating over the *new* chat's title, and must never
    // let a later Enter rename the chat that is no longer on screen.
    useEffect(() => {
        if (!topbarRenameTarget) return;
        const stillLive = !!topbarChatTarget
            && topbarChatTarget.avatar === topbarRenameTarget.avatar
            && topbarChatTarget.fileName === topbarRenameTarget.fileName;
        if (stillLive) return;
        setTopbarRenameTarget(null);
        setTopbarRenameDraft('');
    }, [topbarChatTarget, topbarRenameTarget]);

    const { awayFromLatest, scrollToBottom } = useAutoScroll(listNode, messageIds, state.chat.isGenerating, state.chat.chatKey);
    useChatuiEscapeKey(state.chat.isGenerating);

    const summonSidebar = () => setIsSidebarMobileOpen(true);
    const dismissSidebarNavigation = () => setIsSidebarMobileOpen(false);
    const handleEditLast = useCallback(() => {
        const lastMessageId = messageIds[messageIds.length - 1];
        if (lastMessageId === undefined || state.chat.isGenerating) return;
        setEditingMessage({ chatKey: state.chat.chatKey, id: lastMessageId });
    }, [messageIds, state.chat.isGenerating, state.chat.chatKey]);
    const startTopbarRename = useCallback((target: TopbarChatTarget) => {
        setTopbarRenameTarget(target);
        setTopbarRenameDraft(target.displayName);
    }, []);
    const cancelTopbarRename = useCallback(() => {
        setTopbarRenameTarget(null);
        setTopbarRenameDraft('');
    }, []);
    const commitTopbarRename = useCallback(() => {
        const target = topbarRenameTarget;
        const draft = topbarRenameDraft;
        setTopbarRenameTarget(null);
        setTopbarRenameDraft('');
        if (!target) return;
        const outcome = resolveTopbarRenameCommit(target, draft, topbarChatTarget);
        if (outcome) void renameChatuiChat(outcome.avatar, outcome.fileName, outcome.nextName);
    }, [topbarRenameTarget, topbarRenameDraft, topbarChatTarget]);

    return (
        <>
            {/* The rails: spine + one of (playbill | settings nav). Desktop keeps
                both columns in flow; mobile slides the pair in as one drawer, so
                the spine is never a permanent 58px bite out of a phone screen
                (DESIGN §3). The backdrop is a sibling, not a child — it must not
                ride the wrapper's own translate. */}
            {isSidebarMobileOpen && !settingsOpen && (
                <button
                    className="cui-root-sidebar-backdrop"
                    type="button"
                    aria-label="收起侧栏"
                    onClick={() => setIsSidebarMobileOpen(false)}
                />
            )}
            <div
                className={`cui-root-rails${isSidebarMobileOpen && !settingsOpen ? ' is-mobile-open' : ''}${settingsOpen ? ' is-settings' : ''}`}
            >
                <Spine onNavigate={dismissSidebarNavigation} />
                {settingsOpen
                    ? <SettingsNav />
                    : <Sidebar
                          onClose={() => setIsSidebarMobileOpen(false)}
                          onNavigate={dismissSidebarNavigation}
                          isTempChatActive={isTempChatActive}
                      />
                }
            </div>
            {settingsOpen
                ? <SettingsContent />
                : <section className="cui-root-app" aria-label="ChatUI message root">
                      <header className="cui-root-topbar">
                          <button
                              className="cui-root-shell-toggle cui-root-shell-hamburger"
                              type="button"
                              aria-label="打开侧栏"
                              title="打开侧栏"
                              onClick={summonSidebar}
                          >
                              <i className="fa-solid fa-bars" />
                          </button>
                          <TopbarTitle
                              title={conversationTitle}
                              eyebrow={conversationEyebrow}
                              canRename={canRenameTopbarTitle}
                              isRenaming={topbarRenameTarget !== null}
                              draft={topbarRenameDraft}
                              onStartRename={() => {
                                  if (topbarChatTarget) startTopbarRename(topbarChatTarget);
                              }}
                              onDraftChange={setTopbarRenameDraft}
                              onCommit={commitTopbarRename}
                              onCancel={cancelTopbarRename}
                          />
                          <div className="cui-root-topbar-tools">
                              <SelectorChips kinds={['persona']} />
                              <TopbarMenu onStartRename={startTopbarRename} />
                          </div>
                      </header>
                      <div className="cui-root-message-stage">
                          <MessageFloorRail
                              root={listNode}
                              turns={state.chat.userTurns}
                              navigation={messageNavigation}
                          />
                          <div
                              ref={listRef}
                              className="cui-root-message-list"
                              role="log"
                              aria-live="polite"
                              aria-relevant="additions text"
                              data-cui-virtual-count={String(messageIds.length)}
                              data-cui-virtual-start={String(virtualMessages[0]?.index ?? -1)}
                              data-cui-virtual-end={String(
                                  virtualMessages[virtualMessages.length - 1]?.index ?? -1,
                              )}
                          >
                              <div
                                  className="cui-root-virtual-message-space"
                                  style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
                              >
                                  {virtualMessages.map(virtualMessage => {
                                      const messageId = messageIds[virtualMessage.index];
                                      if (messageId === undefined) return null;
                                      return (
                                          <div
                                              key={virtualMessage.key}
                                              ref={messageVirtualizer.measureElement}
                                              className="cui-root-virtual-message-row"
                                              data-index={virtualMessage.index}
                                              style={{ transform: `translateY(${virtualMessage.start}px)` }}
                                          >
                                              <ChatuiMessageRow
                                                  messageId={messageId}
                                                  headerMode={headerMode}
                                                  isGenerating={state.chat.isGenerating}
                                                  isEditing={editingMessage?.chatKey === state.chat.chatKey && editingMessage.id === messageId}
                                                  onStartEdit={() => setEditingMessage({ chatKey: state.chat.chatKey, id: messageId })}
                                                  onFinishEdit={() => setEditingMessage(null)}
                                              />
                                          </div>
                                      );
                                  })}
                              </div>
                              {state.chat.isGenerating && (
                                  <GeneratingIndicator name={chatHeader.characterName} />
                              )}
                          </div>
                          <div className="cui-root-empty" hidden={messageIds.length > 0}>
                              <span className="cui-root-empty-title">台上还空着</span>
                              <span className="cui-root-empty-note">写下第一楼，这一场就开了。</span>
                          </div>
                          {/* The label is the accessible name: no aria-label, so the
                              two can never drift apart. */}
                          <button
                              className="cui-root-scroll-bottom"
                              type="button"
                              hidden={!awayFromLatest}
                              onClick={scrollToBottom}
                          >
                              <i className="fa-solid fa-angles-down" aria-hidden="true" />
                              回到最新
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
            {/* The message ⋯ menu is drawn here, not by the row whose button
                opened it: that row lives in the virtualiser and is unmounted
                whenever it leaves the overscan window, which is not a moment
                the reader chose (MessageMenuHost's own doc has the full
                argument). It still portals to document.body from here. */}
            <MessageMenuHost />
            <Toaster />
            <ConfirmDialogHost />
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
        resetChatuiConfirmStore,
        resetChatuiComposerDraftStore,
        resetChatuiMessageEditDraftStore,
        resetChatuiMenuStore,
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
