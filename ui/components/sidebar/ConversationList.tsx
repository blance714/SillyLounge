import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useSidebarData } from '../../hooks.js';
import { ChatRow } from './ChatRow.js';
import { CharacterSwitcher } from './CharacterSwitcher.js';
import { NewChatButton } from './NewChatButton.js';

/**
 * Region-5 下段 · conversation list (Mode A: single character, time-sorted).
 * Renders the current character's past chats; group chats are deferred to Mode B.
 */
export function ConversationList(): ComponentChild {
    const { header, characters, chats, loading, error } = useSidebarData();

    if (header.isGroup) {
        return (
            <div className="cui-root-convlist">
                <div className="cui-root-convlist-note">群聊对话列表即将支持</div>
            </div>
        );
    }

    const body = error
        ? <div className="cui-root-convlist-note">对话列表加载失败</div>
        : loading && chats.length === 0
            ? <div className="cui-root-convlist-note">加载中…</div>
            : chats.length === 0
                ? <div className="cui-root-convlist-note">还没有对话</div>
                : (
                    <ul className="cui-root-convlist-items">
                        {chats.map(chat => (
                            <ChatRow key={chat.fileName} chat={chat} />
                        ))}
                    </ul>
                );

    return (
        <div className="cui-root-convlist">
            <CharacterSwitcher
                characters={characters}
                currentName={header.characterName}
                currentAvatarUrl={header.avatarImgURL}
            />
            <NewChatButton disabled={!header.characterName} />
            <div className="cui-root-convlist-scroll">
                {body}
            </div>
        </div>
    );
}
