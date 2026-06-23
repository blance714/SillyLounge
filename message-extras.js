/**
 * SillyTavern-ChatUI · message-extras.js
 *
 * Implements Phase 2 sections E and F:
 *   E. Reasoning restyle — CSS-only skin of .mes_reasoning_details into a ChatGPT
 *      "Thinking" collapsible. JS sets data-duration-label for exact "Thought for Xs"
 *      via CSS attr(). Never touches details.open or ST's toggle handler.
 *   F. Code block header — injects a <div class="cui-code-header"> sibling before each
 *      <pre>, moves ST's i.code-copy into it (preserving event listeners), restores on teardown.
 *
 * Contract: CONTRACT-P2.md §4 (exports), §5-E, §5-F, §6 (idempotency + events + teardown).
 *
 * Exports: initMessageExtras(ctx), teardownMessageExtras()
 */

import { chatuiAdapter, stEventKeys } from './adapter/st-adapter.js';

// ── Module-level state ────────────────────────────────────────────────────────

/** @type {Array<() => void>} Accumulated event unsubscribers for teardown. */
let _listeners = [];

/** @type {boolean} Guard against double-init. */
let _isSetup = false;

/** @type {object} settingsP2 snapshot set at init time. */
let _settingsP2 = {};

/**
 * WeakSet of span elements that had their title attribute set by this module.
 * Used to avoid blindly stripping ST's own title attributes on teardown.
 * @type {WeakSet<Element>}
 */
const _titledSpans = new WeakSet();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Registers an ST event listener through the adapter and records it for teardown.
 *
 * @param {string} type - stEventKeys value
 * @param {Function} fn - handler
 * @returns {void}
 */
function _on(type, fn) {
    _listeners.push(chatuiAdapter.subscribe(type, fn));
}

// ── Section E: Reasoning restyle ─────────────────────────────────────────────

/**
 * Applies reasoning label to a single .mes_reasoning_details element.
 *
 * CSS `attr()` reads from the *generating element* of `::after` — which is the
 * `<span class="mes_reasoning_header_title">`, NOT the `<details>` ancestor.
 * So we set `data-duration-label` on the span, not on the details element.
 *
 * Title is also set on the span for tooltip consistency. Both attributes are
 * tracked in `_titledSpans` so teardown only removes what this module wrote.
 *
 * @param {Element} detailsEl - .mes_reasoning_details element
 * @returns {void}
 */
function _applyLabelToDetails(detailsEl) {
    const raw = /** @type {HTMLElement} */ (detailsEl).dataset.duration;
    if (!raw || raw === 'unknown') return;

    const sec = parseFloat(raw);
    if (isNaN(sec)) return;

    const label = sec < 60
        ? `Thought for ${Math.round(sec)}s`
        : `Thought for ${Math.round(sec / 60)}m`;

    // Set on the span so CSS attr() on ::after can read it
    const titleEl = detailsEl.querySelector('.mes_reasoning_header_title');
    if (titleEl) {
        titleEl.setAttribute('data-duration-label', label);
        /** @type {HTMLElement} */ (titleEl).title = `${sec} seconds`;
        _titledSpans.add(titleEl);
    }
}

/**
 * Sets data-duration-label on every .mes_reasoning_details[data-duration] in #chat.
 * Delegates to _applyReasoningLabelsToMessage to avoid code duplication.
 * Safe to call repeatedly (idempotent per element state).
 *
 * @returns {void}
 */
function _applyReasoningLabels() {
    if (!document.body.classList.contains('chatui-active')) return;
    document.querySelectorAll('#chat .mes').forEach(mesEl => _applyReasoningLabelsToMessage(mesEl));
}

/**
 * Applies reasoning labels to a single message element.
 *
 * @param {Element} mesEl - .mes element
 * @returns {void}
 */
function _applyReasoningLabelsToMessage(mesEl) {
    if (!document.body.classList.contains('chatui-active')) return;
    mesEl.querySelectorAll('.mes_reasoning_details[data-duration]').forEach(_applyLabelToDetails);
}

// ── Section F: Code block header ──────────────────────────────────────────────

