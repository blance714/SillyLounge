/**
 * SillyTavern-ChatUI · message-actions.js
 *
 * Phase 2 — §5-B: Character message action row (always-visible copy/regen/edit + ⋯ overflow)
 *           §5-C: User message context menu (long-press mobile / hover-⋯ + right-click desktop)
 *           §5-D: Swipe counter overlay (‹ n/m ›) on the last character message
 *
 * CONTRACT-P2:
 *   - Idempotency sentinel: data-cui-p2 on .mes (shared with other P2 modules — do NOT set/remove
 *     it here; this module owns its own sub-element guard data-cui-actions='1' on .mes)
 *   - Re-apply on: CHARACTER_MESSAGE_RENDERED, USER_MESSAGE_RENDERED, MESSAGE_SWIPED,
 *     MESSAGE_UPDATED, CHAT_CHANGED (setTimeout 0), MORE_MESSAGES_LOADED
 *   - teardown: removes all .cui-action-row, .cui-ctx-handle, .cui-ctx-menu, .cui-swipe-wrap
 *     nodes and data-cui-actions attribute; calling twice is a no-op.
 *   - Never re-implement ST actions — call chatuiAdapter.messageActions.
 *   - No import $; ST DOM fallbacks live inside adapter/st-adapter.js.
 *   - Message type / last-message state comes from ChatUI Store DTOs.
 *   - No console.log. Module-level state vars prefixed _
 */

import { chatuiAdapter, stEventKeys } from './adapter/st-adapter.js';
import { getLastMessageDto, getMessageDtoByElement, getMessageDtoById } from './store/chat-store.js';

// ── Module-level state ────────────────────────────────────────────────────────

/** @type {Array<() => void>} event unsubscribers registered by this module */
let _listeners = [];

/** @type {boolean} whether initMessageActions has been called */
let _isSetup = false;

/** Sentinel attribute name used by this module (not the shared data-cui-p2) */
const ACTIONS_ATTR = 'data-cui-actions';

/**
 * Module-level reference to the document-level close handler for ChatUI's
 * character-message overflow menu.
 * @type {EventListener|null}
 */
let _pendingOverflowCloseHandler = null;

/**
 * WeakMap storing the contextmenu handler for each .mes element so
 * _unprocessMessage can remove it without leaking listeners on every re-process.
 * @type {WeakMap<Element, EventListener>}
 */
const _ctxHandlers = new WeakMap();

/**
 * Module-level reference to the document-level close handler for the context
 * menu, so teardown and CHAT_CHANGED can remove it even if no click fires.
 * @type {EventListener|null}
 */
let _pendingCloseHandler = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Register an ST event listener and remember it for teardown.
 * @param {string} type
 * @param {Function} fn
 */
function _on(type, fn) {
    _listeners.push(chatuiAdapter.subscribe(type, fn));
}

/**
 * Check body.chatui-active gate.
 * @returns {boolean}
 */
function _isActive() {
    return document.body.classList.contains('chatui-active');
}

/**
 * Classify a .mes element into user / char / system.
 * @param {Element} el
 * @returns {{ isUser: boolean, isSystem: boolean, isChar: boolean, isLast: boolean,
 *             isSmallSys: boolean, isToolCall: boolean, mesId: number }|null}
 */
function _classify(el) {
    const dto = getMessageDtoByElement(el);
    if (!dto) return null;

    return {
        isUser: dto.isUser,
        isSystem: dto.isSystem,
        isChar: dto.isChar,
        isLast: dto.ui.isLast,
        isSmallSys: dto.extra.isSmallSys,
        isToolCall: dto.extra.isToolCall,
        mesId: dto.id,
    };
}

// ── Swipe counter helpers ─────────────────────────────────────────────────────

/**
 * Read the current swipe label from the data model (never from DOM text).
 * @param {number} mesId
 * @returns {string}  e.g. "2/3", or "" when no swipes
 */
