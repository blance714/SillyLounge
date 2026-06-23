/**
 * SillyTavern-ChatUI · chat-chrome.js
 *
 * Floating chrome elements for the chat area:
 *   G-scroll  — scroll-to-bottom button (visible when root chat is not at bottom)
 *   G-regen   — bottom Generate/Regenerate button (visible when last message is
 *               NOT a bot/character message and generation is not in progress)
 *
 * Mount point: #cui-float-chrome appended to #sheld.
 * CSS positions the floating chrome relative to the viewport.
 *
 * CONTRACT-P2.md §4 — exports: initChatChrome(ctx) / teardownChatChrome()
 * CONTRACT-P2.md §5-G — behaviour spec
 * CONTRACT.md       — Phase 1 rules (cui- prefix, chatui-active gate, idempotency)
 */

import { chatuiAdapter, stEventKeys } from './adapter/st-adapter.js';
import { getChatuiState } from './store/chat-store.js';

// ── Module-level state (all prefixed _) ──────────────────────────────────────

/** @type {Array<() => void>} Accumulated unsubscribers for teardown. */
let _listeners = [];

/** @type {((e: Event) => void)|null} Named scroll handler for removeEventListener. */
let _scrollHandler = null;

/** @type {boolean} Guards against double-init. */
let _isSetup = false;

/** @type {object} settingsP2 snapshot set at init time. */
let _settingsP2 = {};

// ── Listener helpers ──────────────────────────────────────────────────────────

/**
 * Registers an ST event listener and stores it for batch removal on teardown.
 *
 * @param {string} type - stEventKeys value
 * @param {function} fn - handler
 * @returns {void}
 */
