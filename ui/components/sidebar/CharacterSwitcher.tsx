import React, { useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { switchChatuiCharacter } from '../../actions.js';
import type { CharacterSummary } from '../../types.js';

/**
 * Region-5 `[角色卡 ▾]` · current character display + dropdown picker (Mode A).
 * Switching auto-refreshes the chat list via CHAT_CHANGED.
 */
export function CharacterSwitcher({
    characters,
    currentName,
    currentAvatarUrl,
}: {
    characters: CharacterSummary[];
    currentName: string;
    currentAvatarUrl: string;
}): ComponentChild {
    const [isOpen, setIsOpen] = useState(false);

    const choose = (avatar: string) => {
        setIsOpen(false);
        void switchChatuiCharacter(avatar);
    };

    return (
        <div className="cui-root-charswitch">
            <button
                className="cui-root-charswitch-btn"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                onClick={() => setIsOpen(open => !open)}
            >
                {currentAvatarUrl
                    ? <img className="cui-root-charswitch-avatar" src={currentAvatarUrl} alt="" />
                    : <i className="fa-solid fa-user cui-root-charswitch-avatar-fallback" />}
                <span className="cui-root-charswitch-name">{currentName || '选择角色'}</span>
                <i className="fa-solid fa-chevron-down cui-root-charswitch-caret" />
            </button>
            {isOpen && (
                <>
                    <button
                        className="cui-root-charswitch-backdrop"
                        type="button"
                        aria-label="Close"
                        onClick={() => setIsOpen(false)}
                    />
                    <ul className="cui-root-charswitch-menu" role="listbox">
                        {characters.length === 0 && (
                            <li className="cui-root-charswitch-empty">无角色</li>
                        )}
                        {characters.map(char => (
                            <li
                                key={char.avatar}
                                className={`cui-root-charswitch-item${char.isCurrent ? ' is-current' : ''}`}
                                role="option"
                                tabIndex={0}
                                aria-selected={char.isCurrent}
                                onClick={() => choose(char.avatar)}
                                onKeyDown={(event) => {
                                    if (event.key !== 'Enter' && event.key !== ' ') return;
                                    event.preventDefault();
                                    choose(char.avatar);
                                }}
                            >
                                {char.thumbnailUrl
                                    ? <img className="cui-root-charswitch-item-avatar" src={char.thumbnailUrl} alt="" />
                                    : <i className="fa-solid fa-user cui-root-charswitch-item-avatar-fallback" />}
                                <span className="cui-root-charswitch-item-name">{char.name}</span>
                                {char.fav && <i className="fa-solid fa-star cui-root-charswitch-item-fav" />}
                                {char.isCurrent && <i className="fa-solid fa-check cui-root-charswitch-item-check" />}
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}
