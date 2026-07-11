import React, { useEffect, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import type { PlusToolId } from '../types.js';
import {
    continueChatuiGeneration,
    impersonateChatui,
    listChatuiWandItems,
    openChatuiAttachmentPicker,
    regenerateChatuiLast,
    subscribeChatuiEvent,
    triggerChatuiWandItem,
    PLUS_TOOL_IDS,
} from '../actions.js';
import { useConfig } from '../hooks.js';

type WandItem = { id: string; label: string; iconHtml: string };

/** Display metadata for one built-in composer tool (no behavior). */
export type PlusToolMeta = {
    id: PlusToolId;
    label: string;
    iconClass: string;
};

type PlusTool = PlusToolMeta & { run: (chatKey: string) => void };

// Per-id presentation (label + icon). The id universe and order come from
// PLUS_TOOL_IDS (config-store) — the same list that validates persisted plusPinned —
// so the menu, the pin editor, and persistence can never disagree on which ids exist.
const PLUS_TOOL_PRESENTATION = {
    photos: { label: '图片 / 视频', iconClass: 'fa-solid fa-image' },
    files: { label: '文件', iconClass: 'fa-solid fa-paperclip' },
    continue: { label: '续写', iconClass: 'fa-solid fa-forward-step' },
    impersonate: { label: '代笔', iconClass: 'fa-solid fa-user-pen' },
    regenerate: { label: '重新生成', iconClass: 'fa-solid fa-rotate' },
} satisfies Record<PlusToolId, Omit<PlusToolMeta, 'id'>>;

/** Built-in composer tools as ordered display metadata (shared with the pin editor). */
export const PLUS_TOOL_META: PlusToolMeta[] = PLUS_TOOL_IDS.map(id => ({ id, ...PLUS_TOOL_PRESENTATION[id] }));

/** Behavior for each tool id, kept local to the menu (the editor needs only meta). */
const RUN_BY_ID = {
    photos: () => openChatuiAttachmentPicker('image/*,video/*,audio/*'),
    files: () => openChatuiAttachmentPicker(),
    continue: chatKey => continueChatuiGeneration(chatKey),
    impersonate: chatKey => impersonateChatui(chatKey),
    regenerate: chatKey => regenerateChatuiLast(chatKey),
} satisfies Record<PlusToolId, PlusTool['run']>;

const TOOLS: PlusTool[] = PLUS_TOOL_META.map(meta => ({ ...meta, run: RUN_BY_ID[meta.id] }));

export function PlusMenu({
    chatKey,
    topSlot,
}: {
    chatKey: string;
    /** Optional content pinned above the tool list — single-line mode parks selector B here (DESIGN §4.2). */
    topSlot?: ComponentChild;
}): ComponentChild {
    const [isOpen, setIsOpen] = useState(false);
    const [wandItems, setWandItems] = useState<WandItem[]>([]);
    const pinnedIds = useConfig().plusPinned;

    useEffect(() => {
        if (!isOpen) return;
        setWandItems(listChatuiWandItems());
        return subscribeChatuiEvent('CHAT_CHANGED', () => setWandItems(listChatuiWandItems()));
    }, [isOpen]);

    const runTool = (tool: PlusTool) => {
        setIsOpen(false);
        tool.run(chatKey);
    };

    // ① top tiles = pinned tools in config order; ② list = the remainder.
    // Unknown ids in plusPinned are ignored (filtered out by the find).
    const pinnedTools = pinnedIds
        .map(id => TOOLS.find(tool => tool.id === id))
        .filter((tool): tool is PlusTool => tool !== undefined);
    const listTools = TOOLS.filter(tool => !pinnedIds.includes(tool.id));

    return (
        <div className="cui-root-plus">
            <button
                className="cui-root-plus-btn"
                type="button"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                title="More actions"
                onClick={() => setIsOpen(open => !open)}
            >
                <i className="fa-solid fa-plus" />
            </button>
            {isOpen && (
                <>
                    <button
                        className="cui-root-plus-backdrop"
                        type="button"
                        aria-label="Close menu"
                        onClick={() => setIsOpen(false)}
                    />
                    <div className="cui-root-plus-menu" role="menu">
                        <header className="cui-root-plus-header">
                            <span className="cui-root-plus-title">工具</span>
                            <button
                                className="cui-root-plus-close"
                                type="button"
                                aria-label="Close menu"
                                title="Close"
                                onClick={() => setIsOpen(false)}
                            >
                                <i className="fa-solid fa-xmark" />
                            </button>
                        </header>
                        {topSlot && (
                            <div className="cui-root-plus-topslot">{topSlot}</div>
                        )}
                        {pinnedTools.length > 0 && (
                            <div className="cui-root-plus-tiles">
                                {pinnedTools.map(tool => (
                                    <button
                                        key={tool.id}
                                        className="cui-root-plus-tile"
                                        type="button"
                                        role="menuitem"
                                        onClick={() => runTool(tool)}
                                    >
                                        <i className={tool.iconClass} />
                                        <span>{tool.label}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="cui-root-plus-tools">
                            {listTools.map(tool => (
                                <button
                                    key={tool.id}
                                    className="cui-root-plus-tool"
                                    type="button"
                                    role="menuitem"
                                    onClick={() => runTool(tool)}
                                >
                                    <i className={tool.iconClass} />
                                    <span>{tool.label}</span>
                                </button>
                            ))}
                        </div>
                        {wandItems.length > 0 && (
                            <>
                                <div className="cui-root-plus-divider" role="separator" />
                                <div className="cui-root-plus-tools">
                                    {wandItems.map(item => (
                                        <button
                                            key={item.id}
                                            className="cui-root-plus-tool"
                                            type="button"
                                            role="menuitem"
                                            onClick={() => { setIsOpen(false); triggerChatuiWandItem(item.id, chatKey); }}
                                        >
                                            <span
                                                className="cui-root-plus-wand-icon"
                                                dangerouslySetInnerHTML={{ __html: item.iconHtml }}
                                            />
                                            <span>{item.label}</span>
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
