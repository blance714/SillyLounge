/**
 * SillyTavern-ChatUI · NewChatCharacterPicker
 *
 * Horizontal character strip rendered above the Composer when the selected chat
 * is the active temp chat. Picking a character switches to it and creates a new
 * temp draft.
 */

import React, { useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { beginTempChatDraft, switchChatuiCharacterAndNewChat } from '../../actions.js';
import type { CharacterSummary } from '../../types.js';

export function NewChatCharacterPicker({
    characters,
    getDraftSnapshot,
    isGenerating,
}: {
    characters: CharacterSummary[];
    getDraftSnapshot: (avatar: string) => { fileNames: string[]; complete: boolean };
    isGenerating: boolean;
}): ComponentChild {
    const [isPicking, setIsPicking] = useState(false);

    if (characters.length === 0) return null;

    async function pick(char: CharacterSummary): Promise<void> {
        if (isPicking || isGenerating) return;
        const snap = getDraftSnapshot(char.avatar);
        beginTempChatDraft({
            avatar: char.avatar,
            knownFileNames: snap.fileNames,
            complete: snap.complete,
        });
        setIsPicking(true);
        try {
            await switchChatuiCharacterAndNewChat(char.avatar);
        } finally {
            setIsPicking(false);
        }
    }

    return (
        <div className="cui-picker" role="region" aria-label="选择角色开始新对话">
            <span className="cui-picker-label">选择角色</span>
            <div className="cui-picker-scroll" role="listbox" aria-label="角色列表">
                {characters.map(char => (
                    <button
                        key={char.avatar}
                        className={`cui-picker-item${char.isCurrent ? ' is-current' : ''}`}
                        type="button"
                        role="option"
                        aria-selected={char.isCurrent}
                        title={char.name}
                        disabled={isPicking || isGenerating}
                        onClick={() => { void pick(char); }}
                    >
                        {char.thumbnailUrl
                            ? <img className="cui-picker-item-avatar" src={char.thumbnailUrl} alt="" />
                            : <span className="cui-picker-item-avatar-fallback">
                                  <i className="fa-solid fa-user" />
                              </span>
                        }
                        <span className="cui-picker-item-name">{char.name}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