function _swipeLabel(mesId) {
    const dto = getMessageDtoById(mesId);
    return dto?.swipe.label ?? '';
}

/**
 * Close any ChatUI overflow menu opened for a character message.
 * @returns {void}
 */
function _closeOverflowMenu() {
    document.querySelectorAll('#chat .cui-overflow-menu').forEach(menu => menu.remove());

    if (_pendingOverflowCloseHandler) {
        document.removeEventListener('click', _pendingOverflowCloseHandler, { capture: true });
        _pendingOverflowCloseHandler = null;
    }
}

/**
 * @param {HTMLElement} item
 * @param {Element} mesEl
 * @returns {boolean}
 */
function _isOverflowProxyVisible(item, mesEl) {
    const dto = getMessageDtoByElement(mesEl);
    return chatuiAdapter.messageActions.isOverflowActionVisible(item, {
        isSystem: dto?.isSystem ?? false,
        mediaDisplay: mesEl.getAttribute('data-media-display') ?? '',
    });
}

/**
 * Build one ChatUI overflow item that proxies a native ST extra button.
 *
 * @param {HTMLElement} original
 * @returns {HTMLButtonElement}
 */
function _buildOverflowProxyItem(original) {
    const item = document.createElement('button');
    item.className = 'cui-ctx-item cui-overflow-item';
    item.type = 'button';

    const icon = document.createElement('i');
    const iconClasses = Array.from(original.classList).filter(cls => cls.startsWith('fa-'));
    icon.className = iconClasses.length ? iconClasses.join(' ') : 'fa-solid fa-circle-dot';
    item.appendChild(icon);

    const label = document.createElement('span');
    label.textContent = original.getAttribute('title')
        || original.getAttribute('data-tooltip')
        || original.textContent?.trim()
        || 'Action';
    item.appendChild(label);

    item.addEventListener('click', (e) => {
        e.stopPropagation();
        _closeOverflowMenu();
        chatuiAdapter.messageActions.triggerOverflowAction(original);
    });

    return item;
}

/**
 * Toggle ChatUI's character-message overflow menu. Menu items are visual
 * proxies for ST's native .extraMesButtons children; the original buttons stay
 * hidden and only receive delegated click events.
 *
 * @param {Element} mesEl
 * @param {HTMLElement} anchorEl
 * @returns {void}
 */
function _toggleOverflowMenu(mesEl, anchorEl) {
    const existing = mesEl.querySelector('.cui-overflow-menu');
    _closeOverflowMenu();
    if (existing) return;

    const source = mesEl.querySelector('.extraMesButtons');
    if (!source) return;

    const menu = document.createElement('div');
    menu.className = 'cui-ctx-menu cui-overflow-menu';

    Array.from(source.children).forEach(child => {
        const original = /** @type {HTMLElement} */ (child);
        if (!_isOverflowProxyVisible(original, mesEl)) return;
        menu.appendChild(_buildOverflowProxyItem(original));
    });

    if (!menu.children.length) return;

    mesEl.appendChild(menu);
    _positionOverflowMenu(mesEl, anchorEl, menu);

    const closeHandler = (e) => {
        const target = /** @type {Node} */ (e.target);
        if (menu.contains(target) || mesEl.querySelector('.cui-action-overflow')?.contains(target)) {
            return;
        }
        _closeOverflowMenu();
    };

    _pendingOverflowCloseHandler = closeHandler;
    setTimeout(() => {
        document.addEventListener('click', closeHandler, { capture: true });
    }, 0);
}

/**
 * Position a character overflow menu under the ChatUI overflow button.
 *
 * @param {Element} mesEl
 * @param {HTMLElement} anchorEl
 * @param {HTMLElement} menu
 * @returns {void}
 */
