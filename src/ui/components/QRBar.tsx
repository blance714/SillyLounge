import React, { useEffect, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    listChatuiQuickReplies,
    subscribeChatuiQuickReplies,
    triggerChatuiQuickReply,
} from '../actions.js';

type QRItem = { id: string; label: string; title: string; iconHtml: string };

/**
 * Horizontal bar of ST quick-reply buttons mirrored above the composer.
 * Renders nothing when ST has no visible QR buttons (so no space is wasted).
 * Each button proxies the primary click to the live ST element; context-menu
 * / linked-set secondary actions are out of scope.
 */
export function QRBar({ chatKey }: { chatKey: string }): ComponentChild {
    const [items, setItems] = useState<QRItem[]>([]);

    useEffect(() => {
        setItems(listChatuiQuickReplies());
        return subscribeChatuiQuickReplies(() => setItems(listChatuiQuickReplies()));
    }, []);

    if (items.length === 0) return null;

    return (
        <div className="cui-root-qrbar" aria-label="Quick replies">
            {items.map(item => (
                <button
                    key={item.id}
                    className="cui-root-qrbar-btn"
                    type="button"
                    title={item.title}
                    onClick={() => triggerChatuiQuickReply(item.id, chatKey)}
                >
                    {item.iconHtml && (
                        <span
                            className="cui-root-qrbar-icon"
                            dangerouslySetInnerHTML={{ __html: item.iconHtml }}
                        />
                    )}
                    <span className="cui-root-qrbar-label">{item.label}</span>
                </button>
            ))}
        </div>
    );
}
