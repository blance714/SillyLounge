/**
 * message-layout.js — Identity header (§5-A) and per-message structural wrapper.
 *
 * Responsibilities:
 *  - Classify each .mes as user / char / system
 *  - Apply cui-msg wrapper (cui-msg-char | cui-msg-user | cui-msg-system) as first
 *    child of .mes_block
 *  - Optionally inject cui-identity header (avatar + name + timestamp) for char messages
 *    based on ctx.settingsP2.identityHeaderGroup / identityHeaderSingle
 *  - Sweep existing #chat .mes on init; hook render / chat-change events for future messages
 *  - Full, reversible teardown
 *
 * Contract: CONTRACT-P2.md §4 (module interface), §5-A (behaviour), §6 (idempotency/teardown).
 *
 * Idempotency sentinel: data-cui-p2='1' on the .mes element (set by this module).
 */

import { chatuiAdapter, stEventKeys } from './adapter/st-adapter.js';
import { getChatuiState, getMessageDtoByElement } from './store/chat-store.js';

// ── Module-level state ────────────────────────────────────────────────────────

/** @type {Array<() => void>} Accumulated event unsubscribers for clean teardown. */
let _listeners = [];

/** @type {boolean} Guards against double-init. */
let _isSetup = false;

/** @type {object|null} Live settingsP2 reference, set on init. */
let _settingsP2 = null;

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Registers an ST event listener through the adapter and stores it for teardown.
 *
 * @param {string} type - stEventKeys value
 * @param {function} fn - handler function
 * @returns {void}
 */
function _on(type, fn) {
    _listeners.push(chatuiAdapter.subscribe(type, fn));
}

/**
 * Returns true when chatui-active is present on <body>.
 * All processors must check this as their first gate.
 *
 * @returns {boolean}
 */
function _isActive() {
    return document.body.classList.contains('chatui-active');
}

/**
 * Classifies a .mes element into its message type.
 * Reads message type from ChatUI Store DTOs.
 *
 * @param {Element} mesEl - A .mes DOM element
 * @returns {{ isUser: boolean, isSystem: boolean, isChar: boolean, mesId: number, name: string, avatarSrc: string }|null}
 */
function _classify(mesEl) {
    const dto = getMessageDtoByElement(mesEl);
    if (!dto) return null;

    const avatarImg = mesEl.querySelector('.mesAvatarWrapper .avatar img');
    const avatarSrc = dto?.forceAvatarSrc || (avatarImg ? (avatarImg.getAttribute('src') ?? '') : '');
    return {
        isUser: dto.isUser,
        isSystem: dto.isSystem,
        isChar: dto.isChar,
        mesId: dto.id,
        name: dto.name,
        avatarSrc,
    };
}

/**
 * Reads the timestamp text from the .mes element's .timestamp element.
 *
 * @param {Element} mesEl
 * @returns {string}
 */
function _getTimestamp(mesEl) {
    const tsEl = mesEl.querySelector('.mes_block .ch_name .timestamp');
    return tsEl ? (tsEl.textContent ?? '').trim() : '';
}

/**
 * Builds and returns a cui-identity header element.
 * Level 'icon': avatar img + name + time
 * Level 'name': name + time (no avatar)
 * Level 'none': returns null (caller should not inject)
 *
 * @param {'icon'|'name'|'none'} level
 * @param {string} name
 * @param {string} avatarSrc
 * @param {string} timestamp
 * @returns {HTMLElement|null}
 */
function _buildIdentityHeader(level, name, avatarSrc, timestamp) {
    if (level === 'none') return null;

    const identity = document.createElement('div');
    identity.className = 'cui-identity';

    if (level === 'icon' && avatarSrc) {
        const img = document.createElement('img');
        img.className = 'cui-identity-avatar';
        img.src = avatarSrc;
        img.alt = name;
        identity.appendChild(img);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'cui-identity-name';
    nameSpan.textContent = name;
    identity.appendChild(nameSpan);

    if (timestamp) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'cui-identity-time';
        timeSpan.textContent = timestamp;
        identity.appendChild(timeSpan);
    }

    return identity;
}

/**
 * Removes all Phase 2 layout decorations from a single .mes element.
 * Clears the data-cui-p2 sentinel and removes .cui-msg children.
 *
 * @param {Element} mesEl
 * @returns {void}
 */
function unprocessLayoutMessage(mesEl) {
    mesEl.removeAttribute('data-cui-p2');
    mesEl.querySelectorAll('.cui-msg').forEach(n => n.remove());
}

/**
 * Idempotent per-message layout processor.
 * Inserts cui-msg wrapper (and optionally cui-identity header) as first child
 * of .mes_block. Guards with data-cui-p2; re-processes on swipe/edit by caller
 * first removing the sentinel via unprocessLayoutMessage().
 *
 * @param {Element} mesEl - A .mes DOM element
 * @returns {void}
 */
