import React, { useEffect, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    continueChatuiGeneration,
    impersonateChatui,
    listChatuiWandItems,
    openChatuiAttachmentPicker,
    regenerateChatuiLast,
    subscribeChatuiEvent,
    triggerChatuiWandItem,
} from '../actions.js';
import { useConfig } from '../hooks.js';

type WandItem = { id: string; label: string; iconHtml: string };

type PlusTool = {
    id: string;
    label: string;
    iconClass: string;
    run: () => void;
};

// Built-in composer tools. Which ones surface as top tiles vs. list rows is
// driven by config.plusPinned (DESIGN §4.3 ① 置顶磁贴). The pin/toggle/drag
// EDITOR is deferred to the §7 config surface; this slice only renders from it.
const TOOLS: PlusTool[] = [
    { id: 'photos', label: '图片 / 视频', iconClass: 'fa-solid fa-image', run: () => openChatuiAttachmentPicker('image/*,video/*,audio/*') },
    { id: 'files', label: '文件', iconClass: 'fa-solid fa-paperclip', run: () => openChatuiAttachmentPicker() },
    { id: 'continue', label: '续写', iconClass: 'fa-solid fa-forward-step', run: () => continueChatuiGeneration() },
    { id: 'impersonate', label: '代笔', iconClass: 'fa-solid fa-user-pen', run: () => impersonateChatui() },
    { id: 'regenerate', label: '重新生成', iconClass: 'fa-solid fa-rotate', run: () => regenerateChatuiLast() },
];

export function PlusMenu({
    topSlot,
}: {
    /** Optional content pinned above the tool list — single-line mode parks selector B here (DESIGN §4.2). */
    topSlot?: ComponentChild;
} = {}): ComponentChild {
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
        tool.run();
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
                                            onClick={() => { setIsOpen(false); triggerChatuiWandItem(item.id); }}
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
