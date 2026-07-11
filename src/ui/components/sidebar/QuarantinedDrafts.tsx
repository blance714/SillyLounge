import React, { useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { openChatuiChatForCharacter } from '../../actions.js';
import { useCurrentChatIdentity, useTempChats } from '../../hooks.js';
import type { CharacterSummary } from '../../types.js';

/**
 * Safe home for abandoned new chats. They remain recoverable and explicitly
 * user-deletable after opening, without publishing into ordinary history.
 */
export function QuarantinedDrafts({
    characters,
    onNavigate,
}: {
    characters: CharacterSummary[];
    onNavigate: () => void;
}): ComponentChild {
    const tempChats = useTempChats();
    const current = useCurrentChatIdentity();
    const [expanded, setExpanded] = useState(false);
    const dormant = tempChats.filter(pointer => (
        pointer.avatar !== current?.avatar || pointer.fileName !== current.fileName
    ));

    if (dormant.length === 0) return null;
    const names = new Map(characters.map(character => [character.avatar, character.name]));

    return (
        <div className="cui-root-draft-shelf">
            <button
                className="cui-root-draft-shelf-toggle"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded(value => !value)}
            >
                <span>未完成草稿</span>
                <span className="cui-root-draft-shelf-count">{dormant.length}</span>
                <i className={`fa-solid fa-chevron-${expanded ? 'up' : 'down'}`} aria-hidden="true" />
            </button>
            {expanded && (
                <div className="cui-root-draft-shelf-list">
                    {dormant.map(pointer => {
                        const characterName = names.get(pointer.avatar) || '未知角色';
                        const namePrefix = `${characterName} - `;
                        const draftLabel = pointer.fileName.startsWith(namePrefix)
                            ? pointer.fileName.slice(namePrefix.length)
                            : pointer.fileName;
                        return (
                            <button
                                key={`${pointer.avatar}\u0000${pointer.fileName}`}
                                className="cui-root-draft-shelf-row"
                                type="button"
                                title={`恢复 ${characterName}：${pointer.fileName}`}
                                onClick={() => {
                                    void openChatuiChatForCharacter(pointer.avatar, pointer.fileName);
                                    onNavigate();
                                }}
                            >
                                <i className="fa-regular fa-file-lines" aria-hidden="true" />
                                <span className="cui-root-draft-shelf-main">
                                    <span className="cui-root-draft-shelf-name">{characterName}</span>
                                    <span className="cui-root-draft-shelf-file">{draftLabel}</span>
                                </span>
                                <span className="cui-root-draft-shelf-action">恢复</span>
                            </button>
                        );
                    })}
                    <p className="cui-root-draft-shelf-note">打开后可继续，或从会话菜单明确删除</p>
                </div>
            )}
        </div>
    );
}
