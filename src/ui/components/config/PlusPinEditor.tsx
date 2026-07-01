import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import { PLUS_TOOL_META } from '../PlusMenu.js';
import { setChatuiPlusPinned, PLUS_PIN_CAP } from '../../actions.js';
import { useConfig } from '../../hooks.js';

/**
 * ＋menu pin editor (DESIGN §4.3 ① 置顶磁贴) — the first §7 config editor.
 * Each built-in tool gets a pin toggle; pinned tools render as top tiles in the
 * composer ＋menu, the rest as list rows. Capped at PLUS_PIN_CAP: once the cap is
 * reached, unchecked toggles are disabled so the limit is obvious.
 *
 * Pin ORDER currently follows PLUS_TOOL_META (toggling appends/removes by id);
 * drag-reorder is out of scope for this slice.
 */
export function PlusPinEditor(): ComponentChild {
    const pinned = useConfig().plusPinned;
    const atCap = pinned.length >= PLUS_PIN_CAP;

    const toggle = (id: string) => {
        // Remove if present; otherwise append (preserving existing pin order),
        // ignoring the add when already at the cap.
        if (pinned.includes(id)) {
            setChatuiPlusPinned(pinned.filter(pinnedId => pinnedId !== id));
        } else if (!atCap) {
            setChatuiPlusPinned([...pinned, id]);
        }
    };

    return (
        <div className="cui-root-config-group">
            <span className="cui-root-section-label">＋菜单置顶磁贴</span>
            <p className="cui-root-config-hint">
                置顶的工具显示为顶部磁贴，其余收进列表（最多 {PLUS_PIN_CAP} 个）。
            </p>
            <div className="cui-root-pin-list">
                {PLUS_TOOL_META.map(tool => {
                    const isPinned = pinned.includes(tool.id);
                    return (
                        <label
                            key={tool.id}
                            className="cui-root-pin-row"
                            title={atCap && !isPinned ? `最多置顶 ${PLUS_PIN_CAP} 个` : undefined}
                        >
                            <i className={`cui-root-pin-icon ${tool.iconClass}`} />
                            <span className="cui-root-pin-label">{tool.label}</span>
                            <input
                                type="checkbox"
                                className="cui-root-pin-check"
                                checked={isPinned}
                                disabled={atCap && !isPinned}
                                onChange={() => toggle(tool.id)}
                            />
                        </label>
                    );
                })}
            </div>
        </div>
    );
}
