/**
 * qr.js — QR bar float module for SillyTavern-ChatUI
 *
 * Relocates #qr--bar above #send_form inside #form_sheld, and re-relocates it
 * after QR's own rebuild-on-CHAT_CHANGED (which destroys and re-inserts the bar).
 *
 * Exports: initQr(ctx), teardownQr()
 */

/** @type {MutationObserver|null} */
let _qrObserver = null;

/**
 * Move #qr--bar to sit immediately before #send_form inside #form_sheld.
 * Adds the cui-qr-float class for styling.
 * No-ops gracefully when QR is absent or in popout mode.
 */
function relocateQrBar() {
    const bar = document.getElementById('qr--bar');
    const sendForm = document.getElementById('send_form');

    if (!bar || !sendForm) return;

    // Guard: QR popout mode puts #qr--bar on document.body, not inside #send_form.
    // In that case bar.parentElement is body, not #form_sheld or #send_form.
    // We only relocate when the bar is either currently inside #send_form OR has
    // already been moved to sit next to #send_form (i.e. its parent is #form_sheld).
    const formSheld = sendForm.parentElement;
    if (!formSheld) return;

    const barParent = bar.parentElement;
    // Allow relocation only if the bar is inside #send_form or already in #form_sheld.
    if (barParent !== sendForm && barParent !== formSheld) return;

    // Move bar to immediately before #send_form (inside #form_sheld).
    sendForm.insertAdjacentElement('beforebegin', bar);
    bar.classList.add('cui-qr-float');
}

/**
 * Initialise QR float: relocate immediately (QR loads before APP_READY) then
 * install a MutationObserver on #send_form so we re-relocate whenever QR
 * rebuilds the bar (on CHAT_CHANGED and on QR settings save).
 *
 * @param {object} _ctx - ChatUI context object (unused by this module)
 */
export function initQr(_ctx) {
    // Disconnect any previous observer to keep initQr idempotent.
    if (_qrObserver) {
        _qrObserver.disconnect();
        _qrObserver = null;
    }

    // Relocate immediately in case QR already inserted the bar.
    relocateQrBar();

    const sendForm = document.getElementById('send_form');
    if (!sendForm) return;

    // Watch #send_form for child insertions — QR re-inserts #qr--bar there after every refresh().
    _qrObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE && /** @type {Element} */ (node).id === 'qr--bar') {
                    relocateQrBar();
                    return;
                }
            }
        }
    });

    _qrObserver.observe(sendForm, { childList: true });
}

/**
 * Tear down QR float: disconnect the MutationObserver, remove the cui-qr-float
 * class, and restore #qr--bar as the first child of #send_form (its original
 * position per QR's own ButtonUi.show()).
 */
export function teardownQr() {
    if (_qrObserver) {
        _qrObserver.disconnect();
        _qrObserver = null;
    }

    const bar = document.getElementById('qr--bar');
    const sendForm = document.getElementById('send_form');

    if (bar) {
        bar.classList.remove('cui-qr-float');
    }

    if (bar && sendForm) {
        // QR's ButtonUi.show() inserts with sendForm.children[0].insertAdjacentElement('beforebegin', bar),
        // making the bar the first DOM child of #send_form.  Restore that original position.
        if (sendForm.firstElementChild) {
            sendForm.firstElementChild.insertAdjacentElement('beforebegin', bar);
        } else {
            sendForm.appendChild(bar);
        }
    }
}
