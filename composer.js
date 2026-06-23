/**
 * composer.js — DOM wrap of #send_form for SillyTavern-ChatUI.
 *
 * Responsibilities:
 *  - Wrap #send_form elements in #chatui-composer
 *  - Expose .cui-plus-slot and .cui-selectorB-slot mount points
 *  - Move (never clone) #leftSendForm, #send_textarea, #rightSendForm
 *  - Apply multiline / singleline mode class
 *  - Teardown restores original DOM order inside #nonQRFormItems
 *
 * Contract: CONTRACT.md §4 (module interface), §5.1 (DOM structure), §6.1 (behaviour), §7 (rules).
 */

/** @type {boolean} */
let _isSetup = false;

/**
 * Creates the #chatui-composer wrapper, moves the three send-form children into it,
 * and inserts the new slots. Leaves #nonQRFormItems empty in the DOM as a teardown sentinel.
 *
 * @param {{ settings: object, settingsP2?: object }} ctx - live ctx from index.js
 * @returns {void}
 */
export function initComposer(ctx) {
    if (_isSetup) return; // idempotent guard

    const nonQR = document.getElementById('nonQRFormItems');
    const leftForm = document.getElementById('leftSendForm');
    const textarea = document.getElementById('send_textarea');
    const rightForm = document.getElementById('rightSendForm');

    if (!nonQR || !leftForm || !textarea || !rightForm) {
        console.warn('[ChatUI] initComposer: required DOM elements not found, aborting.');
        return;
    }

    // ── 1. Build wrapper ──────────────────────────────────────────────────────
    const composer = document.createElement('div');
    composer.id = 'chatui-composer';

    // ── 2. Build slot elements ────────────────────────────────────────────────
    const plusSlot = document.createElement('div');
    plusSlot.className = 'cui-plus-slot';

    const selectorSlot = document.createElement('div');
    selectorSlot.className = 'cui-selectorB-slot';

    // ── 3. Assemble composer children in contract order ───────────────────────
    // CONTRACT §5.1:
    //   .cui-plus-slot | #leftSendForm | #send_textarea | .cui-selectorB-slot | #rightSendForm
    //
    // Multiline CSS will use flex-direction:column and reorder via CSS grid/order.
    // Singleline CSS will show everything in a single row.
    //
    // We append in the logical DOM order; CSS handles visual arrangement.
    composer.appendChild(plusSlot);     // .cui-plus-slot (filled by plus-menu.js)
    composer.appendChild(leftForm);     // MOVED — contains #options_button
    composer.appendChild(textarea);     // MOVED — #send_textarea, jQuery bindings intact
    composer.appendChild(selectorSlot); // .cui-selectorB-slot (filled by selector.js)
    composer.appendChild(rightForm);    // MOVED — contains #send_but, #mes_stop, etc.

    // ── 4. Insert composer before #nonQRFormItems in #send_form ──────────────
    // #nonQRFormItems stays empty in the DOM as a sentinel for teardown.
    nonQR.parentNode.insertBefore(composer, nonQR);

    // ── 5. Apply initial mode class ───────────────────────────────────────────
    const mode = ctx.settings?.composerMode ?? 'multiline';
    _applyModeClass(composer, mode);

    _isSetup = true;
}

/**
 * Restores all moved elements to their original parent (#nonQRFormItems) in the
 * original DOM order, then removes #chatui-composer from the DOM.
 * Safe to call even if initComposer() was never called (no-op).
 *
 * @returns {void}
 */
export function teardownComposer() {
    if (!_isSetup) return; // idempotent guard

    const composer = document.getElementById('chatui-composer');
    const nonQR = document.getElementById('nonQRFormItems');

    if (!composer || !nonQR) {
        // Defensive: reset state even if elements are unexpectedly missing.
        _isSetup = false;
        return;
    }

    // Restore original order in #nonQRFormItems: leftSendForm → send_textarea → rightSendForm
    // CONTRACT §6.1 teardown + §7 reversibility checklist.
    const leftForm = document.getElementById('leftSendForm');
    const textarea = document.getElementById('send_textarea');
    const rightForm = document.getElementById('rightSendForm');

    if (leftForm) {
        nonQR.appendChild(leftForm);
    } else {
        console.warn('[ChatUI] teardownComposer: #leftSendForm missing');
    }
    if (textarea) {
        nonQR.appendChild(textarea);
    } else {
        console.warn('[ChatUI] teardownComposer: #send_textarea missing');
    }
    if (rightForm) {
        nonQR.appendChild(rightForm);
    } else {
        console.warn('[ChatUI] teardownComposer: #rightSendForm missing');
    }

    // Remove composer wrapper (.cui-plus-slot and .cui-selectorB-slot are children → removed with it).
    composer.remove();

    _isSetup = false;
}

/**
 * Switches between 'multiline' and 'singleline' composer mode without a full
 * teardown/reinit cycle. Updates the mode class on #chatui-composer and adds
 * `cui-slot-hidden` to .cui-selectorB-slot in singleline mode.
 *
 * CONTRACT §6.1 singleline/multiline spec.
 *
 * @param {'multiline'|'singleline'} mode
 * @returns {void}
 */
export function setComposerMode(mode) {
    const composer = document.getElementById('chatui-composer');
    if (!composer) return;

    _applyModeClass(composer, mode);

    // In singleline mode, hide the selector B slot (selector B moves into + menu top).
    const selectorSlot = composer.querySelector('.cui-selectorB-slot');
    if (selectorSlot) {
        if (mode === 'singleline') {
            selectorSlot.classList.add('cui-slot-hidden');
        } else {
            selectorSlot.classList.remove('cui-slot-hidden');
        }
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Applies the correct mode class to the composer element, removing the other.
 *
 * @param {HTMLElement} composer - #chatui-composer element
 * @param {'multiline'|'singleline'} mode
 * @returns {void}
 */
function _applyModeClass(composer, mode) {
    if (mode === 'singleline') {
        composer.classList.add('cui-mode-singleline');
        composer.classList.remove('cui-mode-multiline');
    } else {
        composer.classList.add('cui-mode-multiline');
        composer.classList.remove('cui-mode-singleline');
    }
}