/**
 * Injects a .cui-code-header bar above each <pre> in a message element.
 * Moves ST's existing i.code-copy (inside <code>) into the header, preserving
 * its event listeners. Idempotent: guarded by data-cui-code-header on <pre>.
 *
 * @param {Element} mesEl - .mes element to process
 * @returns {void}
 */
function _injectCodeHeaders(mesEl) {
    if (!document.body.classList.contains('chatui-active')) return;

    mesEl.querySelectorAll('.mes_text pre code').forEach(codeEl => {
        const preEl = codeEl.parentElement;
        if (!preEl || preEl.tagName !== 'PRE') return;

        // Idempotency guard — skip if already processed
        if (preEl.hasAttribute('data-cui-code-header')) return;
        preEl.setAttribute('data-cui-code-header', '1');

        // Extract language from hljs class, e.g. "hljs language-python"
        let lang = '';
        for (const cls of codeEl.classList) {
            const m = cls.match(/^language-(.+)$/);
            if (m) {
                lang = m[1];
                break;
            }
        }

        // Grab ST's existing copy button appended inside <code> by addCopyToCodeBlocks
        const existingCopy = codeEl.querySelector('i.code-copy');

        // Build the header bar
        const header = document.createElement('div');
        header.className = 'cui-code-header';
        header.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.className = 'cui-code-lang';
        label.textContent = lang || 'code';
        header.appendChild(label);

        if (existingCopy) {
            // Move ST's copy button into our header; event listeners are preserved
            header.appendChild(existingCopy);
        }

        // Insert header immediately before <pre> in the DOM
        if (preEl.parentNode) {
            preEl.parentNode.insertBefore(header, preEl);
        }
    });
}

/**
 * Removes the code header guard from a message's <pre> elements so they can be
 * re-processed after ST re-renders the .mes_text (swipe / edit).
 *
 * @param {Element} mesEl - .mes element
 * @returns {void}
 */
function _resetCodeHeaders(mesEl) {
    mesEl.querySelectorAll('pre[data-cui-code-header]').forEach(preEl => {
        preEl.removeAttribute('data-cui-code-header');
    });
}

/**
 * Sweeps all currently rendered .mes nodes for code header injection and
 * reasoning label application. Call on init and on CHAT_LOADED / MORE_MESSAGES_LOADED.
 * Code headers are only injected when settingsP2.codeHeader !== false.
 *
 * @returns {void}
 */
function _sweepAll() {
    if (!document.body.classList.contains('chatui-active')) return;
    const codeHeaderEnabled = _settingsP2.codeHeader !== false;
    document.querySelectorAll('#chat .mes').forEach(mesEl => {
        if (codeHeaderEnabled) _injectCodeHeaders(mesEl);
        _applyReasoningLabelsToMessage(mesEl);
    });
}

/**
 * Processes a single message by mesid — applies code headers (if enabled) and
 * reasoning labels. Looks up the DOM element from the mesid number provided by
 * ST events.
 *
 * @param {number} mesId - numeric message id from event payload
 * @returns {void}
 */
function _processMessageById(mesId) {
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!el) return;
    if (_settingsP2.codeHeader !== false) _injectCodeHeaders(el);
    _applyReasoningLabelsToMessage(el);
}

/**
 * Re-processes a single message after ST re-renders its content (swipe / edit).
 * Resets code header guards first so fresh <pre> elements are picked up.
 * Code headers are only re-injected when settingsP2.codeHeader !== false.
 *
 * @param {number} mesId - numeric message id from event payload
 * @returns {void}
 */
function _reprocessMessageById(mesId) {
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!el) return;
    _resetCodeHeaders(el);
    if (_settingsP2.codeHeader !== false) _injectCodeHeaders(el);
    _applyReasoningLabelsToMessage(el);
}

// ── Teardown helper ───────────────────────────────────────────────────────────

/**
 * Reverses all code header injections: moves i.code-copy back inside its <code>
 * element, removes the data-cui-code-header guard, and removes the .cui-code-header
 * bar from the DOM.
 *
 * @returns {void}
 */
