/**
 * SillyTavern-ChatUI · 书脊 spine
 *
 * The 58px rail that answers exactly one question: who is on stage now
 * (DESIGN §4.2). It carries the cast as 32x32 avatar squares, an entry to ST's
 * character panel, the vertical shop sign, and the settings gear pinned to the
 * bottom. It is *not* a contact list: no name rows, no unread counts, no last
 * message preview — the name belongs to the playbill header and the topbar.
 *
 * It stays mounted in settings mode too (DESIGN §3), which is why picking a
 * character here also leaves settings: the reason to reach for the spine from
 * a settings pane is to go back to somebody.
 */

import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { closeChatuiSettings, openChatuiSettings, switchChatuiCharacter } from '../../actions.js';
import { useSpineCharacters } from '../../hooks.js';
import { SettingsEntry } from './SettingsEntry.js';
import type { CharacterSummary } from '../../types.js';

/** 原型's vertical shop sign. The spaces are the design's own letter rhythm. */
const SHOP_SIGN = '回 廊 剧 场';

/**
 * First glyph of a name, code-point aware so an astral-plane first character
 * (emoji, rare CJK) is not split into a lone surrogate half.
 */
function initialOf(name: string): string {
    return [...name.trim()][0] ?? '·';
}

function SpineCharacter({
    character,
    onPick,
}: {
    character: CharacterSummary;
    onPick: (avatar: string) => void;
}): ComponentChild {
    return (
        <button
            className={`cui-root-spine-slot cui-root-spine-char${character.isCurrent ? ' is-current' : ''}`}
            type="button"
            title={character.name}
            aria-label={character.name}
            aria-current={character.isCurrent ? 'true' : undefined}
            onClick={() => onPick(character.avatar)}
        >
            {character.thumbnailUrl
                ? <img className="cui-root-spine-avatar" src={character.thumbnailUrl} alt="" />
                : <span className="cui-root-spine-avatar cui-root-spine-avatar-fallback" aria-hidden="true">
                      {initialOf(character.name)}
                  </span>}
        </button>
    );
}

export function Spine({ onNavigate }: { onNavigate: () => void }): ComponentChild {
    const { characters, isGroupActive } = useSpineCharacters();

    const pickCharacter = (avatar: string) => {
        closeChatuiSettings();
        void switchChatuiCharacter(avatar);
        onNavigate();
    };

    return (
        <nav className="cui-root-spine" aria-label="ChatUI character spine">
            <div className="cui-root-spine-list">
                {/* The group slot is its own seat on the spine, drawn with a group
                    icon rather than by borrowing a member's avatar (DESIGN §4.2).
                    It appears only while a group holds the stage because that is
                    the entire extent of what the adapter can tell us about groups
                    today — rendering a permanent, unclickable group button would
                    be a control that promises a switch nothing implements. */}
                {isGroupActive && (
                    <span
                        className="cui-root-spine-slot cui-root-spine-group is-current"
                        role="img"
                        aria-label="群聊"
                        title="群聊"
                    >
                        <i className="fa-solid fa-users" aria-hidden="true" />
                    </span>
                )}
                {characters.map(character => (
                    <SpineCharacter
                        key={character.avatar}
                        character={character}
                        onPick={pickCharacter}
                    />
                ))}
                {/* 原型's dashed ＋ is "import / new character". ChatUI has no
                    import action of its own, but it already hosts ST's own
                    character panel as a settings entry, so this opens that
                    rather than inventing a second import path. */}
                <button
                    className="cui-root-spine-slot cui-root-spine-add"
                    type="button"
                    aria-label="角色管理"
                    title="角色管理"
                    onClick={() => {
                        openChatuiSettings('st:right-nav-panel');
                        onNavigate();
                    }}
                >
                    <i className="fa-solid fa-plus" aria-hidden="true" />
                </button>
            </div>
            <span className="cui-root-spine-mark" aria-hidden="true">{SHOP_SIGN}</span>
            <SettingsEntry onNavigate={onNavigate} />
        </nav>
    );
}
