import React, { useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { deleteChatuiChat, openChatuiChatForCharacter } from '../../actions.js';
import { formatConversationMeta, stripChatNameCharacterPrefix } from '../../format.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { ChatListItem } from '../../types.js';

/**
 * Safe home for abandoned new chats — now inlined into the playbill as cards
 * of their own rather than folded into a whole-cast drawer (DESIGN §4.2,
 * 原型 L47-64): dashed border, an 「未完成草稿」 tag, an italic preview, and a
 * discard entry that surfaces on hover.
 *
 * Only the container and the drawing changed. Which files these are is still
 * decided entirely by the quarantine lease (store/temp-chat-store.ts): the
 * caller hands over the leased pointers for this character, decorated with
 * listing metadata where any exists. A draft is never mixed into ordinary
 * history, and discarding one goes through the same checked delete transaction
 * as any other conversation — ST has no atomic conditional DELETE, so removing
 * the file stays an explicit user action rather than background collection
 * (STATUS.md), and it is confirmed like every other irreversible delete here.
 */
export function QuarantinedDrafts({
    drafts,
    avatar,
    characterName,
    onNavigate,
}: {
    drafts: ChatListItem[];
    avatar: string;
    characterName: string;
    onNavigate: () => void;
}): ComponentChild {
    const [discarding, setDiscarding] = useState<string | null>(null);

    if (drafts.length === 0) return null;

    // ST names a new chat 「角色名 - 时间戳」. Inside one character's playbill the
    // prefix is the column's own title repeated on every card, so it is dropped
    // and the timestamp — the only part that tells two drafts apart — is left.
    // The topbar's title has the same problem against its eyebrow and now
    // shares the strip (format.ts); what it does *afterwards* differs, and
    // deliberately: a draft card is a list of siblings and needs the stamp to
    // tell them apart, a title page is alone on screen and falls back instead.
    return (
        <>
            {drafts.map(draft => {
                const label = stripChatNameCharacterPrefix({ chatName: draft.displayName, characterName });
                const meta = formatConversationMeta(draft.messageCount, draft.lastMesLabel);
                return (
                    <li
                        key={draft.fileName}
                        className="cui-root-playbill-card cui-root-draft-card"
                        role="button"
                        tabIndex={0}
                        title={`恢复 ${draft.fileName}`}
                        onClick={() => {
                            void openChatuiChatForCharacter(avatar, draft.fileName);
                            onNavigate();
                        }}
                        onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            void openChatuiChatForCharacter(avatar, draft.fileName);
                            onNavigate();
                        }}
                    >
                        <span className="cui-root-playbill-card-binding" aria-hidden="true" />
                        <div className="cui-root-playbill-card-body">
                            <span className="cui-root-draft-card-tag">未完成草稿</span>
                            <span className="cui-root-draft-card-name">{label}</span>
                            {draft.preview && (
                                <span className="cui-root-draft-card-preview">{draft.preview}</span>
                            )}
                            {meta && <span className="cui-root-playbill-card-meta">{meta}</span>}
                        </div>
                        <div className="cui-root-playbill-card-dock">
                            <button
                                className="cui-root-playbill-card-act cui-root-playbill-card-act-danger"
                                type="button"
                                aria-label="丢弃草稿"
                                title="丢弃草稿"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setDiscarding(draft.fileName);
                                }}
                            >
                                <i className="fa-solid fa-trash-can" />
                            </button>
                        </div>
                        {discarding === draft.fileName && (
                            <ConfirmDialog
                                title="丢弃草稿"
                                message={`确定丢弃「${label}」？此操作不可撤销。`}
                                confirmLabel="丢弃"
                                danger
                                onConfirm={() => {
                                    setDiscarding(null);
                                    void deleteChatuiChat(avatar, draft.fileName);
                                }}
                                onCancel={() => setDiscarding(null)}
                            />
                        )}
                    </li>
                );
            })}
        </>
    );
}