function _teardownCodeHeaders() {
    document.querySelectorAll('.cui-code-header').forEach(header => {
        const preEl = /** @type {Element|null} */ (header.nextElementSibling);
        const copyBtn = header.querySelector('i.code-copy');

        if (copyBtn && preEl && preEl.tagName === 'PRE') {
            const codeEl = preEl.querySelector('code');
            if (codeEl) {
                // Return ST's copy button to its original position inside <code>
                codeEl.appendChild(copyBtn);
            }
            // Clear the guard so ST can re-process if needed
            preEl.removeAttribute('data-cui-code-header');
        }

        header.remove();
    });
}

/**
 * Cleans up all reasoning label attributes injected by this module.
 * Only removes `data-duration-label` and `title` from spans that this module
 * actually modified (tracked via `_titledSpans` WeakSet), avoiding accidental
 * removal of ST's own tooltip titles on other elements.
 *
 * @returns {void}
 */
function _teardownReasoningLabels() {
    // Remove data-duration-label from spans (where we now set it)
    document.querySelectorAll('[data-duration-label]').forEach(el => {
        el.removeAttribute('data-duration-label');
    });
    // Only clear title attributes on spans this module set; don't touch ST's own titles
    document.querySelectorAll('#chat .mes_reasoning_header_title[title]').forEach(el => {
        if (_titledSpans.has(el)) {
            el.removeAttribute('title');
        }
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialises message-extras: sweeps existing messages, registers event listeners
 * for E (reasoning restyle) and F (code headers).
 *
 * CONTRACT-P2.md §4 — exact exported name, signature.
 *
 * @param {{ settings: object, settingsP2: object }} ctx
 * @returns {void}
 */
export function initMessageExtras(ctx) {
    if (_isSetup) return;

    // Store settingsP2 for use by sweep/process helpers
    _settingsP2 = ctx?.settingsP2 ?? {};

    // Initial sweep of messages already in the DOM
    _sweepAll();

    // ── Per-message events: E + F combined in a single handler per event type ──
    // This avoids registering the same event type twice and keeps teardown clean.

    // New character message rendered
    _on(stEventKeys.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        _processMessageById(mesId);
    });

    // New user message rendered
    _on(stEventKeys.USER_MESSAGE_RENDERED, (mesId) => {
        _processMessageById(mesId);
    });

    // Swipe: .mes node mutated in-place; ST re-renders .mes_text + reasoning block.
    // Reset code header guards then re-inject; re-apply reasoning labels.
    _on(stEventKeys.MESSAGE_SWIPED, (mesId) => {
        _reprocessMessageById(mesId);
    });

    // Edit done: .mes_text re-rendered; reset code header guards and re-inject;
    // also re-apply reasoning labels.
    _on(stEventKeys.MESSAGE_UPDATED, (mesId) => {
        _reprocessMessageById(mesId);
    });

    // Streaming reasoning finished: data-duration now written by ST; apply label.
    _on(stEventKeys.STREAM_REASONING_DONE, () => {
        _applyReasoningLabels();
    });

    // Chat changed: all .mes nodes destroyed and recreated; full re-sweep.
    // setTimeout(0) lets ST finish rebuilding the DOM before we sweep.
    _on(stEventKeys.CHAT_CHANGED, () => {
        setTimeout(() => _sweepAll(), 0);
    });

    // More messages loaded: new nodes prepended; sweep unprocessed ones.
    _on(stEventKeys.MORE_MESSAGES_LOADED, () => {
        _sweepAll();
    });

    // CHAT_LOADED: full chat rendered after initial load or chat switch.
    _on(stEventKeys.CHAT_LOADED, () => {
        _sweepAll();
    });

    _isSetup = true;
}

/**
 * Tears down message-extras: removes all listeners, removes all injected
 * .cui-code-header nodes (restoring i.code-copy inside <code>), and removes
 * all data-duration-label / title attributes set by this module.
 * Safe to call if initMessageExtras() was never called (no-op).
 *
 * CONTRACT-P2.md §4, §6 — fully reversible.
 *
 * @returns {void}
 */
export function teardownMessageExtras() {
    if (!_isSetup) return;

    // Remove all registered event listeners
    for (const unsubscribe of _listeners) {
        unsubscribe();
    }
    _listeners = [];

    // Restore code blocks to original ST state
    _teardownCodeHeaders();

    // Remove reasoning label attributes
    _teardownReasoningLabels();

    _isSetup = false;
}