function _positionOverflowMenu(mesEl, anchorEl, menu) {
    const mesRect = mesEl.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const gap = 6;

    let left = anchorRect.left - mesRect.left;
    const top = anchorRect.bottom - mesRect.top + gap;
    const maxLeft = Math.max(8, mesRect.width - menu.offsetWidth - 8);

    left = Math.min(Math.max(8, left), maxLeft);

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.right = 'auto';
}

// ── Action dispatch ───────────────────────────────────────────────────────────

/**
 * Trigger an ST message action through the adapter. DOM fallback details stay
 * inside adapter/st-adapter.js.
 *
 * @param {Element} mesEl  — the .mes DOM element
 * @param {string}  action — one of: copy|regen|edit|overflow|branch|checkpoint|hide|delete
 */
function _triggerAction(mesEl, action) {
    if (action === 'overflow') return;
    chatuiAdapter.messageActions.triggerMessageAction(mesEl, action);
}

// ── Character action row (§5-B) ───────────────────────────────────────────────

/**
 * Build the action row for a character message.
 * Contains: copy, (regen on last), edit, ⋯ overflow, (swipe wrap on last).
 *
 * @param {Element}  mesEl
 * @param {object}   settingsP2
 * @param {boolean}  isLast
 * @returns {Element}  .cui-action-row div (not yet inserted)
 */
function _buildActionRow(mesEl, settingsP2, isLast) {
    const row = document.createElement('div');
    row.className = 'cui-action-row';

    const actions = Array.isArray(settingsP2?.charActionRow)
        ? settingsP2.charActionRow
        : ['copy', 'regenerate', 'edit'];

    // Normalise: CONTRACT uses 'regenerate'; internal dispatch uses 'regen'
    const normalise = (a) => a === 'regenerate' ? 'regen' : a;

    for (const rawAction of actions) {
        const action = normalise(rawAction);

        // Regen only on last AI message
        if (action === 'regen' && !isLast) continue;

        const btn = document.createElement('button');
        btn.className = `cui-action-btn cui-action-${action}`;
        btn.setAttribute('type', 'button');
        btn.setAttribute('aria-label', rawAction);
        btn.setAttribute('title', rawAction);

        // Icon
        const icon = document.createElement('i');
        switch (action) {
            case 'copy':  icon.className = 'fa-regular fa-copy';   break;
            case 'regen': icon.className = 'fa-solid fa-rotate-right'; break;
            case 'edit':  icon.className = 'fa-solid fa-pencil';   break;
            default:      icon.className = 'fa-solid fa-ellipsis'; break;
        }
        btn.appendChild(icon);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            _triggerAction(mesEl, action);
        });

        row.appendChild(btn);
    }

    // Always add ⋯ overflow as last button
    const overflowBtn = document.createElement('button');
    overflowBtn.className = 'cui-action-btn cui-action-overflow';
    overflowBtn.setAttribute('type', 'button');
    overflowBtn.setAttribute('aria-label', 'More actions');
    overflowBtn.setAttribute('title', 'More actions');
    const overflowIcon = document.createElement('i');
    overflowIcon.className = 'fa-solid fa-ellipsis';
    overflowBtn.appendChild(overflowIcon);
    overflowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _toggleOverflowMenu(mesEl, overflowBtn);
    });
    row.appendChild(overflowBtn);

    // Swipe wrap — only on last char message (§5-D)
    if (isLast) {
        const dto = getMessageDtoByElement(mesEl);
        if (!dto) return row;
        const mesId = dto.id;
        const label = _swipeLabel(mesId);

        const swipeWrap = document.createElement('div');
        swipeWrap.className = 'cui-swipe-wrap';

        const leftBtn = document.createElement('button');
        leftBtn.className = 'cui-action-btn cui-swipe-left';
        leftBtn.setAttribute('type', 'button');
        leftBtn.setAttribute('aria-label', 'Previous swipe');
        leftBtn.setAttribute('title', 'Previous swipe');
        leftBtn.textContent = '‹'; // ‹
        leftBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            chatuiAdapter.messageActions.swipeMessage(mesEl, 'left');
        });

        const counter = document.createElement('span');
        counter.className = 'cui-swipe-counter';
        counter.textContent = label;
        // Hide counter when there are no multiple swipes
        if (!label) counter.style.display = 'none';

        const rightBtn = document.createElement('button');
        rightBtn.className = 'cui-action-btn cui-swipe-right';
        rightBtn.setAttribute('type', 'button');
        rightBtn.setAttribute('aria-label', 'Next swipe');
        rightBtn.setAttribute('title', 'Next swipe');
        rightBtn.textContent = '›'; // ›
        rightBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            chatuiAdapter.messageActions.swipeMessage(mesEl, 'right');
        });

        swipeWrap.appendChild(leftBtn);
        swipeWrap.appendChild(counter);
        swipeWrap.appendChild(rightBtn);
        row.appendChild(swipeWrap);
    }

    return row;
}

