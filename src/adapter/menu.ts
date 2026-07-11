/**
 * SillyTavern-ChatUI · menu adapter
 */

import { _dispatchClick, buildLiveElementRegistry } from './internals.js';

type WandItemDto = {
    id: string;
    label: string;
    iconHtml: string;
};

let _attachmentAcceptRestoreTimer: ReturnType<typeof setTimeout> | null = null;

let _attachmentAcceptRestore: (() => void) | null = null;

/**
 * @param {string} optionId
 * @returns {void}
 */
export function triggerOptionsAction(optionId: any): boolean {
    if (typeof window.$ === 'function') {
        const button = window.$(`#options #${optionId}`);
        if (!button?.length) return false;
        button.trigger('click', [{ fromSlashCommand: true }]);
        return true;
    }

    const button = document.querySelector(`#options #${optionId}`);
    if (!button) return false;
    _dispatchClick(button);
    return true;
}

/**
 * @returns {void}
 */
export function continueMessage() {
    if (!triggerOptionsAction('option_continue')) throw new Error('[ChatUI/adapter] Continue action not found');
}

/**
 * @returns {void}
 */
export function impersonateMessage() {
    if (!triggerOptionsAction('option_impersonate')) throw new Error('[ChatUI/adapter] Impersonate action not found');
}

/**
 * Currently unreachable from any UI control — do not wire this up before
 * fixing the issue below. ST's native openMessageDelete() (script.js) writes
 * #send_form's own inline `style.display` on entry and restores a
 * page-load-captured default on exit (#dialogue_del_mes_cancel/_ok handlers).
 * The shield's #send_form rule is a bare `display: none !important`
 * (style.css), which wins over that restore write, but if it's ever weakened
 * to drop `!important` (or #send_form's display is ever set inline some other
 * way) that restore would silently reveal the native composer bar again.
 * Verified via a 2026-07-05 static audit — see ROADMAP.md's 阻塞项/技术债.
 *
 * @returns {void}
 */
export function openDeleteMessageMode() {
    if (!triggerOptionsAction('option_delete_mes')) throw new Error('[ChatUI/adapter] Delete mode action not found');
}

/**
 * @returns {void}
 */
export function regenerateFromPlusMenu() {
    if (!triggerOptionsAction('option_regenerate')) throw new Error('[ChatUI/adapter] Regenerate action not found');
}

/**
 * @returns {void}
 */
export function clearAttachmentPickerRestore() {
    if (_attachmentAcceptRestoreTimer !== null) {
        clearTimeout(_attachmentAcceptRestoreTimer);
        _attachmentAcceptRestoreTimer = null;
    }
    if (_attachmentAcceptRestore) {
        window.removeEventListener('focus', _attachmentAcceptRestore);
        _attachmentAcceptRestore = null;
    }
}

/**
 * @param {string|null} accept
 * @returns {void}
 */
export function openAttachmentPicker(accept: string | null = null) {
    const input = document.getElementById('file_form_input') as HTMLInputElement | null;

    if (input && accept !== null) {
        // Capture the original accept only when no restore cycle is pending, so a
        // second narrowed open before the picker closes still restores to the true
        // default rather than the first call's temporary filter.
        if (!_attachmentAcceptRestore) {
            const prev = input.accept;
            // ST's #attachFile handler does $fileInput.off('change'), which strips
            // any change-listener added here — so restore the accept filter when the
            // OS picker closes (the window regains focus), with a timer as a backstop.
            const restore = () => {
                clearAttachmentPickerRestore();
                input.accept = prev;
            };
            _attachmentAcceptRestore = restore;
            window.addEventListener('focus', restore, { once: true });
            _attachmentAcceptRestoreTimer = setTimeout(restore, 60000);
        }
        input.accept = accept;
    }

    const attachButton = document.querySelector('#attachFile');
    if (attachButton) _dispatchClick(attachButton);
}

/**
 * @param {Element} original
 * @returns {void}
 */
export function triggerWandAction(original: any) {
    _dispatchClick(original);
}

// ── Wand / extension tools (proxy ST's #extensionsMenu items) ──────────────────

/** @type {Map<string, HTMLElement>} */
const _wandItemMap = new Map<string, HTMLElement>();

