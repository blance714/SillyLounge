import React, { useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { openChatuiChatForCharacter, deleteChatuiChat, renameChatuiChat } from '../../actions.js';
import { isBlankConversation } from '../../blank-conversation.js';
import { formatConversationMeta, toPlainConversationPreview } from '../../format.js';
import { useCaretOnMount } from '../../hooks.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { CharConversationGroup, ChatListItem, ChatuiSidebarState } from '../../types.js';

/**
 * One conversation card in the playbill (DESIGN §4.2, 原型 L66-83): a bound
 * leaf rather than a list row — small radius, a 14px binding gutter down the
 * left, title / preview / meta stacked inside it, and an action dock that
 * surfaces on hover.
 *
 * `.cui-root-nested-chat-row` and `.cui-root-nested-chat-row-name` are kept
 * verbatim, including the `.is-current` state: the chat-switch release gate
 * (scripts/e2e/measure-chat-switch.mjs) asserts on both, and reads the name
 * element's text as the file name, so nothing else may share that element.
 */
function ConversationCard({
    chat,
    charAvatar,
    isBlank,
}: {
    chat: ChatListItem;
    charAvatar: string;
    /** Nobody has written here yet — drawn dashed, and nothing else. */
    isBlank: boolean;
}): ComponentChild {
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [renameDraft, setRenameDraft] = useState<string | null>(null);
    const isRenaming = renameDraft !== null;
    // Not `autoFocus`: it is inert for a field mounted after load, which left
    // focus sitting on the pencil button — see hooks.ts's useCaretOnMount.
    const renameRef = useCaretOnMount<HTMLInputElement>(isRenaming);

    const open = () => {
        if (isRenaming) return;
        void openChatuiChatForCharacter(charAvatar, chat.fileName);
    };

    const commitRename = () => {
        const next = (renameDraft ?? '').trim();
        setRenameDraft(null);
        // The adapter refuses an empty or unchanged name anyway; refusing here
        // too keeps a no-op keystroke from taking a slot in the host queue.
        if (!next || next === chat.displayName) return;
        void renameChatuiChat(charAvatar, chat.fileName, next);
    };

    const meta = formatConversationMeta(chat.messageCount, chat.lastMesLabel);
    // The listing hands over the message's *source*; the card is a line of
    // prose (ROADMAP B2, format.ts's toPlainConversationPreview).
    const preview = toPlainConversationPreview(chat.preview);

    return (
        <li
            className={`cui-root-playbill-card cui-root-nested-chat-row${chat.isCurrent ? ' is-current' : ''}${isBlank ? ' is-blank' : ''}`}
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={(event) => {
                if (isRenaming) return;
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    open();
                }
            }}
        >
            <span className="cui-root-playbill-card-binding" aria-hidden="true" />
            <div className="cui-root-playbill-card-body">
                {isRenaming ? (
                    <input
                        ref={renameRef}
                        className="cui-root-nested-chat-row-rename"
                        type="text"
                        value={renameDraft}
                        aria-label="重命名对话"
                        onClick={(event) => event.stopPropagation()}
                        onInput={(event) => setRenameDraft(event.currentTarget.value)}
                        onBlur={() => setRenameDraft(null)}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
                            else if (event.key === 'Escape') { event.preventDefault(); setRenameDraft(null); }
                        }}
                    />
                ) : (
                    <span className="cui-root-nested-chat-row-name">{chat.displayName}</span>
                )}
                {preview && <span className="cui-root-nested-chat-row-preview">{preview}</span>}
                {meta && <span className="cui-root-playbill-card-meta">{meta}</span>}
            </div>
            <div className="cui-root-playbill-card-dock">
                <button
                    className="cui-root-playbill-card-act"
                    type="button"
                    aria-label="重命名"
                    title="重命名"
                    onClick={(event) => { event.stopPropagation(); setRenameDraft(chat.displayName); }}
                >
                    <i className="fa-solid fa-pen" />
                </button>
                <button
                    className="cui-root-playbill-card-act cui-root-playbill-card-act-danger"
                    type="button"
                    aria-label="删除"
                    title="删除"
                    onClick={(event) => { event.stopPropagation(); setConfirmingDelete(true); }}
                >
                    <i className="fa-solid fa-trash" />
                </button>
            </div>
            {confirmingDelete && (
                <ConfirmDialog
                    title="删除对话"
                    message={`确定删除「${chat.displayName}」？此操作不可撤销。`}
                    confirmLabel="删除"
                    danger
                    onConfirm={() => {
                        setConfirmingDelete(false);
                        void deleteChatuiChat(charAvatar, chat.fileName);
                    }}
                    onCancel={() => setConfirmingDelete(false)}
                />
            )}
        </li>
    );
}