// ── User context menu handle + menu (§5-C) ────────────────────────────────────

/**
 * Close the active user context menu and clean up.
 * @param {Element} mesEl
 */
function _closeCtxMenu(mesEl) {
    const menu = mesEl.querySelector('.cui-ctx-menu');
    if (menu) menu.remove();
}

/**
 * Open (or toggle) the user context menu for a message.
 * @param {Element}  mesEl
 * @param {object}   settingsP2
 */
function _openCtxMenu(mesEl, settingsP2) {
    // If already open, close it
    if (mesEl.querySelector('.cui-ctx-menu')) {
        _closeCtxMenu(mesEl);
        return;
    }

    const items = Array.isArray(settingsP2?.userMenu)
        ? settingsP2.userMenu
        : ['copy', 'edit', 'delete', 'branch', 'checkpoint', 'hide'];

    const menu = document.createElement('div');
    menu.className = 'cui-ctx-menu';

    for (const action of items) {
        const item = document.createElement('button');
        item.className = 'cui-ctx-item';
        item.setAttribute('type', 'button');
        item.setAttribute('data-action', action);

        // Icon + label
        const icon = document.createElement('i');
        switch (action) {
            case 'copy':       icon.className = 'fa-regular fa-copy';        break;
            case 'edit':       icon.className = 'fa-solid fa-pencil';        break;
            case 'delete':     icon.className = 'fa-solid fa-trash';         break;
            case 'branch':     icon.className = 'fa-solid fa-code-branch';   break;
            case 'checkpoint': icon.className = 'fa-solid fa-flag-checkered'; break;
            case 'hide':       icon.className = 'fa-solid fa-eye-slash';     break;
            default:           icon.className = 'fa-solid fa-circle-question'; break;
        }
        item.appendChild(icon);

        const label = document.createElement('span');
        label.textContent = action.charAt(0).toUpperCase() + action.slice(1);
        item.appendChild(label);

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            _closeCtxMenu(mesEl);
            _triggerAction(mesEl, action);
        });

        menu.appendChild(item);
    }

    mesEl.appendChild(menu);

    // Remove any previous document-level close handler (e.g. from a prior open
    // menu that was never clicked away — covers CHAT_CHANGED mid-open-menu).
    if (_pendingCloseHandler) {
        document.removeEventListener('click', _pendingCloseHandler, { capture: true });
        _pendingCloseHandler = null;
    }

    // Close on next document click (one-shot)
    const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
            _closeCtxMenu(mesEl);
            document.removeEventListener('click', closeHandler, { capture: true });
            if (_pendingCloseHandler === closeHandler) _pendingCloseHandler = null;
        }
    };
    _pendingCloseHandler = closeHandler;
    // Defer so this click event doesn't immediately close the menu
    setTimeout(() => {
        document.addEventListener('click', closeHandler, { capture: true });
    }, 0);
}