function _on(type, fn) {
    _listeners.push(chatuiAdapter.subscribe(type, fn));
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/**
 * @returns {HTMLElement|null}
 */
function _getScrollTarget() {
    return document.getElementById('chatui-root') || document.getElementById('chat');
}

/**
 * Returns true when the active message surface is scrolled to (or within 5 px
 * of) the bottom.
 * Mirrors ST's own chatScrollHandler threshold (script.js:11173).
 *
 * @returns {boolean}
 */
function _isAtBottom() {
    const target = _getScrollTarget();
    if (!target) return true;
    return Math.abs(target.scrollHeight - target.clientHeight - target.scrollTop) < 5;
}

/**
 * @returns {void}
 */
function _scrollToBottom() {
    const target = _getScrollTarget();
    if (!target) return;
    target.scrollTop = target.scrollHeight;
}

/**
 * Returns true when the Store says the last message needs a
 * Generate/Regenerate affordance.
 *
 * @returns {boolean}
 */
function _lastMessageNeedsGenerate() {
    return getChatuiState().chat.lastMessageNeedsGenerate;
}

// ── Chrome injection ──────────────────────────────────────────────────────────

/**
 * Injects #cui-float-chrome into #sheld (if not already present).
 * Idempotent — returns early if the element already exists.
 * Buttons are only injected when the corresponding settingsP2 flags are true.
 *
 * @returns {void}
 */
function _injectChrome() {
    if (document.getElementById('cui-float-chrome')) return;

    const sheld = document.getElementById('sheld');
    if (!sheld) {
        console.warn('[ChatUI/chrome] #sheld not found — cannot mount floating chrome');
        return;
    }

    const scrollToBottomEnabled = _settingsP2.scrollToBottom !== false;
    const bottomRegenEnabled    = _settingsP2.bottomRegen    !== false;

    // Skip injection entirely if both buttons are disabled
    if (!scrollToBottomEnabled && !bottomRegenEnabled) return;

    const chrome = document.createElement('div');
    chrome.id = 'cui-float-chrome';

    if (scrollToBottomEnabled) {
        const scrollBtn = document.createElement('button');
        scrollBtn.id = 'cui-scroll-btn';
        scrollBtn.className = 'cui-float-btn cui-scroll-btn cui-float-hidden';
        scrollBtn.setAttribute('title', 'Scroll to bottom');
        scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
        scrollBtn.innerHTML = '<i class="fa-solid fa-angles-down"></i>';
        scrollBtn.addEventListener('click', () => {
            _scrollToBottom();
        });
        chrome.appendChild(scrollBtn);
    }

    if (bottomRegenEnabled) {
        const regenBtn = document.createElement('button');
        regenBtn.id = 'cui-regen-btn';
        regenBtn.className = 'cui-float-btn cui-regen-btn cui-float-hidden';
        regenBtn.setAttribute('title', 'Generate / Regenerate');
        regenBtn.setAttribute('aria-label', 'Generate / Regenerate');
        regenBtn.innerHTML = '<i class="fa-solid fa-repeat"></i>';
        regenBtn.addEventListener('click', () => {
            chatuiAdapter.messageActions.regenerateLast();
        });
        chrome.appendChild(regenBtn);
    }

    sheld.appendChild(chrome);
}

// ── Visibility update ─────────────────────────────────────────────────────────

/**
 * Re-evaluates and updates the visibility of both floating buttons.
 * Safe to call at any time; no-ops if chrome is not mounted or buttons disabled.
 *
 * @returns {void}
 */
function _updateVisibility() {
    if (!document.body.classList.contains('chatui-active')) return;

    // Scroll button: hidden when already at bottom (only if enabled in settings)
    if (_settingsP2.scrollToBottom !== false) {
        const scrollBtn = document.getElementById('cui-scroll-btn');
        if (scrollBtn) {
            scrollBtn.classList.toggle('cui-float-hidden', _isAtBottom());
        }
    }

    // Regen button: visible only when last message is not a bot reply AND not generating
    if (_settingsP2.bottomRegen !== false) {
        const regenBtn = document.getElementById('cui-regen-btn');
        if (regenBtn) {
            const showRegen = _lastMessageNeedsGenerate()
                && !chatuiAdapter.getGenerationState().isGenerating;
            regenBtn.classList.toggle('cui-float-hidden', !showRegen);
        }
    }
}

// ── Scroll listener management ────────────────────────────────────────────────

/**
 * Binds a passive scroll listener on the active message surface to update button visibility.
 * Stores the handler in _scrollHandler for cleanup.
 *
 * @returns {void}
 */
function _bindScrollListener() {
    const target = _getScrollTarget();
    if (!target) return;

    _scrollHandler = () => _updateVisibility();
    target.addEventListener('scroll', _scrollHandler, { passive: true });
}

/**
 * Removes the scroll listener previously bound by _bindScrollListener.
 *
 * @returns {void}
 */
function _unbindScrollListener() {
    const target = _getScrollTarget();
    if (target && _scrollHandler) {
        target.removeEventListener('scroll', _scrollHandler);
    }
    _scrollHandler = null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialises the floating chrome: injects #cui-float-chrome into #sheld,
 * binds the message-surface scroll listener, and hooks the relevant ST events to keep
 * button visibility in sync.
 *
 * Idempotent — safe to call multiple times; only the first call has effect.
 *
 * CONTRACT-P2.md §4, §5-G, §6 (event set for chrome column).
 *
 * @param {{ settings: object, settingsP2: object }} _ctx
 * @returns {void}
 */
export function initChatChrome(ctx) {
    if (_isSetup) return;

    // Store settingsP2 for use by _injectChrome and _updateVisibility
    _settingsP2 = ctx?.settingsP2 ?? {};

    // Inject the floating container into #sheld
    _injectChrome();

    // Bind passive scroll listener on root surface
    _bindScrollListener();

    // Initial visibility pass
    _updateVisibility();

    // ── Event hooks (CONTRACT-P2 §6, chrome column) ───────────────────────────

    // New character message rendered → re-evaluate regen button
    _on(stEventKeys.CHARACTER_MESSAGE_RENDERED, () => _updateVisibility());

    // Swipe completed → last message may have changed bot/user status
    _on(stEventKeys.MESSAGE_SWIPED, () => _updateVisibility());

    // Chat switched → all messages replaced; re-evaluate both buttons
    // setTimeout(0) lets ST finish re-rendering before we query the DOM
    _on(stEventKeys.CHAT_CHANGED, () => setTimeout(() => _updateVisibility(), 0));

    // More messages loaded (lazy load) → scroll position / last message may change
    _on(stEventKeys.MORE_MESSAGES_LOADED, () => _updateVisibility());

    // Generation ended → regen button should disappear while generating, reappear after
    _on(stEventKeys.GENERATION_ENDED, () => _updateVisibility());

    // User sent a message → last message is now user → show regen button
    _on(stEventKeys.MESSAGE_SENT, () => _updateVisibility());

    _isSetup = true;
}

/**
 * Tears down the floating chrome: removes #cui-float-chrome from the DOM,
 * unbinds the scroll listener, and removes all ST listeners registered
 * by this module.
 *
 * Idempotent — safe to call even if initChatChrome() was never called.
 *
 * CONTRACT-P2.md §4, §6 (teardown completeness).
 *
 * @returns {void}
 */
export function teardownChatChrome() {
    if (!_isSetup) return;

    // Remove all ST listeners registered during init
    for (const unsubscribe of _listeners) {
        unsubscribe();
    }
    _listeners = [];

    // Remove passive scroll listener from root surface
    _unbindScrollListener();

    // Remove the floating chrome element from the DOM
    document.getElementById('cui-float-chrome')?.remove();

    _settingsP2 = {};
    _isSetup = false;
}