function processLayoutMessage(mesEl) {
    if (!_isActive()) return;

    // Skip small system notes and tool-call messages entirely (CONTRACT-P2 §5-A)
    const dto = getMessageDtoByElement(mesEl);
    if (!dto || dto.extra.isSmallSys || dto.extra.isToolCall) return;

    // Idempotency guard
    if (mesEl.hasAttribute('data-cui-p2')) return;

    const classified = _classify(mesEl);
    if (!classified) return;
    const { isUser, isSystem, isChar, name, avatarSrc } = classified;

    // Determine cui-msg type modifier
    let typeClass;
    if (isUser) {
        typeClass = 'cui-msg-user';
    } else if (isSystem) {
        typeClass = 'cui-msg-system';
    } else {
        typeClass = 'cui-msg-char';
    }

    // Build the wrapper div
    const cuiMsg = document.createElement('div');
    cuiMsg.className = `cui-msg ${typeClass}`;

    // Inject identity header only for char messages, based on settings
    if (isChar && _settingsP2) {
        // Determine group vs single at use-time (CONTRACT-P2 §5-A)
        const isGroup = getChatuiState().chat.isGroup || chatuiAdapter.getIsGroupChat();
        const level = isGroup
            ? (_settingsP2.identityHeaderGroup  ?? 'icon')
            : (_settingsP2.identityHeaderSingle ?? 'none');

        const timestamp = _getTimestamp(mesEl);
        const identityEl = _buildIdentityHeader(level, name, avatarSrc, timestamp);
        if (identityEl) {
            cuiMsg.appendChild(identityEl);
        }
    }

    // Insert as first child of .mes_block (before .ch_name, .mes_text, etc.)
    const mesBlock = mesEl.querySelector('.mes_block');
    if (mesBlock) {
        mesBlock.insertBefore(cuiMsg, mesBlock.firstChild);
    }

    // Mark as processed
    mesEl.setAttribute('data-cui-p2', '1');
}

/**
 * Re-processes a single .mes by mesid, stripping stale decorations first.
 * Used for swipe and edit events where the node is mutated in place.
 *
 * @param {number|string} mesId
 * @returns {void}
 */
function _reprocessById(mesId) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!mesEl) return;
    unprocessLayoutMessage(mesEl);
    processLayoutMessage(mesEl);
}

/**
 * Sweeps all currently rendered .mes[mesid] nodes in #chat.
 * Skips already-processed messages (idempotent).
 * Called on init, CHAT_CHANGED (deferred), and MORE_MESSAGES_LOADED.
 *
 * @returns {void}
 */
function sweepLayoutMessages() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(processLayoutMessage);
}

// ── Exported module interface ─────────────────────────────────────────────────

/**
 * Init Phase 2 identity header and per-message structural wrapper.
 * Sweeps existing #chat .mes on call, then hooks future render events.
 *
 * @param {{ settings: object, settingsP2: object }} ctx
 * @returns {void}
 */
export function initMessageLayout(ctx) {
    if (_isSetup) return;

    // Store live settings reference (read at use-time for group detection)
    _settingsP2 = ctx.settingsP2 ?? null;

    // 1. Sweep messages already rendered in the DOM
    sweepLayoutMessages();

    // 2. New char message appended
    _on(stEventKeys.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
        if (mesEl) processLayoutMessage(mesEl);
    });

    // 3. New user message appended
    _on(stEventKeys.USER_MESSAGE_RENDERED, (mesId) => {
        const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
        if (mesEl) processLayoutMessage(mesEl);
    });

    // 4. Swipe: .mes node mutated in-place; strip and re-inject layout decorations
    //    (.mes_text / .ch_name / .timestamp are overwritten by updateMessageElement)
    _on(stEventKeys.MESSAGE_SWIPED, (mesId) => {
        _reprocessById(mesId);
    });

    // 5. Edit done: .mes_text was re-rendered; re-apply layout decorations
    //    Use MESSAGE_UPDATED (fires after full re-render) not MESSAGE_EDITED (fires before)
    _on(stEventKeys.MESSAGE_UPDATED, (mesId) => {
        _reprocessById(mesId);
    });

    // 6. Chat changed: all .mes nodes replaced → full re-sweep after DOM rebuild
    //    MUST defer with setTimeout(0) — CHAT_CHANGED fires before printMessages finishes
    _on(stEventKeys.CHAT_CHANGED, () => {
        setTimeout(() => sweepLayoutMessages(), 0);
    });

    // 7. More messages loaded: new .mes nodes prepended → sweep unprocessed ones
    //    processLayoutMessage is idempotent; already-processed nodes are skipped
    _on(stEventKeys.MORE_MESSAGES_LOADED, () => {
        sweepLayoutMessages();
    });

    _isSetup = true;
}

/**
 * Remove all identity headers and structural wrappers; unbind all listeners.
 * Calling this without a prior initMessageLayout() is a no-op.
 *
 * @returns {void}
 */
export function teardownMessageLayout() {
    if (!_isSetup) return;

    // 1. Unbind all accumulated event listeners
    for (const unsubscribe of _listeners) {
        unsubscribe();
    }
    _listeners = [];

    // 2. Remove all Phase 2 layout decorations from every .mes in #chat
    document.querySelectorAll('#chat .mes[data-cui-p2]').forEach(unprocessLayoutMessage);

    // 3. Clear module state
    _settingsP2 = null;
    _isSetup = false;
}