/**
 * Build and attach the .cui-ctx-handle button to a user message's .ch_name.
 * Mobile long-press (500 ms) or desktop click on the handle opens the menu.
 * Right-click anywhere on the .mes also opens it (desktop).
 *
 * @param {Element} mesEl
 * @param {object}  settingsP2
 */
function _buildCtxHandle(mesEl, settingsP2) {
    const chName = mesEl.querySelector('.mes_block .ch_name');
    if (!chName) return;

    const handle = document.createElement('button');
    handle.className = 'cui-ctx-handle';
    handle.setAttribute('type', 'button');
    handle.setAttribute('aria-label', 'Message options');
    handle.setAttribute('title', 'Message options');
    handle.textContent = '⋯'; // ⋯ (horizontal ellipsis)

    // Click handler
    handle.addEventListener('click', (e) => {
        e.stopPropagation();
        _openCtxMenu(mesEl, settingsP2);
    });

    // Long-press for mobile (500 ms)
    let _pressTimer = null;
    const _cancelPress = () => {
        if (_pressTimer !== null) {
            clearTimeout(_pressTimer);
            _pressTimer = null;
        }
    };
    handle.addEventListener('pointerdown', () => {
        _pressTimer = setTimeout(() => {
            _openCtxMenu(mesEl, settingsP2);
        }, 500);
    });
    handle.addEventListener('pointerup', _cancelPress);
    handle.addEventListener('pointerleave', _cancelPress);
    // pointercancel fires when the browser hijacks the pointer (e.g. scroll gesture);
    // without this the long-press menu incorrectly opens after a scroll.
    handle.addEventListener('pointercancel', _cancelPress);

    chName.appendChild(handle);

    // Right-click anywhere on the .mes opens the context menu (desktop).
    // Store handler in WeakMap so _unprocessMessage can remove it exactly once.
    const ctxHandler = (e) => {
        if (!_isActive()) return;
        // Only for user messages
        if (getMessageDtoByElement(mesEl)?.isUser !== true) return;
        e.preventDefault();
        e.stopPropagation();
        _openCtxMenu(mesEl, settingsP2);
    };
    _ctxHandlers.set(mesEl, ctxHandler);
    mesEl.addEventListener('contextmenu', ctxHandler);
}

// ── Per-message processor ─────────────────────────────────────────────────────

/**
 * Remove all action UI injected by this module from a single .mes element.
 * Clears the sentinel so processMessage() can re-run.
 * Also removes the contextmenu listener stored in _ctxHandlers to prevent
 * listener accumulation across re-process cycles (swipe, edit, chat change).
 *
 * @param {Element} mesEl
 */
function _unprocessMessage(mesEl) {
    mesEl.removeAttribute(ACTIONS_ATTR);
    mesEl.querySelectorAll('.cui-action-row, .cui-ctx-handle, .cui-ctx-menu').forEach(n => n.remove());

    // Remove the stored contextmenu handler (fixes listener leak on every swipe)
    const storedHandler = _ctxHandlers.get(mesEl);
    if (storedHandler) {
        mesEl.removeEventListener('contextmenu', storedHandler);
        _ctxHandlers.delete(mesEl);
    }
}

/**
 * Inject action UI into a single .mes element. Idempotent via ACTIONS_ATTR sentinel.
 *
 * @param {Element} mesEl
 * @param {object}  settingsP2
 */
function _processMessage(mesEl, settingsP2) {
    if (!_isActive()) return;
    if (!mesEl || !getMessageDtoByElement(mesEl)) return;

    // Skip system sub-types that shouldn't get action UI
    const classified = _classify(mesEl);
    if (!classified) return;
    const { isChar, isUser, isSmallSys, isToolCall, isLast } = classified;
    if (isSmallSys || isToolCall) return;

    // Idempotency guard
    if (mesEl.hasAttribute(ACTIONS_ATTR)) return;
    mesEl.setAttribute(ACTIONS_ATTR, '1');

    if (isChar) {
        // §5-B: char action row
        const mesBlock = mesEl.querySelector('.mes_block');
        if (!mesBlock) return;

        const row = _buildActionRow(mesEl, settingsP2, isLast);
        mesBlock.appendChild(row);
    } else if (isUser) {
        // §5-C: user context menu handle
        _buildCtxHandle(mesEl, settingsP2);
    }
}