function ConversationCards({
    group,
    loadMoreCharacterChats,
    retryCharacterChats,
}: {
    group: CharConversationGroup;
    loadMoreCharacterChats: (avatar: string) => Promise<void>;
    retryCharacterChats: (avatar: string) => Promise<void>;
}): ComponentChild {
    // "Nothing has arrived yet" is a third state, not an empty column: the
    // per-character listing is fetched by an effect, so the first render after
    // a character switch has neither chats nor a pending flag. Reading that as
    // 「还没有对话」 would flash a wrong answer at every switch.
    const showLoading = group.pending === 'backfill'
        || group.pending === 'more'
        || (!group.chatsLoaded && group.pending !== 'error');
    const showMore = group.chatsLoaded && !group.fullyLoaded;
    const isEmpty = group.chats.length === 0
        && !showLoading
        && group.pending !== 'error';

    if (isEmpty) return <div className="cui-root-convlist-note">还没有对话</div>;

    return (
        <ul className="cui-root-playbill-cards">
            {group.chats.map(chat => (
                <ConversationCard
                    key={chat.fileName}
                    chat={chat}
                    charAvatar={group.avatar}
                    isBlank={isBlankConversation({
                        messageCount: chat.messageCount,
                        hasGreeting: group.hasGreeting,
                    })}
                />
            ))}
            {showLoading && (
                <li className="cui-root-convlist-status">
                    {group.pending === 'more' ? '加载更多…' : '加载中…'}
                </li>
            )}
            {group.pending === 'error' && (
                <li className="cui-root-convlist-status is-error">
                    <span>加载失败</span>
                    {/* No disabled state: pressing retry flips `pending` to
                        'backfill', which swaps this whole row for the loading
                        one, so the button cannot be pressed twice. The old
                        `disabled={pending === 'backfill'}` was unreachable for
                        exactly that reason. */}
                    <button
                        className="cui-root-convlist-retry"
                        type="button"
                        onClick={() => { void retryCharacterChats(group.avatar); }}
                    >
                        重试
                    </button>
                </li>
            )}
            {showMore && (
                <li>
                    <button
                        className="cui-root-convlist-more"
                        type="button"
                        disabled={group.pending === 'more'}
                        onClick={() => { void loadMoreCharacterChats(group.avatar); }}
                    >
                        更多
                    </button>
                </li>
            )}
        </ul>
    );
}

/**
 * Playbill body: **one** character's conversations as cards, newest first
 * (DESIGN §4.2). It is a programme, not an inbox — the whole-cast accordion it
 * replaces answered "who exists", which is now the spine's question and only
 * the spine's.
 *
 * The empty states distinguish three different absences on purpose, because
 * they call for three different next moves: nobody imported yet, nobody picked
 * yet, and this character simply has no history.
 */
export function CharacterConversationList({
    sidebar,
}: {
    sidebar: ChatuiSidebarState;
}): ComponentChild {
    const { charGroups, charGroupsError, characters, header, loadMoreCharacterChats, retryCharacterChats } = sidebar;
    const group = charGroups[0];

    const body = header.isGroup
        ? <div className="cui-root-convlist-note">群聊对话列表即将支持</div>
        : charGroupsError
            ? <div className="cui-root-convlist-note">对话列表加载失败</div>
            : characters.length === 0
                ? <div className="cui-root-convlist-note">书架还空着。请一位角色，对话会列在这里。</div>
                : !group
                    ? <div className="cui-root-convlist-note">从书脊选一位角色</div>
                    : (
                        <ConversationCards
                            group={group}
                            loadMoreCharacterChats={loadMoreCharacterChats}
                            retryCharacterChats={retryCharacterChats}
                        />
                    );

    return (
        <div className="cui-root-convlist">
            <div className="cui-root-convlist-scroll">
                {body}
            </div>
        </div>
    );
}
