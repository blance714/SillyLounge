import React, { useEffect, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    getChatuiPendingAttachments,
    removeChatuiPendingAttachment,
    subscribeChatuiPendingAttachments,
} from '../actions.js';

type PendingAttachment = { id: string; name: string; type: string; size: number };

export function AttachmentChips(): ComponentChild {
    const [items, setItems] = useState<PendingAttachment[]>(() => getChatuiPendingAttachments());

    useEffect(() => {
        const refresh = () => setItems(getChatuiPendingAttachments());
        refresh();
        return subscribeChatuiPendingAttachments(refresh);
    }, []);

    if (items.length === 0) return null;

    return (
        <div className="cui-root-attachment-chips" aria-label="Pending attachments">
            {items.map(item => (
                <span key={item.id} className="cui-root-attachment-chip" title={item.name}>
                    <i className={item.type.startsWith('image/') ? 'fa-solid fa-image' : 'fa-solid fa-file-lines'} />
                    <span className="cui-root-attachment-chip-name">{item.name}</span>
                    <button
                        className="cui-root-attachment-chip-remove"
                        type="button"
                        aria-label={`Remove ${item.name}`}
                        title="Remove"
                        onClick={() => {
                            removeChatuiPendingAttachment(item.id);
                            setItems(getChatuiPendingAttachments());
                        }}
                    >
                        <i className="fa-solid fa-xmark" />
                    </button>
                </span>
            ))}
        </div>
    );
}