/**
 * Re-process a message by mesId. Clears previous decorations first.
 *
 * @param {number|string} mesId
 * @param {object}        settingsP2
 */
function _processById(mesId, settingsP2) {
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!el) return;
    _unprocessMessage(el);
    _processMessage(el, settingsP2);
}

/**
 * Sweep all .mes nodes currently in #chat.
 *
 * @param {object} settingsP2
 */
function _sweepAll(settingsP2) {
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        _unprocessMessage(el);
        _processMessage(el, settingsP2);
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize message actions. Idempotent — no-op if already set up.
 *
 * @param {{ settings: object, settingsP2: object }} ctx
 * @returns {void}
 */
export function initMessageActions(ctx) {
    if (_isSetup) return;
    _isSetup = true;

    const settingsP2 = ctx.settingsP2 ?? {};

    // 1. Sweep messages already in DOM
    _sweepAll(settingsP2);

    // 2. New character message appended
    _on(stEventKeys.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        _processById(mesId, settingsP2);
    });

    // 3. New user message appended
    _on(stEventKeys.USER_MESSAGE_RENDERED, (mesId) => {
        _processById(mesId, settingsP2);
    });

    // 4. Swipe — .mes node is mutated in-place; inner content replaced.
    //    Re-process the swiped message and the current last-message DTO if it
    //    differs, so swipe controls move with VM state without a full sweep.
    _on(stEventKeys.MESSAGE_SWIPED, (mesId) => {
        _processById(mesId, settingsP2);
        // Re-evaluate the current last message (may differ from swiped message)
        const lastDto = getLastMessageDto();
        if (lastDto && lastDto.id !== Number(mesId)) {
            _processById(lastDto.id, settingsP2);
        }
    });

    // 5. Edit done — .mes_text was re-rendered; re-process this message
    _on(stEventKeys.MESSAGE_UPDATED, (mesId) => {
        _processById(mesId, settingsP2);
    });

    // 6. Chat changed — ALL .mes nodes replaced; full re-sweep after render
    _on(stEventKeys.CHAT_CHANGED, () => {
        setTimeout(() => _sweepAll(settingsP2), 0);
    });

    // 7. More messages loaded — new nodes prepended
    _on(stEventKeys.MORE_MESSAGES_LOADED, () => {
        // processMessage is idempotent; only unprocessed nodes need work
        document.querySelectorAll(`#chat .mes[mesid]:not([${ACTIONS_ATTR}])`).forEach(el => {
            _processMessage(el, settingsP2);
        });
    });
}

/**
 * Teardown message actions. Removes all injected nodes and event listeners.
 * Idempotent — no-op if not set up.
 *
 * @returns {void}
 */
export function teardownMessageActions() {
    if (!_isSetup) return;

    // Remove all event listeners
    for (const unsubscribe of _listeners) {
        unsubscribe();
    }
    _listeners = [];

    // Remove document-level close handler if a context menu was open when teardown runs
    if (_pendingCloseHandler) {
        document.removeEventListener('click', _pendingCloseHandler, { capture: true });
        _pendingCloseHandler = null;
    }

    _closeOverflowMenu();

    // Remove all injected UI from every processed message (also removes contextmenu listeners)
    document.querySelectorAll(`#chat .mes[${ACTIONS_ATTR}]`).forEach(el => {
        _unprocessMessage(el);
    });

    // Also sweep any open context menus (safety net)
    document.querySelectorAll('.cui-ctx-menu').forEach(n => n.remove());

    _isSetup = false;
}
