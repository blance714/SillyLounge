import React, { useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { openChatuiChatForCharacter, deleteChatuiChat, switchChatuiCharacter } from '../../actions.js';
import { useSidebarData, useTempChat } from '../../hooks.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { CharConversationGroup, ChatListItem } from '../../types.js';

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
 * Region-5 conversation list: all single characters grouped with up to 5
 * nested chat rows each, sorted by most-recently-active. Replaces ConversationList.
 */
export function CharacterConversationList(): ComponentChild {
    const { charGroups, charGroupsLoading, charGroupsError, header } = useSidebarData();
    const tempChat = useTempChat();
    const visibleGroups = charGroups.map(group => ({
        ...group,
        chats: group.chats.filter(chat => !(
            tempChat
            && group.avatar === tempChat.avatar
            && chat.fileName === tempChat.fileName
        )),
    }));

    if (header.isGroup) {
        return (
            <div className="cui-root-convlist">
                <div className="cui-root-convlist-note">群聊对话列表即将支持</div>
            </div>
        );
    }

    const body = charGroupsError
        ? <div className="cui-root-convlist-note">对话列表加载失败</div>
        : (charGroupsLoading && charGroups.length === 0)
            ? <div className="cui-root-convlist-note">加载中…</div>
            : visibleGroups.length === 0
                ? <div className="cui-root-convlist-note">{charGroups.length === 0 ? '还没有角色' : '还没有对话'}</div>
                : (
                    <div className="cui-root-chargroups">
                        {visibleGroups.map(group => (
                            <div key={group.avatar} className="cui-root-char-group">
                                <CharacterGroupHeader
                                    group={group}
                                    onClick={() => { void switchChatuiCharacter(group.avatar); }}
                                />
                                {group.chats.length > 0 && (
                                    <ul className="cui-root-char-group-chats">
                                        {group.chats.map(chat => (
                                            <NestedChatRow
                                                key={chat.fileName}
                                                chat={chat}
                                                charAvatar={group.avatar}
                                            />
                                        ))}
                                    </ul>
                                )}
                            </div>
                        ))}
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
