import React, { useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { openChatuiChatForCharacter, deleteChatuiChat, switchChatuiCharacter } from '../../actions.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { CharConversationGroup, ChatListItem, ChatuiSidebarState } from '../../types.js';

/**
 * Single character header row: avatar + name.
 * Clicking switches to that character (loads their last-active chat).
 */
function CharacterGroupHeader({
    group,
    onClick,
}: {
    group: CharConversationGroup;
    onClick: () => void;
}): ComponentChild {
    return (
        <button
            className="cui-root-char-group-header"
            type="button"
            title={group.name}
            onClick={onClick}
        >
            {group.thumbnailUrl
                ? <img className="cui-root-char-group-avatar" src={group.thumbnailUrl} alt="" />
                : <i className="fa-solid fa-user cui-root-char-group-avatar-fallback" />}
            <span className="cui-root-char-group-name">{group.name}</span>
        </button>
    );
}

type NestedChatRowProps = {
    chat: ChatListItem;
    charAvatar: string;
};

/**
 * Indented chat row nested under a character header.
 * Click opens that specific chat (cross-character if needed).
 * Delete is guarded by a ConfirmDialog.
 */
function NestedChatRow({ chat, charAvatar }: NestedChatRowProps): ComponentChild {
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const open = () => { void openChatuiChatForCharacter(charAvatar, chat.fileName); };

    return (
        <li
            className={`cui-root-nested-chat-row${chat.isCurrent ? ' is-current' : ''}`}
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open();
                }
            }}
        >
            <i className="fa-regular fa-message cui-root-nested-chat-row-icon" />
            <div className="cui-root-nested-chat-row-main">
                <span className="cui-root-nested-chat-row-name">{chat.displayName}</span>
                {chat.preview && <span className="cui-root-nested-chat-row-preview">{chat.preview}</span>}
            </div>
            {chat.lastMesLabel && <span className="cui-root-nested-chat-row-time">{chat.lastMesLabel}</span>}
            {chat.isCurrent && <i className="fa-solid fa-check cui-root-nested-chat-row-check" />}
            <div className="cui-root-nested-chat-row-actions">
                <button
                    className="cui-root-chat-row-act cui-root-chat-row-act-danger"
                    type="button"
                    aria-label="删除"
                    title="删除"
                    onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
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

/**
 * Playbill list body: all single characters grouped with up to 5 nested chat
 * rows each, sorted by most-recently-active.
 *
 * The feed arrives as a prop rather than from useSidebarData() here, because
 * the playbill header above this list has to count the current character's
 * conversations too — one owner of that fan-out, read in two places.
 */
export function CharacterConversationList({ sidebar }: { sidebar: ChatuiSidebarState }): ComponentChild {
    const { charGroups, charGroupsError, header, loadMoreCharacterChats, retryCharacterChats } = sidebar;

    if (header.isGroup) {
        return (
            <div className="cui-root-convlist">
                <div className="cui-root-convlist-note">群聊对话列表即将支持</div>
            </div>
        );
    }

    const body = charGroupsError
        ? <div className="cui-root-convlist-note">对话列表加载失败</div>
        : charGroups.length === 0
            ? <div className="cui-root-convlist-note">{charGroups.length === 0 ? '还没有角色' : '还没有对话'}</div>
            : (
                <div className="cui-root-chargroups">
                    {charGroups.map(group => {
                        const showLoading = group.pending === 'backfill' || group.pending === 'more';
                        const showMore = group.chatsLoaded && !group.fullyLoaded;
                        const showList = group.chats.length > 0 || showLoading || group.pending === 'error';
                        const retryDisabled = group.pending === 'backfill';
                        return (
                            <div key={group.avatar} className="cui-root-char-group">
                                <CharacterGroupHeader
                                    group={group}
                                    onClick={() => { void switchChatuiCharacter(group.avatar); }}
                                />
                                {showList && (
                                    <ul className="cui-root-char-group-chats">
                                        {group.chats.map(chat => (
                                            <NestedChatRow
                                                key={chat.fileName}
                                                chat={chat}
                                                charAvatar={group.avatar}
                                            />
                                        ))}
                                        {showLoading && (
                                            <li className="cui-root-char-group-note">
                                                {group.pending === 'more' ? '加载更多…' : '加载中…'}
                                            </li>
                                        )}
                                        {group.pending === 'error' && (
                                            <li className="cui-root-char-group-note is-error">
                                                <span>加载失败</span>
                                                <button
                                                    className="cui-root-char-group-retry"
                                                    type="button"
                                                    disabled={retryDisabled}
                                                    onClick={() => { void retryCharacterChats(group.avatar); }}
                                                >
                                                    重试
                                                </button>
                                            </li>
                                        )}
                                    </ul>
                                )}
                                {showMore && (
                                    <button
                                        className="cui-root-char-group-more"
                                        type="button"
                                        disabled={group.pending === 'more'}
                                        onClick={() => { void loadMoreCharacterChats(group.avatar); }}
                                    >
                                        更多
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            );

    return (
        <div className="cui-root-convlist">
            <div className="cui-root-convlist-scroll">
                {body}
            </div>
        </div>
    );
}