function wandItemCandidates(wandMenu: Element): Element[] {
    const candidates: Element[] = [];

    // Primary: items inside each .extension_container.
    wandMenu.querySelectorAll('.extension_container').forEach(container => {
        candidates.push(...Array.from(container.children));
    });
    // Fallback: items appended directly to #extensionsMenu (e.g. gallery).
    Array.from(wandMenu.children).forEach(child => {
        if (child instanceof HTMLElement && child.classList.contains('extension_container')) return;
        candidates.push(child);
    });

    return candidates;
}

/**
 * Enumerate visible wand items from ST's #extensionsMenu. Rebuilds the internal
 * id->liveElement map each call (ST rebuilds items on chat change). The live
 * elements stay private to the adapter; the UI only ever sees plain DTOs.
 *
 * @returns {{ id: string, label: string, iconHtml: string }[]}
 */
export function listWandItems() {
    const wandMenu = document.getElementById('extensionsMenu');
    return buildLiveElementRegistry<WandItemDto>(wandMenu, _wandItemMap, {
        idPrefix: 'wand',
        elements: wandItemCandidates,
        toDto: (el, id) => {
            const label = (el.querySelector('span')?.textContent || el.textContent || '').trim();
            const iconEl = el.querySelector('.extensionsMenuExtensionButton, [class*="fa-"]');
            return { id, label, iconHtml: iconEl ? iconEl.outerHTML : '' };
        },
    });
}

/**
 * Proxy a click onto the live mapped wand element (never a clone).
 *
 * @param {string} id opaque id from listWandItems()
 * @returns {boolean}
 */
export function triggerWandItem(id: any) {
    const el = _wandItemMap.get(id);
    if (!el) return false;
    triggerWandAction(el);
    return true;
}

// ── Pending composer attachments (ST stages them in #file_form_input.files) ────

/**
 * @returns {HTMLInputElement|null}
 */
function _pendingInput() {
    const el = document.getElementById('file_form_input');
    return el instanceof HTMLInputElement ? el : null;
}

/**
 * List files the user has staged but not yet sent.
 *
 * @returns {{ id: string, name: string, type: string, size: number }[]}
 */
export function getPendingAttachments() {
    const input = _pendingInput();
    if (!input || !input.files) return [];
    return Array.from(input.files).map((file, index) => ({
        id: `${index}:${file.name}:${file.size}:${file.lastModified}`,
        name: file.name,
        type: file.type || '',
        size: file.size,
    }));
}

/**
 * Remove one staged file before send by rebuilding the input FileList
 * (FileList is read-only, so this uses a DataTransfer like ST itself does).
 *
 * @param {string} id
 * @returns {void}
 */
export function removePendingAttachment(id: any) {
    const input = _pendingInput();
    if (!input || !input.files) return;

    const transfer = new DataTransfer();
    Array.from(input.files).forEach((file, index) => {
        const fileId = `${index}:${file.name}:${file.size}:${file.lastModified}`;
        if (fileId !== id) transfer.items.add(file);
    });
    input.files = transfer.files;

    if (input.files.length === 0) {
        const form = document.getElementById('file_form');
        if (form instanceof HTMLFormElement) form.reset();
    }
    _emitPendingChanged();
}

const _pendingListeners = new Set<() => void>();

let _pendingObserver: MutationObserver | null = null;

let _pendingObservedForm: Element | null = null;

/**
 * @returns {void}
 */
function _emitPendingChanged() {
    for (const listener of _pendingListeners) {
        try {
            listener();
        } catch (error) {
            console.error('[ChatUI/adapter] pending-attachment listener failed', error);
        }
    }
}

/**
 * ST fires no event for pending attach/remove, so synthesize one by observing
 * #file_form (it toggles .displayNone + preview text on attach/reset/send).
 *
 * @param {() => void} handler
 * @returns {() => void}
 */
export function subscribePendingChanged(handler: () => void) {
    const form = document.getElementById('file_form');
    if (form !== _pendingObservedForm) {
        _pendingObserver?.disconnect();
        _pendingObserver = null;
        _pendingObservedForm = null;

        if (form) {
            _pendingObserver = new MutationObserver(() => _emitPendingChanged());
            _pendingObserver.observe(form, {
                attributes: true,
                attributeFilter: ['class'],
                childList: true,
                subtree: true,
            });
            _pendingObservedForm = form;
        }
    }
    _pendingListeners.add(handler);
    return () => {
        _pendingListeners.delete(handler);
        if (_pendingListeners.size === 0) {
            _pendingObserver?.disconnect();
            _pendingObserver = null;
            _pendingObservedForm = null;
        }
    };
}
